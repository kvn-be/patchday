// The last ladder for app updates that failed in the run. It runs in the user's own session, where
// programs can be closed, installers shown and apps started:
//   1. close the program the normal way (after a notice) and try again quietly,
//   2. Visual Studio: run its own installer,
//   3. when a person started the run: show the installer,
//   4. start the program, so its own updater runs, then check again after a while.
// Programs that were closed are started again at the end.
import { macLabel, macOpen, macQuit, macRunning, matchStartApp, parseCaskApps, parsePaths, parseStartApps, parseVsPaths, START_APPS, VS_INSTALLER, VS_WHERE, windowsCloseScript, windowsOpen, windowsRunningScript, type StartApp } from '../core/apps.ts';
import { parseOutdated } from '../core/brew.ts';
import { powershellScript } from '../core/extra.ts';
import { diagnoseBrew, diagnoseScoop, diagnoseWinget, USER_SCOPE, type Diagnosis } from '../core/failures.ts';
import { isSafeId, scoopCommand, WINGET_FLAGS, wingetTarget, type Manager } from '../core/packages.ts';
import { parseWingetUpgrade } from '../core/winget.ts';
import { lastLines } from './repair.ts';
import type { Exec, ExecResult, ItemSource, ProgressItem, Report, ReportItem } from './types.ts';

export const CLOSED_AND_UPDATED = 'closed the app, updated it and started it again';
export const UPDATED_IN_SESSION = 'updated on the second try';
export const UPDATED_WITH_INSTALLER = 'updated with its own installer';
export const UPDATED_BY_ITSELF = 'started the app; it updated itself';
export const OPENED_NO_UPDATE = 'started the app, but it has not updated yet; finish the update inside the app';
export const DID_NOT_CLOSE = 'the app did not close; save your work, close it and try again';
export const VS_UPDATED = 'updated with the Visual Studio Installer';

// The app needs the user or the system, not another try.
const NO_RESCUE = /Group Policy|your organization|disk is full|not enough memory|pinned in winget|no installer for this system|discontinued by Homebrew|does not know this app|installation was cancelled|restart Windows/i;
const RESCUED_SOURCES: ItemSource[] = ['winget', 'brew', 'scoop', 'choco'];

export const SELF_UPDATE_WAIT_MS = 10 * 60_000;
export const CLOSE_NOTICE_MS = 60_000;

export type AppRef = { kind: 'mac'; app: string } | { kind: 'windows'; start: StartApp; name: string };

export interface RescueDeps {
  exec: Exec;
  platform: NodeJS.Platform;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
  // Shown before a program is closed; the text is the caller's.
  notifyClosing(name: string, seconds: number): void;
  onProgress?(items: ProgressItem[]): void;
  // A person started the run, so an installer window can be shown and answered.
  attended: boolean;
  brewEnv?: Record<string, string>;
}

export const canRescue = (item: ReportItem) => item.outcome === 'failed' && RESCUED_SOURCES.includes(item.source) && !NO_RESCUE.test(item.reason);

// ---------- finding and starting programs ----------

export function createAppFinder(exec: Exec, platform: NodeJS.Platform, brewEnv?: Record<string, string>) {
  let startApps: Promise<StartApp[]> | null = null;
  const listStartApps = () => (startApps ??= exec(...psArgs(START_APPS), { timeoutMs: 60_000 }).then((result) => parseStartApps(result.stdout)));
  return async function find(entry: { manager: Manager | ItemSource; id: string; name: string }): Promise<AppRef | null> {
    if (platform === 'darwin') {
      if (entry.manager !== 'brew' || !isSafeId('brew', entry.id)) return null;
      const result = await exec('brew', ['info', '--cask', '--json=v2', entry.id], { timeoutMs: 60_000, env: brewEnv });
      // The first one that is really there; a bundle id is checked by `open` itself.
      for (const app of result.code === 0 ? parseCaskApps(result.stdout) : []) {
        if (app.startsWith('bundle:') || (await exec('test', ['-d', `/Applications/${app}`])).code === 0) return { kind: 'mac', app };
      }
      return null;
    }
    if (platform === 'win32') {
      const start = matchStartApp(await listStartApps(), entry.name, entry.id);
      return start ? { kind: 'windows', start, name: entry.manager === 'winget' ? entry.name : start.Name } : null;
    }
    return null;
  };
}

