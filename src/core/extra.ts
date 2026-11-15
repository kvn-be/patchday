// Package managers for developer tools: pip, npm, .NET tools, PowerShell modules, Cargo and vcpkg.
// Parsers take the managers' own output; command builders never go through a shell with unchecked text.
import { parseColumns } from './table.ts';

export type ExtraManager = 'pip' | 'npm' | 'dotnet' | 'pwsh' | 'winps' | 'cargo' | 'vcpkg';

export interface ExtraPackage {
  manager: ExtraManager;
  id: string;
  name: string;
  version: string;
  available?: string;
  description?: string;
}

// ---------- Safe names ----------

const PIP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NPM = /^(?:@[a-z0-9][\w.~-]{0,63}\/)?[a-z0-9][\w.~-]{0,127}$/;
const NUGET = /^[A-Za-z0-9][\w.-]{0,127}$/;
const CARGO = /^[A-Za-z0-9][\w-]{0,63}$/;
const VCPKG = /^[a-z0-9][a-z0-9-]{0,63}(?:\[[a-z0-9,-]{1,128}\])?(?::[a-z0-9-]{1,64})?$/;
// Versions given by the user or a bundle: digits, letters and . + - ~ _ only.
export const SAFE_VERSION = /^[\w.+~-]{1,64}$/;

export function isSafeExtraId(manager: ExtraManager, id: string): boolean {
  switch (manager) {
    case 'pip': return PIP.test(id);
    case 'npm': return NPM.test(id);
    case 'dotnet': case 'pwsh': case 'winps': return NUGET.test(id);
    case 'cargo': return CARGO.test(id);
    case 'vcpkg': return VCPKG.test(id);
  }
}

const asArray = <T>(value: T | T[] | null | undefined): T[] => (Array.isArray(value) ? value : value == null ? [] : [value]);
const lines = (output: string) => output.replace(/\r/g, '').split('\n');

// ---------- pip ----------

// `python -m pip list --format=json`, and the same with --outdated (adds latest_version).
export function parsePipList(json: string, outdatedJson = '[]'): ExtraPackage[] {
  const rows = asArray(JSON.parse(json || '[]') as Array<{ name: string; version: string }>);
  const newer = new Map(asArray(JSON.parse(outdatedJson || '[]') as Array<{ name: string; latest_version?: string }>).map((row) => [row.name.toLowerCase(), row.latest_version ?? '']));
  return rows.filter((row) => PIP.test(row.name)).map((row) => {
    const latest = newer.get(row.name.toLowerCase());
    return { manager: 'pip', id: row.name, name: row.name, version: row.version, ...(latest && latest !== row.version ? { available: latest } : {}) };
  });
}

// PyPI answers https://pypi.org/pypi/<name>/json; pip itself can no longer search.
export function parsePypiProject(json: string): ExtraPackage | null {
  const info = (JSON.parse(json) as { info?: { name?: string; version?: string; summary?: string } }).info;
  if (!info?.name || !PIP.test(info.name)) return null;
  return { manager: 'pip', id: info.name, name: info.name, version: info.version ?? '', ...(info.summary ? { description: info.summary } : {}) };
}

// ---------- npm ----------

// `npm ls -g --json --depth=0` and `npm outdated -g --json` (exit code 1 when something is outdated).
export function parseNpmList(json: string, outdatedJson = '{}'): ExtraPackage[] {
  const deps = (JSON.parse(json || '{}') as { dependencies?: Record<string, { version?: string }> }).dependencies ?? {};
  const outdated = JSON.parse(outdatedJson || '{}') as Record<string, { current?: string; latest?: string }>;
  return Object.entries(deps).filter(([id]) => NPM.test(id)).map(([id, info]) => {
    const version = info.version ?? '';
    const latest = outdated[id]?.latest;
    return { manager: 'npm', id, name: id, version, ...(latest && latest !== version ? { available: latest } : {}) };
  });
}

export function parseNpmSearch(json: string): ExtraPackage[] {
  return asArray(JSON.parse(json || '[]') as Array<{ name: string; version?: string; description?: string }>)
    .filter((row) => NPM.test(row.name))
    .map((row) => ({ manager: 'npm', id: row.name, name: row.name, version: row.version ?? '', ...(row.description ? { description: row.description } : {}) }));
}

// ---------- .NET tools ----------

// `dotnet tool list --global`: Package Id, Version, Commands.
export function parseDotnetList(output: string): ExtraPackage[] {
  return parseColumns(output, [
    { key: 'id', label: /^/ },
    { key: 'version', label: /\bVersion\b/, required: true },
    { key: 'commands', label: /\bCommands\b/ },
  ]).filter((row) => NUGET.test(row.id)).map((row) => ({ manager: 'dotnet', id: row.id, name: row.id, version: row.version }));
}

// `dotnet tool search <query>`: Package ID, Latest Version, Authors, Downloads, Verified.
export function parseDotnetSearch(output: string): ExtraPackage[] {
  return parseColumns(output, [
    { key: 'id', label: /^/ },
    { key: 'version', label: /\bLatest Version\b|\bVersion\b/, required: true },
    { key: 'authors', label: /\bAuthors\b/ },
    { key: 'downloads', label: /\bDownloads\b/ },
  ]).filter((row) => NUGET.test(row.id)).map((row) => ({ manager: 'dotnet', id: row.id, name: row.id, version: row.version }));
}

// The NuGet flat container lists every version, oldest first: {"versions": [...]}.
export function latestNugetVersion(json: string, prerelease = false): string {
  const versions = (JSON.parse(json) as { versions?: string[] }).versions ?? [];
  const usable = prerelease ? versions : versions.filter((version) => !version.includes('-'));
  return usable.at(-1) ?? '';
}

