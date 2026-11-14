import { parseOutdated, restartsDocker, upgradeArgs, upgradeOrder, type OutdatedPackage } from '../core/brew.ts';
import { bumpImage } from '../core/compose.ts';
import { parseInspect, type ContainerInfo } from '../core/docker.ts';
import { parseChocoOutdated, type ChocoPackage } from '../core/choco.ts';
import { diagnoseBrew, diagnoseChoco, diagnoseScoop, diagnoseWinget, type Diagnosis } from '../core/failures.ts';
import { decide, MINOR_WITHOUT_NOTES, OPTIONAL_MINOR, type Decision } from '../core/policy.ts';
import { isPrerelease, latestTag } from '../core/version.ts';
import { parseWingetUpgrade, type WingetPackage } from '../core/winget.ts';
import { isSkipped, parseScoopStatus, repairPlan, scoopCommand, WINGET_FLAGS, wingetTarget, type Package } from '../core/packages.ts';
import { installWithRepair as repairLadder, lastLines, runSequence } from './repair.ts';
import type { PortainerClient, PortainerStack } from './portainer.ts';
import type { AdvisoryLookup, ReleaseNotesLookup } from './releases.ts';
import type { Exec, ExecResult, ItemSource, Phase, ProgressItem, Report, ReportItem, Settings } from './types.ts';

export interface Deps {
  exec: Exec;
  tags: (repository: string) => Promise<string[]>;
  releaseNotes?: ReleaseNotesLookup;
  advisories?: AdvisoryLookup;
  // SUDO_ASKPASS and its token, when the user saved an admin password for unattended runs.
  sudoEnv?: Record<string, string>;
  portainer: PortainerClient | null;
  platform: NodeJS.Platform;
  arch: string;
  backupDir: string;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  log(message: string): void;
  onProgress?(items: ProgressItem[]): void;
}

interface ImagePlan {
  containers: ContainerInfo[];
  stack: string | null;
  repository: string;
  from: string;
  to: string;
  decision: Decision;
}

const HEALTH_LIMIT_MS = 5 * 60_000;
const HEALTH_POLL_MS = 10_000;
export const BREW_ENV = { HOMEBREW_NO_ENV_HINTS: '1', HOMEBREW_NO_AUTO_UPDATE: '1', NONINTERACTIVE: '1' };

interface Tracker {
  plan(items: Pick<ProgressItem, 'source' | 'name' | 'from' | 'to'>[]): void;
  step(source: ItemSource, name: string, phase: Phase, percent: number | null): void;
  finish(source: ItemSource, name: string, ok: boolean, reason: string): void;
}

function createTracker(deps: Deps): Tracker {
  let items: ProgressItem[] = [];
  const emit = () => deps.onProgress?.(items.map((item) => ({ ...item })));
  const find = (source: ItemSource, name: string) => items.find((item) => item.id === `${source}:${name}`);
  return {
    plan(planned) {
      items = planned.map((item) => ({ ...item, id: `${item.source}:${item.name}`, state: 'queued', phase: null, percent: 0, reason: '' }));
      emit();
    },
    step(source, name, phase, percent) {
      const item = find(source, name);
      if (item) Object.assign(item, { state: 'running', phase, percent });
      emit();
    },
    finish(source, name, ok, reason) {
      const item = find(source, name);
      if (item) Object.assign(item, { state: ok ? 'done' : 'failed', phase: null, percent: 100, reason });
      emit();
    },
  };
}

async function inspectAll(deps: Deps, portainerStacks?: string[]): Promise<ContainerInfo[]> {
  const ids = await deps.exec('docker', ['ps', '-q']);
  if (ids.code !== 0) throw new Error('Docker is not reachable');
  const list = ids.stdout.split('\n').filter(Boolean);
  if (list.length === 0) return [];
  const inspected = await deps.exec('docker', ['inspect', ...list]);
  if (inspected.code !== 0) throw new Error('Docker inspect failed');
  return parseInspect(JSON.parse(inspected.stdout), portainerStacks);
}