function psArgs(script: string): [string, string[]] {
  const command = powershellScript('powershell', script);
  return [command.command, command.args];
}

export async function startApp(exec: Exec, app: AppRef): Promise<boolean> {
  const command = app.kind === 'mac' ? macOpen(app.app) : windowsOpen(app.start);
  const result = await exec(command.command, command.args, { timeoutMs: 60_000 });
  // explorer.exe returns 1 even when it started the app.
  return app.kind === 'windows' || result.code === 0;
}

// The program paths of open windows (Windows) or the bundle (macOS); empty when it is not running.
async function running(exec: Exec, app: AppRef): Promise<string[]> {
  if (app.kind === 'mac') {
    const command = macRunning(app.app);
    return (await exec(command.command, command.args)).stdout.trim() === 'true' ? [app.app] : [];
  }
  return parsePaths((await exec(...psArgs(windowsRunningScript(app.name)), { timeoutMs: 60_000 })).stdout);
}

// Asks the program to close, like clicking X. True when it is gone.
async function close(deps: RescueDeps, app: AppRef): Promise<boolean> {
  if (app.kind === 'mac') {
    const command = macQuit(app.app);
    await deps.exec(command.command, command.args, { timeoutMs: 60_000 });
    for (let waited = 0; waited < 45_000; waited += 3_000) {
      if ((await running(deps.exec, app)).length === 0) return true;
      await deps.sleep(3_000);
    }
    return (await running(deps.exec, app)).length === 0;
  }
  const result = await deps.exec(...psArgs(windowsCloseScript(app.name)), { timeoutMs: 2 * 60_000 });
  return result.stdout.trim() === '0';
}

async function reopen(deps: RescueDeps, app: AppRef, paths: string[]): Promise<void> {
  if (app.kind === 'mac' || paths.length === 0) {
    await startApp(deps.exec, app);
    return;
  }
  for (const path of paths) {
    await deps.exec(...psArgs(`Start-Process -FilePath '${path.replace(/'/g, "''")}'`), { timeoutMs: 60_000 });
  }
}

// ---------- updating ----------

function quietUpdate(deps: RescueDeps, item: ReportItem): Promise<ExecResult> | null {
  const id = item.id ?? item.name;
  if (item.source === 'winget' && isSafeId('winget', id)) return deps.exec('winget', ['upgrade', ...wingetTarget(id), '--silent', '--accept-package-agreements', ...WINGET_FLAGS], { timeoutMs: 30 * 60_000 });
  if (item.source === 'brew' && isSafeId('brew', id)) return deps.exec('brew', ['upgrade', '--greedy', id], { timeoutMs: 60 * 60_000, env: deps.brewEnv });
  if (item.source === 'scoop' && isSafeId('scoop', id)) {
    const command = scoopCommand(['update', id]);
    return deps.exec(command.command, command.args, { timeoutMs: 30 * 60_000 });
  }
  // Chocolatey needs the admin task, which already tried.
  return null;
}

function diagnose(item: ReportItem, result: ExecResult): Diagnosis {
  const output = `${result.stdout}\n${result.stderr}`;
  if (item.source === 'winget') return diagnoseWinget(result.code, output);
  if (item.source === 'brew') return diagnoseBrew(output);
  return diagnoseScoop(output);
}

const worked = (item: ReportItem, result: ExecResult | null) => result !== null && (result.code === 0 || Boolean(diagnose(item, result).applied));

