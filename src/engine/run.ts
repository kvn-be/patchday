import { parseOutdated, planBrew, type OutdatedPackage } from '../core/brew.ts';
import { bumpImage } from '../core/compose.ts';
import { parseInspect, type ContainerInfo } from '../core/docker.ts';
import { decide, type Decision } from '../core/policy.ts';
import { latestTag } from '../core/version.ts';
import { parseWingetUpgrade } from '../core/winget.ts';
import type { PortainerClient, PortainerStack } from './portainer.ts';
import type { Exec, Report, ReportItem, Settings } from './types.ts';

export interface Deps {
  exec: Exec;
  tags: (repository: string) => Promise<string[]>;
  portainer: PortainerClient | null;
  platform: NodeJS.Platform;
  arch: string;
  backupDir: string;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  log(message: string): void;
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
const BREW_ENV = { HOMEBREW_NO_ENV_HINTS: '1', HOMEBREW_NO_AUTO_UPDATE: '1', NONINTERACTIVE: '1' };

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
    let decision = decide(
      {
        image: repository,
        currentTag: tag,
        candidateTag: to,
        healthy: group.every((container) => container.healthy),
        managed: first.manager === 'compose' || first.manager === 'portainer',
      },
      { autoMinor: settings.autoMinor, holds: settings.holds },
    );
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

async function applyStack(deps: Deps, plans: ImagePlan[], allContainers: ContainerInfo[], stacks: PortainerStack[] | null): Promise<ReportItem[]> {
  const [first] = plans;
  const name = first.stack as string;
  const item = (plan: ImagePlan, outcome: ReportItem['outcome'], reason: string): ReportItem => ({
    source: 'docker', name: plan.containers[0].name, from: plan.from, to: plan.to, outcome, reason,
  });
  const all = (outcome: ReportItem['outcome'], reason: string) => plans.map((plan) => item(plan, outcome, reason));

  const manager = first.containers[0].manager;
  const stack = stacks?.find((entry) => entry.name === name);
  const target = manager === 'portainer' && deps.portainer && stack
    ? portainerTarget(deps.portainer, stack)
    : composeTarget(deps, first.containers[0].composeFile as string);

  const folder = `${deps.backupDir}/${stamp(deps.now())}/${name}`;
  let original: string;
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
    await target.deploy(next);
    if (await waitHealthy(deps, expected)) return all('applied', plans[0].decision.reason);
    reason = 'not healthy within 5 minutes';
  } catch (error) {
    reason = (error as Error).message;
  }

