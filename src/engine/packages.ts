import { parseChocoOutdated } from '../core/choco.ts';
import {
  latestCrateVersion, latestNugetVersion, npmCommand, parseCargoList, parseCargoSearch, parseDotnetList, parseDotnetSearch,
  parseNpmList, parseNpmSearch, parsePipList, parsePsModules, parsePypiProject, parseVcpkgList, parseVcpkgSearch,
  parseVcpkgUpdate, powershellScript, psSearch, PS_LIST, PS_OUTDATED, type ExtraManager,
} from '../core/extra.ts';
import { diagnoseBrew, diagnoseElevated, diagnoseExtra, diagnoseScoop, diagnoseWinget, type Diagnosis } from '../core/failures.ts';
import { abortOnPreFail, postCommand, preCommand, type InstallOptions, type OptionPolicy } from '../core/options.ts';
import {
  actionCommand, defaultExecutable, isExtra, isSafeQuery, managersFor, MANAGER_NAMES, packageKey, repairPlan, parseBrewInstalled,
  parseBrewSearch, parseChocoPairs, parseScoopExport, parseScoopSearch, parseScoopStatus, parseWingetList, parseWingetSearch,
  scoopCommand, WINGET_FLAGS, type Command, type Manager, type Package, type PackageAction,
} from '../core/packages.ts';
import { BREW_ENV, lastLines } from './run.ts';
import { installWithRepair, runSequence } from './repair.ts';
import type { Exec, ExecResult } from './types.ts';

export { managersFor };

export interface PackageDeps {
  exec: Exec;
  platform: NodeJS.Platform;
  sleep?(ms: number): Promise<void>;
  // Reads a public registry (PyPI, NuGet, crates.io). Returns null when it cannot be reached.
  fetchText?(url: string): Promise<string | null>;
  // Programs the user chose in Settings, by manager.
  executables?: Partial<Record<Manager, string>>;
  // Managers turned off in Settings are neither listed nor searched.
  disabled?: Manager[];
}

export interface Inventory {
  packages: Package[];
  managers: Manager[];
  // One line per manager that could not be read, with the next step.
  problems: string[];
}

export interface ActionResult {
  key: string;
  ok: boolean;
  reason: string;
  detail?: string;
}

export interface ManagerStatus {
  manager: Manager;
  name: string;
  found: boolean;
  enabled: boolean;
  version: string;
  executable: string;
}

const LIST_TIMEOUT = 5 * 60_000;
const SEARCH_LIMIT = 50;

const exe = (deps: PackageDeps, manager: Manager) => deps.executables?.[manager] || defaultExecutable(manager, deps.platform);

// The command that runs `args` with a manager's own program.
export function managerCommand(deps: PackageDeps, manager: Manager, args: string[]): Command {
  if (manager === 'scoop') return scoopCommand(args, exe(deps, 'scoop'));
  if (manager === 'pip') return { command: exe(deps, 'pip'), args: ['-m', 'pip', ...args] };
  if (manager === 'npm') return npmCommand(args, deps.platform, exe(deps, 'npm'));
  const extra = manager === 'winget' ? WINGET_FLAGS : [];
  return { command: exe(deps, manager), args: [...args, ...extra] };
}

function psCommand(deps: PackageDeps, manager: 'pwsh' | 'winps', script: string): Command {
  const command = powershellScript(manager === 'pwsh' ? 'pwsh' : 'powershell', script);
  return { command: deps.executables?.[manager] || command.command, args: command.args };
}

function run(deps: PackageDeps, manager: Manager, args: string[], timeoutMs = LIST_TIMEOUT): Promise<ExecResult> {
  const command = managerCommand(deps, manager, args);
  return deps.exec(command.command, command.args, { timeoutMs, ...(manager === 'brew' ? { env: BREW_ENV } : {}) });
}

function runPs(deps: PackageDeps, manager: 'pwsh' | 'winps', script: string, timeoutMs = LIST_TIMEOUT): Promise<ExecResult> {
  const command = psCommand(deps, manager, script);
  return deps.exec(command.command, command.args, { timeoutMs });
}

