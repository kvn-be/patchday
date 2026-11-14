import { parseColumns, type Column } from './table.ts';

export type Manager = 'brew' | 'winget' | 'choco' | 'scoop';
export const MANAGERS: Manager[] = ['brew', 'winget', 'choco', 'scoop'];
export type PackageAction = 'install' | 'uninstall' | 'update';

export interface Package {
  manager: Manager;
  id: string;
  name: string;
  version: string;
  // Set when a newer version is known.
  available?: string;
  // Homebrew only: formula or cask.
  kind?: 'formula' | 'cask';
  description?: string;
}

export interface Command {
  command: string;
  args: string[];
}

// ---------- Safety ----------

// Ids reach package managers as single arguments, never through a shell. They still may not look
// like an option, and for PowerShell they must not contain anything but plain name characters.
const PLAIN = /^[A-Za-z0-9][\w.+-]{0,127}$/;
const WINGET = /^[^\s\-"'`$;&|<>][^\s"'`$;&|<>]{0,255}$/;
const BREW = /^[a-z0-9][\w.+@/-]{0,127}$/i;
const SCOOP = /^(?:[A-Za-z0-9][\w.-]{0,63}\/)?[A-Za-z0-9][\w.+-]{0,127}$/;

export function isSafeId(manager: Manager, id: string): boolean {
  if (manager === 'winget') return WINGET.test(id);
  if (manager === 'brew') return BREW.test(id) && !id.includes('..');
  if (manager === 'scoop') return SCOOP.test(id);
  return PLAIN.test(id);
}

export function isSafeQuery(query: string): boolean {
  return /^[A-Za-z0-9][\w .+@/-]{0,63}$/.test(query.trim());
}

export function packageKey(entry: Pick<Package, 'manager' | 'id'>): string {
  return `${entry.manager}:${entry.id}`;
}

// ---------- Homebrew ----------

interface BrewFormula {
  name: string;
  desc?: string | null;
  versions?: { stable?: string | null };
  installed?: Array<{ version: string }>;
  outdated?: boolean;
}
interface BrewCask {
  token: string;
  name?: string[];
  desc?: string | null;
  version: string;
  installed?: string | null;
  outdated?: boolean;
}

// From `brew info --json=v2 --installed`.
export function parseBrewInstalled(json: string): Package[] {
  const { formulae = [], casks = [] } = JSON.parse(json) as { formulae?: BrewFormula[]; casks?: BrewCask[] };
  const packages: Package[] = [];
  for (const formula of formulae) {
    const version = formula.installed?.at(-1)?.version ?? '';
    const latest = formula.versions?.stable ?? '';
    packages.push({
      manager: 'brew', kind: 'formula', id: formula.name, name: formula.name, version,
      ...(formula.outdated && latest && latest !== version ? { available: latest } : {}),
      ...(formula.desc ? { description: formula.desc } : {}),
    });
  }
  for (const cask of casks) {
    const version = cask.installed ?? '';
    packages.push({
      manager: 'brew', kind: 'cask', id: cask.token, name: cask.name?.[0] ?? cask.token, version,
      ...(cask.outdated && cask.version !== version ? { available: cask.version } : {}),
      ...(cask.desc ? { description: cask.desc } : {}),
    });
  }
  return packages;
}

// `brew search --formula` or `--cask` prints one name per line when it writes into a pipe.
export function parseBrewSearch(output: string, kind: 'formula' | 'cask'): Package[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('==>') && BREW.test(line))
    .map((id) => ({ manager: 'brew', kind, id, name: id, version: '' }));
}

// ---------- winget ----------

const WINGET_ID: Column = { key: 'id', label: /\bId\b|\bID\b/, required: true };
const WINGET_VERSION: Column = { key: 'version', label: /\bVersion\b/, required: true };
const WINGET_AVAILABLE: Column = { key: 'available', label: /\bAvailable\b|\bVerfügbar\b/ };
const WINGET_MATCH: Column = { key: 'match', label: /\bMatch\b|\bÜbereinstimmung\b/ };
const WINGET_SOURCE: Column = { key: 'source', label: /\bSource\b|\bQuelle\b/ };

// winget shortens long ids in its tables. A shortened id cannot match exactly, so it is matched by prefix.
export function wingetTarget(id: string): string[] {
  const short = id.replace(/(…|\.\.\.|�+|\?)$/, '');
  return short === id ? ['--id', id, '--exact'] : ['--id', short];
}

function wingetRows(output: string, columns: Column[]): Record<string, string>[] {
  return parseColumns(output, [{ key: 'name', label: /^/ }, ...columns]).filter((row) => row.name && row.id && !/\s/.test(row.id));
}

