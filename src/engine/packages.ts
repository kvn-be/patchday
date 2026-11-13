import { parseChocoOutdated } from '../core/choco.ts';
import { diagnoseBrew, diagnoseElevated, diagnoseScoop, diagnoseWinget, type Diagnosis } from '../core/failures.ts';
import {
  actionCommand, isSafeQuery, packageKey, parseBrewInstalled, parseBrewSearch, parseChocoPairs, parseScoopExport,
  parseScoopSearch, parseScoopStatus, parseWingetList, parseWingetSearch, scoopCommand, WINGET_FLAGS,
  type Manager, type Package, type PackageAction,
} from '../core/packages.ts';
import { BREW_ENV, lastLines } from './run.ts';
import type { Exec, ExecResult } from './types.ts';

export interface PackageDeps {
  exec: Exec;
  platform: NodeJS.Platform;
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

const LIST_TIMEOUT = 5 * 60_000;
const SEARCH_LIMIT = 50;

export function managersFor(platform: NodeJS.Platform): Manager[] {
  return platform === 'win32' ? ['winget', 'choco', 'scoop'] : ['brew'];
}

function run(deps: PackageDeps, manager: Manager, args: string[], timeoutMs = LIST_TIMEOUT): Promise<ExecResult> {
  if (manager === 'scoop') {
    const command = scoopCommand(args);
    return deps.exec(command.command, command.args, { timeoutMs });
  }
  const extra = manager === 'winget' ? WINGET_FLAGS : [];
  return deps.exec(manager, [...args, ...extra], { timeoutMs, ...(manager === 'brew' ? { env: BREW_ENV } : {}) });
}

async function present(deps: PackageDeps, manager: Manager): Promise<boolean> {
  const result = manager === 'scoop' ? await run(deps, 'scoop', ['--version'], 60_000) : await deps.exec(manager, ['--version'], { timeoutMs: 60_000 });
  return result.code === 0;
}

const NAMES: Record<Manager, string> = { brew: 'Homebrew', winget: 'winget', choco: 'Chocolatey', scoop: 'Scoop' };

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
  }
}

// Every manager is read on its own, so one broken manager never hides the others.
export async function listInstalled(deps: PackageDeps): Promise<Inventory> {
  const inventory: Inventory = { packages: [], managers: [], problems: [] };
  await Promise.all(
    managersFor(deps.platform).map(async (manager) => {
      if (!(await present(deps, manager))) return;
      inventory.managers.push(manager);
      try {
        inventory.packages.push(...(await installed(deps, manager)));
      } catch (error) {
        inventory.problems.push(`${NAMES[manager]}: ${(error as Error).message}. Run it once in a terminal to see why, then refresh.`);
      }
    }),
  );
  inventory.managers.sort((a, b) => managersFor(deps.platform).indexOf(a) - managersFor(deps.platform).indexOf(b));
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
  }
}

export async function search(deps: PackageDeps, query: string, managers: Manager[]): Promise<{ packages: Package[]; problems: string[] }> {
  if (!isSafeQuery(query)) throw new Error('use letters, numbers, spaces and . + @ / - only, and start with a letter or number');
  const packages: Package[] = [];
  const problems: string[] = [];
  await Promise.all(
    managers.map(async (manager) => {
      try {
        packages.push(...(await find(deps, manager, query.trim())).slice(0, SEARCH_LIMIT));
      } catch (error) {
        problems.push(`${NAMES[manager]}: ${(error as Error).message}`);
      }
    }),
  );
  return { packages, problems };
}

function diagnose(manager: Manager, result: ExecResult): Diagnosis {
  const output = `${result.stdout}\n${result.stderr}`;
  if (manager === 'brew') return diagnoseBrew(output);
  if (manager === 'winget') return diagnoseWinget(result.code, output);
  if (manager === 'choco') return diagnoseElevated(result.code, output);
  return diagnoseScoop(output);
}

// One package at a time: installers of different managers must not run side by side.
export async function act(
  deps: PackageDeps,
  action: PackageAction,
  packages: Package[],
  onResult: (result: ActionResult, index: number) => void = () => {},
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  for (const [index, entry] of packages.entries()) {
    const key = packageKey(entry);
    let result: ActionResult;
    try {
      const command = actionCommand(action, entry);
      const output = await deps.exec(command.command, command.args, { timeoutMs: 60 * 60_000, ...(entry.manager === 'brew' ? { env: BREW_ENV } : {}) });
      if (output.code === 0) {
        result = { key, ok: true, reason: '' };
      } else {
        const diagnosis = diagnose(entry.manager, output);
        result = diagnosis.applied ? { key, ok: true, reason: diagnosis.reason } : { key, ok: false, reason: diagnosis.reason, detail: lastLines(output) };
      }
    } catch (error) {
      result = { key, ok: false, reason: (error as Error).message };
    }
    results.push(result);
    onResult(result, index);
  }
  return results;
}