async function versionOf(deps: PackageDeps, manager: Manager): Promise<string | null> {
  const result = manager === 'pwsh' || manager === 'winps'
    ? await runPs(deps, manager, '$PSVersionTable.PSVersion.ToString()', 60_000)
    : manager === 'vcpkg' ? await run(deps, manager, ['version'], 60_000)
      : manager === 'scoop' || manager === 'pip' || manager === 'npm' ? await run(deps, manager, ['--version'], 60_000)
        : await deps.exec(exe(deps, manager), ['--version'], { timeoutMs: 60_000 });
  if (result.code !== 0) return null;
  return (/\d+(?:\.\d+)+[\w.+-]*/.exec(result.stdout)?.[0] ?? result.stdout.trim().split('\n')[0] ?? '').slice(0, 40);
}

// Every manager this system can have, whether it is there, and what Settings say about it.
export async function managerStatus(deps: PackageDeps): Promise<ManagerStatus[]> {
  return Promise.all(managersFor(deps.platform).map(async (manager) => {
    const version = await versionOf(deps, manager).catch(() => null);
    return { manager, name: MANAGER_NAMES[manager], found: version !== null, enabled: !deps.disabled?.includes(manager), version: version ?? '', executable: exe(deps, manager) };
  }));
}

// Runs `task` for every item with at most `limit` at the same time.
async function pool<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  }));
  return results;
}

async function withLatest(deps: PackageDeps, packages: Package[], url: (entry: Package) => string, latest: (json: string) => string): Promise<Package[]> {
  if (!deps.fetchText) return packages;
  return pool(packages, 6, async (entry) => {
    const text = await deps.fetchText!(url(entry)).catch(() => null);
    if (!text) return entry;
    try {
      const version = latest(text);
      return version && version !== entry.version ? { ...entry, available: version } : entry;
    } catch {
      return entry;
    }
  });
}

async function installed(deps: PackageDeps, manager: Manager): Promise<Package[]> {
  switch (manager) {
    case 'brew': {
      const result = await run(deps, 'brew', ['info', '--json=v2', '--installed']);
      if (result.code !== 0) throw new Error('brew info failed');
      return parseBrewInstalled(result.stdout);
    }
    case 'winget': {
      const result = await run(deps, 'winget', ['list']);
      return parseWingetList(result.stdout);
    }
    case 'choco': {
      const [list, outdated] = await Promise.all([
        run(deps, 'choco', ['list', '--limit-output']),
        run(deps, 'choco', ['outdated', '--limit-output'], 10 * 60_000),
      ]);
      if (list.code !== 0) throw new Error('choco list failed');
      const newer = new Map(parseChocoOutdated(outdated.stdout).map((entry) => [entry.name, entry.available]));
      return parseChocoPairs(list.stdout).map((entry) => (newer.has(entry.id) ? { ...entry, available: newer.get(entry.id) } : entry));
    }
    case 'scoop': {
      const list = await run(deps, 'scoop', ['export']);
      if (list.code !== 0) throw new Error('scoop export failed');
      const status = await run(deps, 'scoop', ['status']);
      const newer = new Map(parseScoopStatus(status.stdout).map((entry) => [entry.id, entry.available]));
      return parseScoopExport(list.stdout).map((entry) => (newer.has(entry.id) ? { ...entry, available: newer.get(entry.id) } : entry));
    }
    case 'pip': {
      const flags = ['--format=json', '--disable-pip-version-check'];
      const [list, outdated] = await Promise.all([run(deps, 'pip', ['list', ...flags]), run(deps, 'pip', ['list', '--outdated', ...flags])]);
      if (list.code !== 0) throw new Error('pip list failed');
      return parsePipList(list.stdout, outdated.code === 0 ? outdated.stdout : '[]');
    }
    case 'npm': {
      const [list, outdated] = await Promise.all([run(deps, 'npm', ['ls', '-g', '--json', '--depth=0']), run(deps, 'npm', ['outdated', '-g', '--json'])]);
      if (!list.stdout.trim().startsWith('{')) throw new Error('npm ls failed');
      return parseNpmList(list.stdout, outdated.stdout.trim().startsWith('{') ? outdated.stdout : '{}');
    }
    case 'dotnet': {
      const list = await run(deps, 'dotnet', ['tool', 'list', '--global']);
      if (list.code !== 0) throw new Error('dotnet tool list failed');
      return withLatest(deps, parseDotnetList(list.stdout), (entry) => `https://api.nuget.org/v3-flatcontainer/${encodeURIComponent(entry.id.toLowerCase())}/index.json`, (json) => latestNugetVersion(json));
    }
    case 'pwsh': case 'winps': {
      const result = await runPs(deps, manager, PS_OUTDATED, 10 * 60_000);
      if (result.code !== 0) {
        const plain = await runPs(deps, manager, PS_LIST);
        if (plain.code !== 0) throw new Error('Get-InstalledModule failed');
        return parsePsModules(plain.stdout, manager);
      }
      return parsePsModules(result.stdout, manager);
    }
    case 'cargo': {
      const list = await run(deps, 'cargo', ['install', '--list']);
      if (list.code !== 0) throw new Error('cargo install --list failed');
      return withLatest(deps, parseCargoList(list.stdout), (entry) => `https://crates.io/api/v1/crates/${encodeURIComponent(entry.id)}`, latestCrateVersion);
    }
    case 'vcpkg': {
      const [list, update] = await Promise.all([run(deps, 'vcpkg', ['list']), run(deps, 'vcpkg', ['update'])]);
      if (list.code !== 0) throw new Error('vcpkg list failed');
      const newer = parseVcpkgUpdate(update.stdout);
      return parseVcpkgList(list.stdout).map((entry) => (newer.has(entry.id) ? { ...entry, available: newer.get(entry.id) } : entry));
    }
  }
}