// From `winget list`. Apps without a source were not installed through winget, but can still be removed.
export function parseWingetList(output: string): Package[] {
  return wingetRows(output, [WINGET_ID, WINGET_VERSION, WINGET_AVAILABLE, WINGET_SOURCE]).map((row) => ({
    manager: 'winget', id: row.id, name: row.name, version: row.version,
    ...(row.available && /\d/.test(row.available) ? { available: row.available } : {}),
  }));
}

// From `winget search <query>`.
export function parseWingetSearch(output: string): Package[] {
  return wingetRows(output, [WINGET_ID, WINGET_VERSION, WINGET_MATCH, WINGET_SOURCE]).map((row) => ({
    manager: 'winget', id: row.id, name: row.name, version: row.version,
  }));
}

// ---------- Chocolatey ----------

// `choco list --limit-output` and `choco search --limit-output` print name|version.
export function parseChocoPairs(output: string): Package[] {
  const packages: Package[] = [];
  for (const line of output.replace(/\r/g, '').split('\n')) {
    const fields = line.trim().split('|');
    if (fields.length !== 2 || !PLAIN.test(fields[0])) continue;
    packages.push({ manager: 'choco', id: fields[0], name: fields[0], version: fields[1] });
  }
  return packages;
}

// ---------- Scoop ----------

// From `scoop export`: JSON in current Scoop, one "name (v:1.0) [bucket]" line in older versions.
export function parseScoopExport(output: string): Package[] {
  try {
    const { apps = [] } = JSON.parse(output) as { apps?: Array<{ Name: string; Version: string; Source?: string }> };
    return apps.filter((app) => SCOOP.test(app.Name)).map((app) => ({ manager: 'scoop', id: app.Name, name: app.Name, version: app.Version ?? '' }));
  } catch {
    const packages: Package[] = [];
    for (const line of output.replace(/\r/g, '').split('\n')) {
      const match = /^\s*(\S+) \(v:([^)]+)\)/.exec(line);
      if (match && SCOOP.test(match[1])) packages.push({ manager: 'scoop', id: match[1], name: match[1], version: match[2] });
    }
    return packages;
  }
}

// From `scoop status`: apps with a newer version.
export function parseScoopStatus(output: string): Array<{ id: string; installed: string; available: string }> {
  return parseColumns(output, [
    { key: 'name', label: /^/ },
    { key: 'installed', label: /\bInstalled Version\b/, required: true },
    { key: 'latest', label: /\bLatest Version\b/, required: true },
    { key: 'missing', label: /\bMissing Dependencies\b/ },
    { key: 'info', label: /\bInfo\b/ },
  ])
    .filter((row) => SCOOP.test(row.name) && row.latest && row.latest !== row.installed)
    .map((row) => ({ id: row.name, installed: row.installed, available: row.latest }));
}

// From `scoop search <query>`.
export function parseScoopSearch(output: string): Package[] {
  return parseColumns(output, [
    { key: 'name', label: /^/ },
    { key: 'version', label: /\bVersion\b/, required: true },
    { key: 'source', label: /\bSource\b/ },
    { key: 'binaries', label: /\bBinaries\b/ },
  ])
    .filter((row) => SCOOP.test(row.name))
    .map((row) => ({ manager: 'scoop', id: row.source ? `${row.source}/${row.name}` : row.name, name: row.name, version: row.version }));
}

// ---------- Commands ----------

export const WINGET_FLAGS = ['--accept-source-agreements', '--disable-interactivity'];

