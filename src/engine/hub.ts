// Details and sources for the package pages.
import { powershellScript, psQuote } from '../core/extra.ts';
import {
  parseBrewInfo, parseChocoInfo, parseCrate, parseNpmView, parseNugetSearch, parsePsModule, parsePypi, parseScoopInfo, parseWingetShow, type Details,
} from '../core/details.ts';
import { isSafeId, wingetTarget, type Package } from '../core/packages.ts';
import { addSourceCall, listSourcesCall, parseSources, removeSourceCall, type Source, type SourceCall, type SourceManager } from '../core/sources.ts';
import { managerCommand, type PackageDeps } from './packages.ts';
import { lastLines } from './run.ts';
import type { ExecResult } from './types.ts';

const TIMEOUT = 2 * 60_000;

function runArgs(deps: PackageDeps, manager: Package['manager'], args: string[]): Promise<ExecResult> {
  const command = managerCommand(deps, manager, args);
  return deps.exec(command.command, command.args, { timeoutMs: TIMEOUT });
}

function runPs(deps: PackageDeps, manager: 'pwsh' | 'winps', script: string): Promise<ExecResult> {
  const command = powershellScript(manager === 'pwsh' ? 'pwsh' : 'powershell', script);
  return deps.exec(deps.executables?.[manager] || command.command, command.args, { timeoutMs: TIMEOUT });
}

async function fetchJson<T>(deps: PackageDeps, url: string, parse: (text: string) => T): Promise<T | null> {
  const text = await deps.fetchText?.(url).catch(() => null);
  if (!text) return null;
  try {
    return parse(text);
  } catch {
    return null;
  }
}

export async function details(deps: PackageDeps, entry: Package): Promise<Details> {
  if (!isSafeId(entry.manager, entry.id)) throw new Error(`${entry.id} is not a valid package name`);
  const id = entry.id;
  switch (entry.manager) {
    case 'brew': {
      const result = await runArgs(deps, 'brew', ['info', '--json=v2', entry.kind === 'cask' ? '--cask' : '--formula', id]);
      return result.code === 0 ? parseBrewInfo(result.stdout) : {};
    }
    case 'winget': {
      const [show, versions] = await Promise.all([runArgs(deps, 'winget', ['show', ...wingetTarget(id)]), runArgs(deps, 'winget', ['show', ...wingetTarget(id), '--versions'])]);
      return parseWingetShow(show.stdout, versions.stdout);
    }
    case 'choco': {
      const [info, versions] = await Promise.all([runArgs(deps, 'choco', ['info', id]), runArgs(deps, 'choco', ['search', id, '--exact', '--all-versions', '--limit-output'])]);
      const parsed = parseChocoInfo(info.stdout);
      const list = versions.stdout.replace(/\r/g, '').split('\n').map((line) => line.split('|')[1]).filter(Boolean);
      return list.length ? { ...parsed, versions: list.slice(0, 100) } : parsed;
    }
    case 'scoop':
      return parseScoopInfo((await runArgs(deps, 'scoop', ['info', id])).stdout);
    case 'pip':
      return (await fetchJson(deps, `https://pypi.org/pypi/${encodeURIComponent(id)}/json`, parsePypi)) ?? {};
    case 'npm': {
      const result = await runArgs(deps, 'npm', ['view', id, '--json']);
      try {
        return result.stdout.trim().startsWith('{') ? parseNpmView(result.stdout) : {};
      } catch {
        return {};
      }
    }
    case 'dotnet':
      return (await fetchJson(deps, `https://azuresearch-usnc.nuget.org/query?q=packageid:${encodeURIComponent(id)}&prerelease=false&take=1`, parseNugetSearch)) ?? {};
    case 'pwsh': case 'winps': {
      const name = psQuote(id);
      const [info, versions] = await Promise.all([
        runPs(deps, entry.manager, `$ErrorActionPreference='SilentlyContinue'; Find-Module -Name ${name} | Select-Object Name,Version,Description,Author,CompanyName,ProjectUri,LicenseUri,ReleaseNotes,Tags | ConvertTo-Json -Compress`),
        runPs(deps, entry.manager, `$ErrorActionPreference='SilentlyContinue'; @(Find-Module -Name ${name} -AllVersions | ForEach-Object { $_.Version.ToString() }) | ConvertTo-Json -Compress`),
      ]);
      try {
        return parsePsModule(info.stdout, versions.stdout);
      } catch {
        return {};
      }
    }
    case 'cargo':
      return (await fetchJson(deps, `https://crates.io/api/v1/crates/${encodeURIComponent(id)}`, parseCrate)) ?? {};
    case 'vcpkg': {
      const line = (await runArgs(deps, 'vcpkg', ['search', id.split(':')[0].split('[')[0]])).stdout.split('\n').find((row) => row.startsWith(`${id.split(':')[0]} `));
      const description = line?.replace(/^\S+\s+\S+\s*/, '').trim();
      return description ? { description } : {};
    }
  }
}

// ---------- Sources ----------

function runSource(deps: PackageDeps, manager: SourceManager, call: SourceCall): Promise<ExecResult> {
  if (call.kind === 'ps') return runPs(deps, manager as 'pwsh' | 'winps', call.script);
  // winget's source commands take only some of the usual flags, so they get none.
  const command = manager === 'winget' ? { command: deps.executables?.winget || 'winget', args: call.args } : managerCommand(deps, manager, call.args);
  if (call.kind === 'elevated' && deps.platform === 'win32') {
    const list = command.args.map((arg) => psQuote(arg)).join(',');
    const script = `$p = Start-Process -FilePath ${psQuote(command.command)} -ArgumentList ${list} -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`;
    const elevated = powershellScript('powershell', script);
    return deps.exec(elevated.command, elevated.args, { timeoutMs: 10 * 60_000 });
  }
  return deps.exec(command.command, command.args, { timeoutMs: 10 * 60_000 });
}

export async function listSources(deps: PackageDeps, manager: SourceManager): Promise<Source[]> {
  const result = await runSource(deps, manager, listSourcesCall(manager));
  if (result.code !== 0) throw new Error(`${manager} could not list its sources`);
  return parseSources(manager, result.stdout);
}

export async function changeSource(deps: PackageDeps, manager: SourceManager, change: 'add' | 'remove', name: string, url = ''): Promise<void> {
  const call = change === 'add' ? addSourceCall(manager, name.trim(), url.trim()) : removeSourceCall(manager, name.trim());
  const result = await runSource(deps, manager, call);
  if (result.code !== 0) throw new Error(lastLines(result) || `${manager} refused the change`);
}