// Every manager is read on its own, so one broken manager never hides the others.
export async function listInstalled(deps: PackageDeps, only?: Manager[]): Promise<Inventory> {
  const inventory: Inventory = { packages: [], managers: [], problems: [] };
  const order = managersFor(deps.platform);
  const wanted = order.filter((manager) => !deps.disabled?.includes(manager) && (!only || only.includes(manager)));
  await Promise.all(
    wanted.map(async (manager) => {
      if ((await versionOf(deps, manager).catch(() => null)) === null) return;
      inventory.managers.push(manager);
      try {
        inventory.packages.push(...(await installed(deps, manager)));
      } catch (error) {
        inventory.problems.push(`${MANAGER_NAMES[manager]}: ${(error as Error).message}. Run it once in a terminal to see why, then refresh.`);
      }
    }),
  );
  inventory.managers.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  inventory.packages.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return inventory;
}

async function find(deps: PackageDeps, manager: Manager, query: string): Promise<Package[]> {
  switch (manager) {
    case 'brew': {
      const [formulae, casks] = await Promise.all([run(deps, 'brew', ['search', '--formula', query]), run(deps, 'brew', ['search', '--cask', query])]);
      return [...parseBrewSearch(formulae.stdout, 'formula'), ...parseBrewSearch(casks.stdout, 'cask')];
    }
    case 'winget':
      return parseWingetSearch((await run(deps, 'winget', ['search', '--query', query])).stdout);
    case 'choco':
      return parseChocoPairs((await run(deps, 'choco', ['search', query, '--limit-output'], 2 * 60_000)).stdout);
    case 'scoop':
      return parseScoopSearch((await run(deps, 'scoop', ['search', query])).stdout);
    case 'pip': {
      // PyPI has no search API any more; exact project names still answer.
      if (!deps.fetchText) return [];
      const names = [...new Set([query, query.replace(/[\s_.]+/g, '-')])];
      const found = await Promise.all(names.map(async (name) => {
        const text = await deps.fetchText!(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`).catch(() => null);
        return text ? parsePypiProject(text) : null;
      }));
      return found.filter((entry) => entry !== null) as Package[];
    }
    case 'npm':
      return parseNpmSearch((await run(deps, 'npm', ['search', '--json', `--searchlimit=${SEARCH_LIMIT}`, query])).stdout);
    case 'dotnet':
      return parseDotnetSearch((await run(deps, 'dotnet', ['tool', 'search', query, '--take', String(SEARCH_LIMIT)])).stdout);
    case 'pwsh': case 'winps':
      return parsePsModules((await runPs(deps, manager, psSearch(query))).stdout, manager);
    case 'cargo':
      return parseCargoSearch((await run(deps, 'cargo', ['search', query, '--limit', String(SEARCH_LIMIT)])).stdout);
    case 'vcpkg':
      return parseVcpkgSearch((await run(deps, 'vcpkg', ['search', query])).stdout);
  }
}

export async function search(deps: PackageDeps, query: string, managers: Manager[]): Promise<{ packages: Package[]; problems: string[] }> {
  if (!isSafeQuery(query)) throw new Error('use letters, numbers, spaces and . + @ / - only, and start with a letter or number');
  const packages: Package[] = [];
  const problems: string[] = [];
  await Promise.all(
    managers.filter((manager) => !deps.disabled?.includes(manager)).map(async (manager) => {
      try {
        packages.push(...(await find(deps, manager, query.trim())).slice(0, SEARCH_LIMIT));
      } catch (error) {
        problems.push(`${MANAGER_NAMES[manager]}: ${(error as Error).message}`);
      }
    }),
  );
  return { packages, problems };
}

export function diagnose(manager: Manager, result: ExecResult): Diagnosis {
  const output = `${result.stdout}\n${result.stderr}`;
  if (manager === 'brew') return diagnoseBrew(output);
  if (manager === 'winget') return diagnoseWinget(result.code, output);
  if (manager === 'choco') return diagnoseElevated(result.code, output);
  if (manager === 'scoop') return diagnoseScoop(output);
  return diagnoseExtra(manager as ExtraManager, output);
}

// ---------- One operation ----------

export interface OperationSettings {
  options: InstallOptions;
  policy: OptionPolicy;
  // Before/after commands run only when Settings allow them.
  allowCommands: boolean;
  signal?: AbortSignal;
  log?(line: string): void;
  onPhase?(phase: string): void;
}

// A user's own command, through the system shell. Only reached when Settings allow commands.
function shellCommand(platform: NodeJS.Platform, line: string): Command {
  return platform === 'win32' ? { command: 'cmd.exe', args: ['/d', '/s', '/c', line] } : { command: '/bin/sh', args: ['-c', line] };
}

// Windows: asked to run as administrator, the command goes through the admin prompt.
function elevated(command: Command): Command {
  const list = command.args.map((arg) => `'${arg.replace(/'/g, "''")}'`).join(',');
  const script = `$p = Start-Process -FilePath '${command.command.replace(/'/g, "''")}' -ArgumentList ${list || "''"} -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`;
  return powershellScript('powershell', script);
}

function killCommand(platform: NodeJS.Platform, name: string): Command {
  return platform === 'win32' ? { command: 'taskkill', args: ['/IM', name.endsWith('.exe') ? name : `${name}.exe`, '/F'] } : { command: 'pkill', args: ['-x', name] };
}

// Install, update or remove one package with its options. Installs and updates repair themselves
// like scheduled runs do; removals run once.
export async function operate(deps: PackageDeps, action: PackageAction, entry: Package, settings: OperationSettings): Promise<ActionResult> {
  const key = packageKey(entry);
  const { options, signal } = settings;
  const log = settings.log ?? (() => {});
  const env = entry.manager === 'brew' ? BREW_ENV : undefined;
  const execute = (command: Command, timeoutMs: number) => {
    if (signal?.aborted) return Promise.resolve({ code: -1, stdout: '', stderr: 'cancelled' });
    log(`> ${command.command} ${command.args.filter((arg) => arg.length < 200).join(' ')}`);
    return deps.exec(command.command, command.args, { timeoutMs, ...(env ? { env } : {}), ...(signal ? { signal } : {}) }).then((result) => {
      for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/).filter((text) => text.trim()).slice(-200)) log(line);
      return result;
    });
  };
  try {
    const before = preCommand(options, action);
    if (before && settings.allowCommands) {
      settings.onPhase?.('before');
      const result = await execute(shellCommand(deps.platform, before), 30 * 60_000);
      if (result.code !== 0 && abortOnPreFail(options, action)) return { key, ok: false, reason: 'the command before it failed', detail: lastLines(result) };
    }
    for (const name of options.KillBeforeOperation ?? []) await execute(killCommand(deps.platform, name), 60_000);

    const ctx = { platform: deps.platform, options, policy: settings.policy, executables: deps.executables };
    const wrap = (command: Command) => (options.RunAsAdministrator && deps.platform === 'win32' && entry.manager !== 'choco' ? elevated(command) : command);
    let result: ActionResult;
    if (action === 'uninstall') {
      const output = await execute(wrap(actionCommand('uninstall', entry, ctx)), 60 * 60_000);
      const diagnosis = output.code === 0 ? null : diagnose(entry.manager, output);
      result = !diagnosis ? { key, ok: true, reason: '' } : diagnosis.applied ? { key, ok: true, reason: diagnosis.reason } : { key, ok: false, reason: signal?.aborted ? 'cancelled' : diagnosis.reason, detail: lastLines(output) };
    } else {
      if (action === 'update' && options.UninstallBeforeUpdate) await execute(wrap(actionCommand('uninstall', entry, { ...ctx, options: {} })), 60 * 60_000);
      const verb = action === 'update' && options.UninstallBeforeUpdate ? 'install' : action;
      const command = wrap(actionCommand(verb, entry, ctx));
      const plan = repairPlan(entry);
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      const repaired = await installWithRepair({
        name: entry.name,
        install: () => execute(command, 60 * 60_000),
        diagnose: (output) => (signal?.aborted ? { reason: 'cancelled', final: true } : diagnose(entry.manager, output)),
        refresh: () => (signal?.aborted ? Promise.resolve() : runSequence(deps.exec, plan.clean, 30 * 60_000, env)),
        reinstall: isExtra(entry.manager) || signal?.aborted ? undefined : () => runSequence(deps.exec, plan.reinstall, 60 * 60_000, env),
        sleep,
        log,
        onPhase: (phase) => settings.onPhase?.(phase),
      });
      result = { key, ...repaired };
      if (result.ok && action === 'update' && options.UninstallPreviousVersionsOnUpdate && entry.manager === 'brew') await execute({ command: 'brew', args: ['cleanup', entry.id] }, 10 * 60_000);
    }

    const after = postCommand(options, action);
    if (result.ok && after && settings.allowCommands) {
      settings.onPhase?.('after');
      const output = await execute(shellCommand(deps.platform, after), 30 * 60_000);
      if (output.code !== 0) result = { ...result, reason: [result.reason, 'the command after it failed'].filter(Boolean).join('; '), detail: lastLines(output) };
    }
    return result;
  } catch (error) {
    return { key, ok: false, reason: (error as Error).message };
  }
}

// One package at a time: installers of different managers must not run side by side.
export async function act(
  deps: PackageDeps,
  action: PackageAction,
  packages: Package[],
  onResult: (result: ActionResult, index: number) => void = () => {},
  onPhase: (phase: string, index: number) => void = () => {},
  settingsFor: (entry: Package) => Omit<OperationSettings, 'onPhase'> = () => ({ options: {}, policy: { allowParameters: false, allowSkipHash: false }, allowCommands: false }),
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  for (const [index, entry] of packages.entries()) {
    const result = await operate(deps, action, entry, { ...settingsFor(entry), onPhase: (phase) => onPhase(phase, index) });
    results.push(result);
    onResult(result, index);
  }
  return results;
}