function powershell(script: string): Command {
  return { command: 'powershell', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
}

// Scoop is a PowerShell script. Every value is checked by isSafeId or isSafeQuery and quoted again here.
export function scoopCommand(args: string[]): Command {
  const quoted = args.map((arg) => `'${arg.replace(/'/g, "''")}'`).join(' ');
  return powershell(`& scoop ${quoted}; exit $LASTEXITCODE`);
}

// Chocolatey needs admin rights to change packages, so Windows asks for every change.
export function elevatedChoco(args: string[]): Command {
  const list = args.map((arg) => `'${arg.replace(/'/g, "''")}'`).join(',');
  return powershell(`$p = Start-Process -FilePath choco.exe -ArgumentList ${list} -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`);
}

export function actionCommand(action: PackageAction, entry: Pick<Package, 'manager' | 'id' | 'kind'>): Command {
  if (!isSafeId(entry.manager, entry.id)) throw new Error(`${entry.id} is not a valid package name`);
  switch (entry.manager) {
    case 'brew': {
      const kind = entry.kind === 'cask' ? '--cask' : '--formula';
      if (action === 'update') return { command: 'brew', args: ['upgrade', kind, ...(entry.kind === 'cask' ? ['--greedy'] : []), entry.id] };
      return { command: 'brew', args: [action, kind, entry.id] };
    }
    case 'winget': {
      const verb = action === 'update' ? 'upgrade' : action;
      const agree = action === 'uninstall' ? [] : ['--accept-package-agreements'];
      return { command: 'winget', args: [verb, ...wingetTarget(entry.id), '--silent', ...agree, ...WINGET_FLAGS] };
    }
    case 'choco': {
      const verb = action === 'update' ? 'upgrade' : action;
      return elevatedChoco([verb, entry.id, '-y', '--no-progress']);
    }
    case 'scoop':
      return scoopCommand([action, entry.id]);
  }
}

// ---------- Repair ----------

export interface RepairPlan {
  // Drops cached downloads and fetches the package again; checksums are still verified.
  clean: Command[];
  // Removes the package and installs the current version fresh. Settings of most apps stay.
  reinstall: Command[];
}

export function repairPlan(entry: Pick<Package, 'manager' | 'id' | 'kind'>): RepairPlan {
  if (!isSafeId(entry.manager, entry.id)) throw new Error(`${entry.id} is not a valid package name`);
  switch (entry.manager) {
    case 'brew': {
      const kind = entry.kind === 'cask' ? '--cask' : '--formula';
      return {
        clean: [{ command: 'brew', args: ['fetch', '--force', kind, entry.id] }],
        reinstall: [{ command: 'brew', args: ['reinstall', kind, entry.id] }],
      };
    }
    case 'winget': {
      const target = wingetTarget(entry.id);
      return {
        clean: [{ command: 'winget', args: ['source', 'update'] }],
        reinstall: [
          { command: 'winget', args: ['uninstall', ...target, '--silent', ...WINGET_FLAGS] },
          { command: 'winget', args: ['install', ...target, '--silent', '--accept-package-agreements', ...WINGET_FLAGS] },
        ],
      };
    }
    case 'choco':
      return {
        clean: [elevatedChoco(['cache', 'remove', '-y'])],
        reinstall: [elevatedChoco(['install', entry.id, '-y', '--force', '--no-progress'])],
      };
    case 'scoop':
      return {
        clean: [scoopCommand(['cache', 'rm', entry.id.split('/').pop() as string])],
        reinstall: [scoopCommand(['uninstall', entry.id.split('/').pop() as string]), scoopCommand(['install', entry.id])],
      };
  }
}

// ---------- Export and import ----------

export interface PackageList {
  format: 'patchday-packages';
  version: 1;
  exported: string;
  packages: Array<Pick<Package, 'manager' | 'id' | 'name'> & { kind?: Package['kind'] }>;
}

export function exportList(packages: Package[], now: Date): PackageList {
  return {
    format: 'patchday-packages',
    version: 1,
    exported: now.toISOString(),
    packages: packages.map((entry) => ({ manager: entry.manager, id: entry.id, name: entry.name, ...(entry.kind ? { kind: entry.kind } : {}) })),
  };
}

// Anything that is not a known manager with a safe id is dropped and counted.
export function importList(text: string): { packages: Package[]; skipped: number } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('the file is not a Patchday package list');
  }
  const list = data as Partial<PackageList>;
  if (list?.format !== 'patchday-packages' || !Array.isArray(list.packages)) throw new Error('the file is not a Patchday package list');
  const seen = new Set<string>();
  const packages: Package[] = [];
  let skipped = 0;
  for (const raw of list.packages) {
    const entry = raw as Partial<Package>;
    const manager = entry.manager as Manager;
    const valid = MANAGERS.includes(manager) && typeof entry.id === 'string' && isSafeId(manager, entry.id)
      && (entry.kind === undefined || entry.kind === 'formula' || entry.kind === 'cask');
    if (!valid || seen.has(packageKey({ manager, id: entry.id as string }))) {
      skipped++;
      continue;
    }
    seen.add(packageKey({ manager, id: entry.id as string }));
    const name = typeof entry.name === 'string' && entry.name.length <= 200 ? entry.name : (entry.id as string);
    packages.push({ manager, id: entry.id as string, name, version: '', ...(entry.kind ? { kind: entry.kind } : {}) });
  }
  return { packages, skipped };
}

// ---------- Skipped versions ----------

// A skipped version stays hidden until an even newer version appears.
export function isSkipped(skipped: Record<string, string>, entry: Pick<Package, 'manager' | 'id'>, available: string): boolean {
  return skipped[packageKey(entry)] === available;
}