// ---------- PowerShell modules ----------

// Scripts print JSON with ConvertTo-Json, which writes one object instead of a list of one.
export function parsePsModules(json: string, manager: 'pwsh' | 'winps'): ExtraPackage[] {
  const text = json.trim();
  if (!text) return [];
  return asArray(JSON.parse(text) as Array<{ Name: string; Version: string | { ToString?: string }; Latest?: string; Description?: string }>)
    .filter((row) => typeof row.Name === 'string' && NUGET.test(row.Name))
    .map((row) => {
      const version = typeof row.Version === 'string' ? row.Version : String(row.Version ?? '');
      return {
        manager, id: row.Name, name: row.Name, version,
        ...(row.Latest && row.Latest !== version ? { available: row.Latest } : {}),
        ...(row.Description ? { description: row.Description.slice(0, 300) } : {}),
      };
    });
}

// ---------- Cargo ----------

// `cargo install --list`: "name v1.2.3:" followed by indented binaries.
export function parseCargoList(output: string): ExtraPackage[] {
  const packages: ExtraPackage[] = [];
  for (const line of lines(output)) {
    const match = /^([A-Za-z0-9][\w-]*) v([^\s:]+)(?: \([^)]*\))?:$/.exec(line.trim() === line ? line : '');
    if (match && CARGO.test(match[1])) packages.push({ manager: 'cargo', id: match[1], name: match[1], version: match[2] });
  }
  return packages;
}

// `cargo search <query>`: name = "1.2.3"    # description
export function parseCargoSearch(output: string): ExtraPackage[] {
  const packages: ExtraPackage[] = [];
  for (const line of lines(output)) {
    const match = /^([A-Za-z0-9][\w-]*) = "([^"]+)"\s*(?:#\s*(.*))?$/.exec(line.trim());
    if (match && CARGO.test(match[1])) packages.push({ manager: 'cargo', id: match[1], name: match[1], version: match[2], ...(match[3] ? { description: match[3].trim() } : {}) });
  }
  return packages;
}

// crates.io: {"crate": {"max_stable_version": "...", "max_version": "...", "description": "..."}}
export function latestCrateVersion(json: string): string {
  const crate = (JSON.parse(json) as { crate?: { max_stable_version?: string | null; max_version?: string } }).crate;
  return crate?.max_stable_version ?? crate?.max_version ?? '';
}

// ---------- vcpkg ----------

// `vcpkg list`: "zlib:x64-windows   1.3.1   A compression library"
export function parseVcpkgList(output: string): ExtraPackage[] {
  const packages: ExtraPackage[] = [];
  for (const line of lines(output)) {
    const match = /^(\S+)\s+(\S+)\s*(.*)$/.exec(line.trim());
    if (!match || !VCPKG.test(match[1])) continue;
    packages.push({ manager: 'vcpkg', id: match[1], name: match[1].split(':')[0], version: match[2], ...(match[3] ? { description: match[3].trim() } : {}) });
  }
  return packages;
}

// `vcpkg search <query>`: "zlib   1.3.1   A compression library"; features show as "zlib[feature]".
export function parseVcpkgSearch(output: string): ExtraPackage[] {
  return parseVcpkgList(output).filter((entry) => !entry.id.includes('[') && !entry.id.includes(':'));
}

// `vcpkg x-update-baseline --dry-run` is not stable; `vcpkg update` prints "name:triplet  1.0 -> 1.1".
export function parseVcpkgUpdate(output: string): Map<string, string> {
  const newer = new Map<string, string>();
  for (const line of lines(output)) {
    const match = /^\s*(\S+)\s+(\S+)\s+->\s+(\S+)\s*$/.exec(line);
    if (match && VCPKG.test(match[1])) newer.set(match[1], match[3]);
  }
  return newer;
}

// ---------- Commands ----------

export interface ExtraCommand {
  command: string;
  args: string[];
}

export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function powershellScript(executable: 'powershell' | 'pwsh', script: string): ExtraCommand {
  return {
    command: executable,
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  };
}

// npm is a .cmd file on Windows, which Node only starts through a shell, so PowerShell runs it with quoted arguments.
export function npmCommand(args: string[], platform: NodeJS.Platform, executable = 'npm'): ExtraCommand {
  if (platform !== 'win32') return { command: executable, args };
  return powershellScript('powershell', `& ${psQuote(executable)} ${args.map(psQuote).join(' ')}; exit $LASTEXITCODE`);
}

export function pythonExecutable(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'python' : 'python3';
}

export const PS_LIST = `$ErrorActionPreference='SilentlyContinue'; $ProgressPreference='SilentlyContinue'
@(Get-InstalledModule | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Version = $_.Version.ToString() } }) | ConvertTo-Json -Compress`;

// Asks the gallery once for every installed module, like the update check of PowerShellGet does.
export const PS_OUTDATED = `$ErrorActionPreference='SilentlyContinue'; $ProgressPreference='SilentlyContinue'
$installed = @(Get-InstalledModule)
$latest = @{}; if ($installed.Count) { Find-Module -Name ($installed.Name) | ForEach-Object { $latest[$_.Name] = $_.Version.ToString() } }
@($installed | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Version = $_.Version.ToString(); Latest = $latest[$_.Name] } }) | ConvertTo-Json -Compress`;

export function psSearch(query: string): string {
  return `$ErrorActionPreference='SilentlyContinue'; $ProgressPreference='SilentlyContinue'
@(Find-Module -Name ${psQuote(`*${query}*`)} | Select-Object -First 50 | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Version = $_.Version.ToString(); Description = $_.Description } }) | ConvertTo-Json -Compress`;
}