  deps.log(`Rolling back stack ${name}: ${reason}`);
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

function brewItems(packages: OutdatedPackage[], outcome: ReportItem['outcome'], reason: string): ReportItem[] {
  return packages.map((entry) => ({ source: 'brew', name: entry.name, from: entry.installed, to: entry.available, outcome, reason }));
}

async function waitForDocker(deps: Deps): Promise<boolean> {
  const started = deps.now().getTime();
  while (deps.now().getTime() - started < HEALTH_LIMIT_MS) {
    await deps.sleep(HEALTH_POLL_MS);
    if ((await deps.exec('docker', ['ps', '-q'])).code === 0) return true;
  }
  return false;
}

async function runBrew(deps: Deps, settings: Settings, apply: boolean, notes: string[]): Promise<ReportItem[]> {
  if ((await deps.exec('brew', ['--version'])).code !== 0) return [];
  if (apply) await deps.exec('brew', ['update'], { timeoutMs: 10 * 60_000, env: BREW_ENV });
  const held = (entry: OutdatedPackage) => entry.name === 'patchday' || settings.holds.includes(entry.name);
  const outdated = await outdatedBrew(deps);
  const open = outdated.filter((entry) => !held(entry));
  const skipped = brewItems(outdated.filter(held), 'waiting', 'on hold list');
  if (!apply) return [...brewItems(open, 'planned', 'Homebrew update'), ...skipped];

  const casks = open.filter((entry) => entry.kind === 'cask').map((entry) => entry.name);
  for (const step of planBrew(casks, { holds: settings.holds })) {
    await deps.exec('brew', step.args, { timeoutMs: 60 * 60_000, env: BREW_ENV });
    if (step.restartsDocker && !(await waitForDocker(deps))) notes.push('Docker did not come back within 5 minutes.');
  }
  await deps.exec('brew', ['autoremove'], { timeoutMs: 10 * 60_000, env: BREW_ENV });
  await deps.exec('brew', ['cleanup'], { timeoutMs: 10 * 60_000, env: BREW_ENV });

  // brew keeps going after one failed package, so the truth is what is still outdated.
  const left = new Set((await outdatedBrew(deps)).map((entry) => entry.name));
  return [
    ...brewItems(open.filter((entry) => !left.has(entry.name)), 'applied', 'Homebrew update'),
    ...open.filter((entry) => left.has(entry.name)).flatMap((entry) =>
      brewItems([entry], 'failed', `run manually: brew upgrade ${entry.kind === 'cask' ? '--cask ' : ''}${entry.name}`)),
    ...skipped,
  ];
}

async function runWinget(deps: Deps, settings: Settings, apply: boolean): Promise<ReportItem[]> {
  const flags = ['--accept-source-agreements', '--disable-interactivity'];
  const list = async () => {
    const result = await deps.exec('winget', ['upgrade', ...flags], { timeoutMs: 5 * 60_000 });
    return parseWingetUpgrade(result.stdout);
  };
  const open = (await list()).filter((entry) => !settings.holds.includes(entry.id) && entry.id !== 'kvn-be.Patchday');
  const items = (entries: typeof open, outcome: ReportItem['outcome'], reason: string): ReportItem[] =>
    entries.map((entry) => ({ source: 'winget', name: entry.name, from: entry.installed, to: entry.available, outcome, reason }));
  if (!apply) return items(open, 'planned', 'winget update');

  for (const entry of open) {
    await deps.exec('winget', ['upgrade', '--id', entry.id, '--exact', '--silent', '--accept-package-agreements', ...flags], { timeoutMs: 30 * 60_000 });
  }
  const left = new Set((await list()).map((entry) => entry.id));
  return [
    ...items(open.filter((entry) => !left.has(entry.id)), 'applied', 'winget update'),
    ...items(open.filter((entry) => left.has(entry.id)), 'failed', 'run the update manually in winget'),
  ];
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

  let stacks: PortainerStack[] | null = null;
  if (deps.portainer) {
    try {
      stacks = await deps.portainer.stacks();
    } catch (error) {
      notes.push(`Portainer: ${(error as Error).message}. Portainer stacks stay untouched.`);
    }
  }

  try {
    const plans = await planDocker(deps, settings, stacks, notes);
    const waiting = plans.filter((plan) => plan.decision.action !== 'auto');
    for (const plan of waiting) {
      items.push({ source: 'docker', name: plan.containers[0].name, from: plan.from, to: plan.to, outcome: 'waiting', reason: plan.decision.reason });
    }
    const auto = plans.filter((plan) => plan.decision.action === 'auto');
    if (!apply) {
      for (const plan of auto) {
        items.push({ source: 'docker', name: plan.containers[0].name, from: plan.from, to: plan.to, outcome: 'planned', reason: plan.decision.reason });
      }
    } else {
      const everything = await inspectAll(deps, stacks?.map((stack) => stack.name));
      const byStack = new Map<string, ImagePlan[]>();
      for (const plan of auto) byStack.set(plan.stack as string, [...(byStack.get(plan.stack as string) ?? []), plan]);
      // One stack at a time, so a failure stays small and easy to undo.
      for (const group of byStack.values()) items.push(...(await applyStack(deps, group, everything, stacks)));
    }
  } catch (error) {
    notes.push(`Docker: ${(error as Error).message}`);
  }

  try {
    if (deps.platform === 'darwin' || deps.platform === 'linux') items.push(...(await runBrew(deps, settings, apply, notes)));
    if (deps.platform === 'win32') items.push(...(await runWinget(deps, settings, apply)));
  } catch (error) {
    notes.push(`Packages: ${(error as Error).message}`);
  }

  return { startedAt, finishedAt: deps.now().toISOString(), mode, status: summarize(items), items, notes };
}