// The installer with its own window, so it can ask what it needs. Only winget can do that.
function installerUpdate(deps: RescueDeps, item: ReportItem): Promise<ExecResult> | null {
  const id = item.id ?? item.name;
  if (item.source !== 'winget' || !isSafeId('winget', id)) return null;
  return deps.exec('winget', ['upgrade', ...wingetTarget(id), '--interactive', '--accept-package-agreements', '--accept-source-agreements'], { timeoutMs: 45 * 60_000 });
}

async function visualStudio(deps: RescueDeps): Promise<boolean> {
  const where = await deps.exec(VS_WHERE, ['-all', '-prerelease', '-format', 'json'], { timeoutMs: 60_000 });
  const paths = parseVsPaths(where.stdout);
  if (paths.length === 0) return false;
  let ok = true;
  for (const path of paths) {
    // The first call can stop after updating the installer itself; the second updates Visual Studio.
    let result = await deps.exec(VS_INSTALLER, ['update', '--installPath', path, '--passive', '--norestart'], { timeoutMs: 2 * 60 * 60_000 });
    if (result.code !== 0 && result.code !== 3010) result = await deps.exec(VS_INSTALLER, ['update', '--installPath', path, '--passive', '--norestart'], { timeoutMs: 2 * 60 * 60_000 });
    ok &&= result.code === 0 || result.code === 3010;
  }
  return ok;
}

// Which of these items are still offered as updates.
async function stillOutdated(deps: RescueDeps, items: ReportItem[]): Promise<Set<ReportItem>> {
  const left = new Set<ReportItem>();
  if (items.some((item) => item.source === 'winget')) {
    const ids = new Set(parseWingetUpgrade((await deps.exec('winget', ['upgrade', ...WINGET_FLAGS], { timeoutMs: 5 * 60_000 })).stdout).map((entry) => entry.id));
    for (const item of items) if (item.source === 'winget' && ids.has(item.id ?? item.name)) left.add(item);
  }
  if (items.some((item) => item.source === 'brew')) {
    const result = await deps.exec('brew', ['outdated', '--json=v2', '--greedy'], { env: deps.brewEnv });
    const names = new Set(result.code === 0 ? parseOutdated(result.stdout).map((entry) => entry.name) : []);
    for (const item of items) if (item.source === 'brew' && names.has(item.id ?? item.name)) left.add(item);
  }
  return left;
}

// ---------- the ladder ----------

interface Outcome {
  ok: boolean;
  reason: string;
  detail?: string;
  // Started so it updates itself; checked again later.
  handedOver?: boolean;
}