async function supportsArch(deps: Deps, image: string): Promise<boolean> {
  const result = await deps.exec('docker', ['manifest', 'inspect', image]);
  if (result.code !== 0) return false;
  const manifest = JSON.parse(result.stdout);
  // A single-platform image has no list to check; the pull will tell.
  if (!Array.isArray(manifest.manifests)) return true;
  const wanted = deps.arch === 'x64' ? 'amd64' : deps.arch;
  return manifest.manifests.some((entry: { platform?: { architecture?: string } }) => entry.platform?.architecture === wanted);
}

async function planDocker(deps: Deps, settings: Settings, stacks: PortainerStack[] | null, notes: string[]): Promise<ImagePlan[]> {
  const containers = await inspectAll(deps, stacks?.map((stack) => stack.name));
  const groups = new Map<string, ContainerInfo[]>();
  for (const container of containers) {
    const key = `${container.stack}|${container.image.repository}|${container.image.tag}`;
    groups.set(key, [...(groups.get(key) ?? []), container]);
  }

  const plans: ImagePlan[] = [];
  for (const group of groups.values()) {
    const [first] = group;
    const { repository, tag } = first.image;
    if (repository.startsWith('local/')) continue;
    let tags: string[];
    try {
      tags = await deps.tags(repository);
    } catch (error) {
      notes.push(`${repository}: ${(error as Error).message}`);
      continue;
    }
    const to = latestTag(tag, tags);
    if (!to) continue;
    let candidate: Parameters<typeof decide>[0] = {
      image: repository,
      currentTag: tag,
      candidateTag: to,
      healthy: group.every((container) => container.healthy),
      managed: first.manager === 'compose' || first.manager === 'portainer',
    };
    const policy = { autoMinor: settings.autoMinor, holds: settings.holds, approved: settings.approved };
    let decision = decide(candidate, policy);
    // A minor update goes ahead on its own only as a security fix (release notes or GitHub advisories),
    // or, with minor updates switched on, when its release notes are found and mention nothing breaking.
    const minor = decision.reason === MINOR_WITHOUT_NOTES || decision.reason === OPTIONAL_MINOR;
    if (minor && deps.releaseNotes) {
      try {
        const releaseNotes = await deps.releaseNotes(repository, first.source, tag, to);
        if (releaseNotes) candidate = { ...candidate, releaseNotes };
      } catch (error) {
        notes.push(`${repository}: release notes: ${(error as Error).message}`);
      }
      decision = decide(candidate, policy);
    }
    if (minor && decision.action === 'propose' && decision.reason !== 'release notes mention breaking changes' && deps.advisories) {
      try {
        const advisories = await deps.advisories(repository, first.source, tag, to);
        if (advisories.length) candidate = { ...candidate, advisories };
      } catch (error) {
        notes.push(`${repository}: security advisories: ${(error as Error).message}`);
      }
      decision = decide(candidate, policy);
    }
    if (decision.action === 'auto' && first.manager === 'portainer') {
      const stack = stacks?.find((entry) => entry.name === first.stack);
      if (!stack) decision = { action: 'propose', reason: 'Portainer is not connected' };
      else if (stack.gitManaged) decision = { action: 'propose', reason: 'stack is deployed from Git' };
    }
    if (decision.action === 'auto' && first.manager === 'compose' && group.some((container) => !container.composeFile)) {
      decision = { action: 'propose', reason: 'Compose file not found' };
    }
    if (decision.action === 'auto' && !(await supportsArch(deps, `${repository}:${to}`))) {
      decision = { action: 'propose', reason: `no confirmed ${deps.arch} image` };
    }
    plans.push({ containers: group, stack: first.stack, repository, from: tag, to, decision });
  }
  return plans;
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function dumpDatabases(deps: Deps, stackContainers: ContainerInfo[], folder: string): Promise<void> {
  for (const container of stackContainers) {
    if (!/(^|\/)postgres(:|$)/.test(container.image.repository) && !container.postgresUser) continue;
    const dump = await deps.exec('docker', ['exec', container.name, 'pg_dumpall', '-U', container.postgresUser ?? 'postgres'], { timeoutMs: 30 * 60_000 });
    if (dump.code !== 0) throw new Error(`database backup of ${container.name} failed`);
    await deps.writeFile(`${folder}/${container.name}.sql`, dump.stdout);
  }
}

async function waitHealthy(deps: Deps, expected: Map<string, string>): Promise<boolean> {
  const started = deps.now().getTime();
  let goodPolls = 0;
  while (deps.now().getTime() - started < HEALTH_LIMIT_MS) {
    await deps.sleep(HEALTH_POLL_MS);
    const all = await inspectAll(deps).catch(() => []);
    const good = [...expected].every(([name, image]) => {
      const found = all.find((container) => container.name === name);
      return found?.healthy && `${found.image.repository}:${found.image.tag}` === image;
    });
    goodPolls = good ? goodPolls + 1 : 0;
    // Two polls in a row: a container in a restart loop looks fine for a moment.
    if (goodPolls >= 2) return true;
  }
  return false;
}

interface Target {
  read(): Promise<string>;
  deploy(content: string): Promise<void>;
}

function composeTarget(deps: Deps, file: string): Target {
  return {
    read: () => deps.readFile(file),
    async deploy(content) {
      await deps.writeFile(file, content);
      const up = await deps.exec('docker', ['compose', '-f', file, 'up', '-d', '--pull', 'missing'], { timeoutMs: 15 * 60_000 });
      if (up.code !== 0) throw new Error('docker compose up failed');
    },
  };
}

function portainerTarget(client: PortainerClient, stack: PortainerStack): Target {
  return { read: () => client.file(stack.id), deploy: (content) => client.update(stack, content) };
}

async function applyStack(deps: Deps, tracker: Tracker, plans: ImagePlan[], allContainers: ContainerInfo[], stacks: PortainerStack[] | null): Promise<ReportItem[]> {
  const [first] = plans;
  const name = first.stack as string;
  const item = (plan: ImagePlan, outcome: ReportItem['outcome'], reason: string): ReportItem => ({
    source: 'docker', name: plan.containers[0].name, from: plan.from, to: plan.to, outcome, reason,
  });
  const all = (outcome: ReportItem['outcome'], reason: string) => {
    for (const plan of plans) tracker.finish('docker', plan.containers[0].name, outcome === 'applied', reason);
    return plans.map((plan) => item(plan, outcome, reason));
  };
  const step = (phase: Phase, percent: number) => {
    for (const plan of plans) tracker.step('docker', plan.containers[0].name, phase, percent);
  };

  const manager = first.containers[0].manager;
  const stack = stacks?.find((entry) => entry.name === name);
  const target = manager === 'portainer' && deps.portainer && stack
    ? portainerTarget(deps.portainer, stack)
    : composeTarget(deps, first.containers[0].composeFile as string);

  const folder = `${deps.backupDir}/${stamp(deps.now())}/${name}`;
  let original: string;
  step('backup', 10);
  try {
    original = await target.read();
    await deps.writeFile(`${folder}/docker-compose.yml`, original);
    await dumpDatabases(deps, allContainers.filter((container) => container.stack === name), folder);
  } catch (error) {
    return all('waiting', `no update without backup: ${(error as Error).message}`);
  }

  let next = original;
  for (const plan of plans) {
    const bumped = bumpImage(next, plan.repository, plan.from, plan.to);
    if (bumped === null) return all('waiting', `image line for ${plan.repository} not found in stack file`);
    next = bumped;
  }

  const expected = new Map(plans.flatMap((plan) => plan.containers.map((container) => [container.name, `${plan.repository}:${plan.to}`] as [string, string])));
  let reason: string;
  try {
    deps.log(`Updating stack ${name}`);
    step('update', 35);
    await target.deploy(next);
    step('test', 70);
    if (await waitHealthy(deps, expected)) return all('applied', plans[0].decision.reason);
    reason = 'not healthy within 5 minutes';
  } catch (error) {
    reason = (error as Error).message;
  }

  deps.log(`Rolling back stack ${name}: ${reason}`);
  step('rollback', 85);
  try {
    await target.deploy(original);
    return all('rolled-back', reason);
  } catch (error) {
    return all('failed', `rollback failed, backup in ${folder}: ${(error as Error).message}`);
  }
}

async function outdatedBrew(deps: Deps): Promise<OutdatedPackage[]> {
  const result = await deps.exec('brew', ['outdated', '--json=v2', '--greedy'], { env: BREW_ENV });
  if (result.code !== 0) throw new Error('brew outdated failed');
  return parseOutdated(result.stdout);
}

function betaFor(installed: string, available: string): boolean {
  return isPrerelease(available) && !isPrerelease(installed);
}

function packageItem(source: ItemSource, name: string, from: string, to: string, outcome: ReportItem['outcome'], reason: string, detail?: string, id?: string): ReportItem {
  return { source, name, from, to, outcome, reason, ...(detail ? { detail } : {}), ...(id && id !== name ? { id } : {}) };
}

export { lastLines };

async function waitForDocker(deps: Deps): Promise<boolean> {
  const started = deps.now().getTime();
  while (deps.now().getTime() - started < HEALTH_LIMIT_MS) {
    await deps.sleep(HEALTH_POLL_MS);
    if ((await deps.exec('docker', ['ps', '-q'])).code === 0) return true;
  }
  return false;
}

interface PackageResult {
  ok: boolean;
  reason: string;
  detail?: string;
}

interface Attempt {
  install(force: boolean): Promise<ExecResult>;
  diagnose(result: ExecResult): Diagnosis;
  refresh(): Promise<unknown>;
  reinstall?(): Promise<ExecResult>;
}

function installWithRepair(deps: Deps, tracker: Tracker, source: ItemSource, name: string, attempt: Attempt): Promise<PackageResult> {
  return repairLadder({
    ...attempt,
    name,
    sleep: deps.sleep,
    log: deps.log,
    onPhase: (phase) => tracker.step(source, name, phase, null),
  });
}

function repairCommands(deps: Deps, entry: Pick<Package, 'manager' | 'id' | 'kind'>, env?: Record<string, string>): () => Promise<ExecResult> {
  const plan = repairPlan(entry);
  return async () => {
    await runSequence(deps.exec, plan.clean, 30 * 60_000, env);
    return runSequence(deps.exec, plan.reinstall, 60 * 60_000, env);
  };
}

const NO_CHANGE = 'installer finished, but the version did not change';

async function listBrew(deps: Deps, settings: Settings, apply: boolean): Promise<{ open: OutdatedPackage[]; held: OutdatedPackage[] } | null> {
  if ((await deps.exec('brew', ['--version'])).code !== 0) return null;
  if (apply) await deps.exec('brew', ['update'], { timeoutMs: 10 * 60_000, env: BREW_ENV });
  const isHeld = (entry: OutdatedPackage) => entry.name === 'patchday' || settings.holds.includes(entry.name);
  const outdated = (await outdatedBrew(deps)).filter((entry) => !isSkipped(settings.skipped, { manager: 'brew', id: entry.name }, entry.available));
  return { open: upgradeOrder(outdated.filter((entry) => !isHeld(entry))), held: outdated.filter(isHeld) };
}

async function applyBrew(deps: Deps, tracker: Tracker, open: OutdatedPackage[], notes: string[]): Promise<ReportItem[]> {
  // Casks that install or remove system files ask sudo; with a saved password it answers by itself.
  const env = { ...BREW_ENV, ...deps.sudoEnv };
  const results = new Map<string, PackageResult>();
  for (const entry of open) {
    const result = await installWithRepair(deps, tracker, 'brew', entry.name, {
      install: (force) => deps.exec('brew', upgradeArgs(entry, force), { timeoutMs: 60 * 60_000, env }),
      diagnose: (failed) => diagnoseBrew(`${failed.stderr}\n${failed.stdout}`),
      refresh: async () => {
        await deps.exec('brew', ['cleanup', entry.name], { env: BREW_ENV });
        await deps.exec('brew', ['update'], { timeoutMs: 10 * 60_000, env: BREW_ENV });
      },
      reinstall: repairCommands(deps, { manager: 'brew', id: entry.name, kind: entry.kind }, env),
    });
    results.set(entry.name, result);
    if (restartsDocker(entry) && !(await waitForDocker(deps))) notes.push('Docker did not come back within 5 minutes.');
  }
  await deps.exec('brew', ['autoremove'], { timeoutMs: 10 * 60_000, env: BREW_ENV });
  await deps.exec('brew', ['cleanup'], { timeoutMs: 10 * 60_000, env: BREW_ENV });

  const left = new Set((await outdatedBrew(deps)).map((entry) => entry.name));
  return open.map((entry) => {
    const result = results.get(entry.name) as PackageResult;
    const ok = result.ok && !left.has(entry.name);
    const reason = ok ? result.reason || 'Homebrew update' : result.reason || NO_CHANGE;
    tracker.finish('brew', entry.name, ok, reason);
    return packageItem('brew', entry.name, entry.installed, entry.available, ok ? 'applied' : 'failed', reason, ok ? undefined : result.detail);
  });
}


async function listWinget(deps: Deps, settings: Settings): Promise<WingetPackage[]> {
  const result = await deps.exec('winget', ['upgrade', ...WINGET_FLAGS], { timeoutMs: 5 * 60_000 });
  return parseWingetUpgrade(result.stdout).filter(
    (entry) => !settings.holds.includes(entry.id) && !settings.holds.includes(entry.name) && entry.id !== 'kvn-be.Patchday'
      && !isSkipped(settings.skipped, { manager: 'winget', id: entry.id }, entry.available),
  );
}


async function applyWinget(deps: Deps, tracker: Tracker, open: WingetPackage[], settings: Settings): Promise<ReportItem[]> {
  // Chocolatey ran first and may have updated the same apps.
  const still = new Set((await listWinget(deps, settings)).map((entry) => entry.id));
  const results = new Map<string, PackageResult>();
  for (const entry of open) {
    if (!still.has(entry.id)) {
      results.set(entry.id, { ok: true, reason: 'already updated by Chocolatey' });
      continue;
    }
    const target = wingetTarget(entry.id);
    const result = await installWithRepair(deps, tracker, 'winget', entry.name, {
      // A forced install does not depend on the old installation's folders.
      install: (force) => deps.exec('winget', [force ? 'install' : 'upgrade', ...target, ...(force ? ['--force'] : []), '--silent', '--accept-package-agreements', ...WINGET_FLAGS], { timeoutMs: 30 * 60_000 }),
      diagnose: (failed) => diagnoseWinget(failed.code, `${failed.stdout}\n${failed.stderr}`),
      refresh: () => deps.exec('winget', ['source', 'update'], { timeoutMs: 5 * 60_000 }),
      reinstall: repairCommands(deps, { manager: 'winget', id: entry.id }),
    });
    results.set(entry.id, result);
  }
  let left = new Set((await listWinget(deps, settings)).map((entry) => entry.id));
  // An installer can report success and still leave the old version, for example in another scope.
  const unchanged = open.filter((entry) => left.has(entry.id) && (results.get(entry.id) as PackageResult).ok && !(results.get(entry.id) as PackageResult).reason);
  for (const entry of unchanged) {
    tracker.step('winget', entry.name, 'retry', null);
    const again = await deps.exec('winget', ['install', ...wingetTarget(entry.id), '--force', '--silent', '--accept-package-agreements', ...WINGET_FLAGS], { timeoutMs: 30 * 60_000 });
    if (again.code !== 0) results.set(entry.id, { ok: false, reason: diagnoseWinget(again.code, `${again.stdout}\n${again.stderr}`).reason, detail: lastLines(again) });
  }
  if (unchanged.length > 0) left = new Set((await listWinget(deps, settings)).map((entry) => entry.id));
  return open.map((entry) => {
    const result = results.get(entry.id) as PackageResult;
    const ok = result.ok && (!left.has(entry.id) || Boolean(result.reason));
    const reason = ok ? result.reason || 'winget update' : result.reason || NO_CHANGE;
    tracker.finish('winget', entry.name, ok, reason);
    return packageItem('winget', entry.name, entry.installed, entry.available, ok ? 'applied' : 'failed', reason, ok ? undefined : result.detail, entry.id);
  });
}

async function listChoco(deps: Deps, settings: Settings): Promise<{ open: ChocoPackage[]; held: ChocoPackage[] } | null> {
  if ((await deps.exec('choco', ['--version'])).code !== 0) return null;
  const result = await deps.exec('choco', ['outdated', '--limit-output'], { timeoutMs: 10 * 60_000 });
  const outdated = parseChocoOutdated(result.stdout).filter((entry) => !isSkipped(settings.skipped, { manager: 'choco', id: entry.name }, entry.available));
  const isHeld = (entry: ChocoPackage) => entry.pinned || settings.holds.includes(entry.name);
  return { open: outdated.filter((entry) => !isHeld(entry)), held: outdated.filter(isHeld) };
}

async function applyChoco(deps: Deps, tracker: Tracker, open: ChocoPackage[], settings: Settings): Promise<ReportItem[]> {
  const results = new Map<string, PackageResult>();
  for (const entry of open) {
    const result = await installWithRepair(deps, tracker, 'choco', entry.name, {
      install: (force) => deps.exec('choco', ['upgrade', entry.name, '-y', '--no-progress', ...(force ? ['--force'] : [])], { timeoutMs: 30 * 60_000 }),
      diagnose: (failed) => diagnoseChoco(failed.code, `${failed.stdout}\n${failed.stderr}`),
      refresh: () => deps.exec('choco', ['cache', 'remove', '-y'], { timeoutMs: 5 * 60_000 }),
      // Scheduled runs on Windows already hold admin rights, so Chocolatey runs directly here.
      reinstall: () => deps.exec('choco', ['install', entry.name, '-y', '--force', '--no-progress'], { timeoutMs: 30 * 60_000 }),
    });
    results.set(entry.name, result);
  }
  const left = new Set(((await listChoco(deps, settings))?.open ?? []).map((entry) => entry.name));
  return open.map((entry) => {
    const result = results.get(entry.name) as PackageResult;
    const ok = result.ok && (!left.has(entry.name) || Boolean(result.reason));
    const reason = ok ? result.reason || 'Chocolatey update' : result.reason || NO_CHANGE;
    tracker.finish('choco', entry.name, ok, reason);
    return packageItem('choco', entry.name, entry.installed, entry.available, ok ? 'applied' : 'failed', reason, ok ? undefined : result.detail);
  });
}

interface ScoopUpdate { id: string; installed: string; available: string }

function scoop(deps: Deps, args: string[], timeoutMs = 5 * 60_000): Promise<ExecResult> {
  const command = scoopCommand(args);
  return deps.exec(command.command, command.args, { timeoutMs });
}

async function listScoop(deps: Deps, settings: Settings, apply: boolean): Promise<{ open: ScoopUpdate[]; held: ScoopUpdate[] } | null> {
  if ((await scoop(deps, ['--version'], 60_000)).code !== 0) return null;
  // Refreshes the buckets, like brew update. Previews only read what is already known.
  if (apply) await scoop(deps, ['update'], 10 * 60_000);
  const outdated = parseScoopStatus((await scoop(deps, ['status'])).stdout).filter((entry) => !isSkipped(settings.skipped, { manager: 'scoop', id: entry.id }, entry.available));
  const isHeld = (entry: ScoopUpdate) => settings.holds.includes(entry.id);
  return { open: outdated.filter((entry) => !isHeld(entry)), held: outdated.filter(isHeld) };
}

async function applyScoop(deps: Deps, tracker: Tracker, open: ScoopUpdate[]): Promise<ReportItem[]> {
  const results = new Map<string, PackageResult>();
  for (const entry of open) {
    const result = await installWithRepair(deps, tracker, 'scoop', entry.id, {
      install: () => scoop(deps, ['update', entry.id], 30 * 60_000),
      diagnose: (failed) => diagnoseScoop(`${failed.stdout}\n${failed.stderr}`),
      refresh: () => scoop(deps, ['update'], 10 * 60_000),
      reinstall: repairCommands(deps, { manager: 'scoop', id: entry.id }),
    });
    results.set(entry.id, result);
  }
  const left = new Set(parseScoopStatus((await scoop(deps, ['status'])).stdout).map((entry) => entry.id));
  return open.map((entry) => {
    const result = results.get(entry.id) as PackageResult;
    const ok = result.ok && (!left.has(entry.id) || Boolean(result.reason));
    const reason = ok ? result.reason || 'Scoop update' : result.reason || NO_CHANGE;
    tracker.finish('scoop', entry.id, ok, reason);
    return packageItem('scoop', entry.id, entry.installed, entry.available, ok ? 'applied' : 'failed', reason, ok ? undefined : result.detail);
  });
}

function summarize(items: ReportItem[]): Report['status'] {
  if (items.some((item) => item.outcome === 'failed' || item.outcome === 'rolled-back')) return 'error';
  return items.some((item) => item.outcome === 'waiting') ? 'warning' : 'ok';
}

export async function run(deps: Deps, settings: Settings, mode: Report['mode']): Promise<Report> {
  const startedAt = deps.now().toISOString();
  const notes: string[] = [];
  const items: ReportItem[] = [];
  const apply = mode === 'apply';
  const tracker = createTracker(deps);

  let stacks: PortainerStack[] | null = null;
  if (deps.portainer) {
    try {
      stacks = await deps.portainer.stacks();
    } catch (error) {
      notes.push(`Portainer: ${(error as Error).message}. Portainer stacks stay untouched.`);
    }
  }

  let auto: ImagePlan[] = [];
  try {
    const plans = await planDocker(deps, settings, stacks, notes);
    auto = plans.filter((plan) => plan.decision.action === 'auto');
    for (const plan of plans.filter((entry) => entry.decision.action !== 'auto')) {
      const optional = plan.decision.reason === OPTIONAL_MINOR ? { optional: `${plan.repository}:${plan.to}` } : {};
      items.push({ source: 'docker', name: plan.containers[0].name, from: plan.from, to: plan.to, outcome: 'waiting', reason: plan.decision.reason, ...optional });
    }
  } catch (error) {
    notes.push(`Docker: ${(error as Error).message}`);
  }

  let brew: Awaited<ReturnType<typeof listBrew>> = null;
  let winget: WingetPackage[] = [];
  let choco: Awaited<ReturnType<typeof listChoco>> = null;
  let scoopApps: Awaited<ReturnType<typeof listScoop>> = null;
  try {
    if (deps.platform === 'darwin' || deps.platform === 'linux') brew = await listBrew(deps, settings, apply);
    if (deps.platform === 'win32') {
      choco = await listChoco(deps, settings);
      winget = await listWinget(deps, settings);
      // A beta is never offered for a stable install, as with containers.
      for (const entry of choco?.open.filter((item) => betaFor(item.installed, item.available)) ?? []) items.push(packageItem('choco', entry.name, entry.installed, entry.available, 'waiting', 'prerelease'));
      for (const entry of winget.filter((item) => betaFor(item.installed, item.available))) items.push(packageItem('winget', entry.name, entry.installed, entry.available, 'waiting', 'prerelease', undefined, entry.id));
      if (choco) choco = { ...choco, open: choco.open.filter((item) => !betaFor(item.installed, item.available)) };
      winget = winget.filter((item) => !betaFor(item.installed, item.available));
      scoopApps = await listScoop(deps, settings, apply);
    }
  } catch (error) {
    notes.push(`Packages: ${(error as Error).message}`);
  }
  for (const entry of brew?.held ?? []) items.push(packageItem('brew', entry.name, entry.installed, entry.available, 'waiting', 'on hold list'));
  for (const entry of choco?.held ?? []) items.push(packageItem('choco', entry.name, entry.installed, entry.available, 'waiting', entry.pinned ? 'pinned in Chocolatey' : 'on hold list'));
  for (const entry of scoopApps?.held ?? []) items.push(packageItem('scoop', entry.id, entry.installed, entry.available, 'waiting', 'on hold list'));

  if (!apply) {
    for (const plan of auto) items.push({ source: 'docker', name: plan.containers[0].name, from: plan.from, to: plan.to, outcome: 'planned', reason: plan.decision.reason });
    for (const entry of brew?.open ?? []) items.push(packageItem('brew', entry.name, entry.installed, entry.available, 'planned', 'Homebrew update'));
    for (const entry of choco?.open ?? []) items.push(packageItem('choco', entry.name, entry.installed, entry.available, 'planned', 'Chocolatey update'));
    for (const entry of winget) items.push(packageItem('winget', entry.name, entry.installed, entry.available, 'planned', 'winget update'));
    for (const entry of scoopApps?.open ?? []) items.push(packageItem('scoop', entry.id, entry.installed, entry.available, 'planned', 'Scoop update'));
    return { startedAt, finishedAt: deps.now().toISOString(), mode, status: summarize(items), items, notes };
  }

  tracker.plan([
    ...auto.map((plan) => ({ source: 'docker' as const, name: plan.containers[0].name, from: plan.from, to: plan.to })),
    ...(brew?.open ?? []).map((entry) => ({ source: 'brew' as const, name: entry.name, from: entry.installed, to: entry.available })),
    ...(choco?.open ?? []).map((entry) => ({ source: 'choco' as const, name: entry.name, from: entry.installed, to: entry.available })),
    ...winget.map((entry) => ({ source: 'winget' as const, name: entry.name, from: entry.installed, to: entry.available })),
    ...(scoopApps?.open ?? []).map((entry) => ({ source: 'scoop' as const, name: entry.id, from: entry.installed, to: entry.available })),
  ]);

  try {
    if (auto.length > 0) {
      const everything = await inspectAll(deps, stacks?.map((stack) => stack.name));
      const byStack = new Map<string, ImagePlan[]>();
      for (const plan of auto) byStack.set(plan.stack as string, [...(byStack.get(plan.stack as string) ?? []), plan]);
      // One stack at a time, so a failure stays small and easy to undo.
      for (const group of byStack.values()) items.push(...(await applyStack(deps, tracker, group, everything, stacks)));
    }
  } catch (error) {
    notes.push(`Docker: ${(error as Error).message}`);
  }

  try {
    if (brew) items.push(...(await applyBrew(deps, tracker, brew.open, notes)));
    if (choco) items.push(...(await applyChoco(deps, tracker, choco.open, settings)));
    if (winget.length > 0) items.push(...(await applyWinget(deps, tracker, winget, settings)));
    if (scoopApps && scoopApps.open.length > 0) items.push(...(await applyScoop(deps, tracker, scoopApps.open)));
  } catch (error) {
    notes.push(`Packages: ${(error as Error).message}`);
  }

  return { startedAt, finishedAt: deps.now().toISOString(), mode, status: summarize(items), items, notes };
}