export async function rescue(deps: RescueDeps, report: Report): Promise<Report> {
  const failed = report.items.filter(canRescue);
  if (failed.length === 0 || (deps.platform !== 'win32' && deps.platform !== 'darwin')) return report;
  const find = createAppFinder(deps.exec, deps.platform, deps.brewEnv);
  const progress = new Map<ReportItem, ProgressItem>(failed.map((item, index) => [item, {
    id: `rescue-${index}`, source: item.source, name: item.name, from: item.from, to: item.to, state: 'queued', phase: null, percent: null, reason: '',
  }]));
  const show = (item: ReportItem, change: Partial<ProgressItem>) => {
    Object.assign(progress.get(item) as ProgressItem, change);
    deps.onProgress?.([...progress.values()].map((entry) => ({ ...entry })));
  };
  const outcomes = new Map<ReportItem, Outcome>();

  for (const item of failed) {
    show(item, { state: 'running', phase: 'retry' });
    const outcome = await rescueOne(deps, item, await find({ manager: item.source, id: item.id ?? item.name, name: item.name }).catch(() => null), (phase) => show(item, { phase }));
    outcomes.set(item, outcome);
    deps.log(`rescue ${item.name}: ${outcome.ok ? 'done' : outcome.handedOver ? 'started the app' : 'failed'}: ${outcome.reason}`);
    show(item, { state: outcome.ok ? 'done' : outcome.handedOver ? 'running' : 'failed', reason: outcome.reason });
  }

  // Apps that update themselves need a few minutes after they start.
  const handedOver = [...outcomes].filter(([, outcome]) => outcome.handedOver).map(([item]) => item);
  if (handedOver.length) await deps.sleep(SELF_UPDATE_WAIT_MS);
  // A quiet success is checked too: an installer can return 0 and leave the old version.
  const toCheck = [...outcomes].filter(([, outcome]) => outcome.ok || outcome.handedOver).map(([item]) => item);
  const left = toCheck.length ? await stillOutdated(deps, toCheck).catch(() => new Set<ReportItem>()) : new Set<ReportItem>();
  for (const item of handedOver) {
    const outcome = outcomes.get(item) as Outcome;
    outcomes.set(item, left.has(item) ? { ok: false, reason: OPENED_NO_UPDATE, detail: outcome.detail } : { ok: true, reason: UPDATED_BY_ITSELF });
    show(item, { state: left.has(item) ? 'failed' : 'done', reason: (outcomes.get(item) as Outcome).reason });
  }
  for (const item of toCheck) {
    const outcome = outcomes.get(item) as Outcome;
    if (outcome.ok && left.has(item) && !handedOver.includes(item)) outcomes.set(item, { ok: false, reason: 'installer finished, but the version did not change', detail: outcome.detail });
  }

  const items = report.items.map((item) => {
    const outcome = outcomes.get(item);
    if (!outcome) return item;
    return outcome.ok
      ? { ...item, outcome: 'applied' as const, reason: outcome.reason, detail: undefined }
      : { ...item, reason: outcome.reason, detail: outcome.detail ?? item.detail };
  });
  const problems = items.some((item) => item.outcome === 'failed' || item.outcome === 'rolled-back');
  return { ...report, items, status: problems ? 'error' : items.some((item) => item.outcome === 'waiting') ? 'warning' : 'ok' };
}

async function rescueOne(deps: RescueDeps, item: ReportItem, app: AppRef | null, phase: (phase: ProgressItem['phase']) => void): Promise<Outcome> {
  let detail: string | undefined;
  let closedPaths: string[] = [];
  let closed = false;
  try {
    // 1. Close the program, then try again quietly. Also the second try for per-user installs.
    if (app) {
      const open = await running(deps.exec, app);
      if (open.length) {
        phase('close');
        deps.notifyClosing(app.kind === 'mac' ? macLabel(app.app) : app.start.Name, CLOSE_NOTICE_MS / 1000);
        await deps.sleep(CLOSE_NOTICE_MS);
        if (!(await close(deps, app))) return { ok: false, reason: DID_NOT_CLOSE, detail: item.detail };
        closed = true;
        closedPaths = open;
      }
    }
    phase('retry');
    const quiet = quietUpdate(deps, item);
    const again = quiet ? await quiet : null;
    if (worked(item, again)) return { ok: true, reason: closed ? CLOSED_AND_UPDATED : item.reason === USER_SCOPE ? 'winget update for your user' : UPDATED_IN_SESSION };
    if (again) detail = lastLines(again);

    // 2. Visual Studio has its own installer.
    if (/Visual Studio/i.test(`${item.name} ${item.id ?? ''} ${item.reason}`) && deps.platform === 'win32') {
      phase('installer');
      if (await visualStudio(deps)) return { ok: true, reason: VS_UPDATED };
    }

    // 3. The installer with its window, when someone is there to answer it.
    if (deps.attended) {
      const shown = installerUpdate(deps, item);
      if (shown) {
        phase('installer');
        const result = await shown;
        if (worked(item, result)) return { ok: true, reason: UPDATED_WITH_INSTALLER };
        detail = lastLines(result);
      }
    }

    // 4. Start the program; most apps that refuse an outside update update themselves at start.
    if (app) {
      phase('open');
      await startApp(deps.exec, app);
      closed = false;
      return { ok: false, reason: OPENED_NO_UPDATE, detail, handedOver: true };
    }
    return { ok: false, reason: item.reason, detail: detail ?? item.detail };
  } finally {
    // What was closed for the update is started again.
    if (closed && app) await reopen(deps, app, closedPaths).catch(() => {});
  }
}
