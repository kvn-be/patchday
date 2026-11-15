// Package sources: Homebrew taps, Scoop buckets, winget and Chocolatey sources, PowerShell repositories.
import { psQuote } from './extra.ts';
import { parseColumns } from './table.ts';
import type { Manager } from './packages.ts';

export type SourceManager = 'brew' | 'winget' | 'choco' | 'scoop' | 'pwsh' | 'winps';
export const SOURCE_MANAGERS: SourceManager[] = ['brew', 'winget', 'choco', 'scoop', 'pwsh', 'winps'];
export const hasSources = (manager: Manager): manager is SourceManager => (SOURCE_MANAGERS as Manager[]).includes(manager);

export interface Source {
  name: string;
  url: string;
  // Sources the manager ships with; removing them is allowed, but asked twice.
  builtIn?: boolean;
}

const SOURCE_NAME = /^[A-Za-z0-9][\w.@/-]{0,99}$/;
export const isSafeSourceName = (name: string) => SOURCE_NAME.test(name) && !name.includes('..');
export function isSafeSourceUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !/[\s"'`$;&|<>]/.test(url);
  } catch {
    return false;
  }
}

export function parseBrewTaps(output: string): Source[] {
  return output.split('\n').map((line) => line.trim()).filter((line) => isSafeSourceName(line))
    .map((name) => ({ name, url: `https://github.com/${name.split('/')[0]}/homebrew-${name.split('/')[1] ?? ''}`, builtIn: name === 'homebrew/core' || name === 'homebrew/cask' }));
}

export function parseWingetSources(output: string): Source[] {
  return parseColumns(output, [{ key: 'name', label: /^/ }, { key: 'url', label: /\bArgument\b|\bArgumente?\b/, required: true }, { key: 'explicit', label: /\bExplicit\b/ }])
    .filter((row) => isSafeSourceName(row.name))
    .map((row) => ({ name: row.name, url: row.url, builtIn: ['winget', 'msstore', 'winget-font'].includes(row.name) }));
}

// `choco source list --limit-output`: name|url|disabled|user|cert|priority|...
export function parseChocoSources(output: string): Source[] {
  return output.replace(/\r/g, '').split('\n').map((line) => line.split('|')).filter((fields) => fields.length >= 2 && isSafeSourceName(fields[0]))
    .map((fields) => ({ name: fields[0], url: fields[1], builtIn: fields[0] === 'chocolatey' }));
}

// `scoop bucket list`: Name, Source, Updated, Manifests.
export function parseScoopBuckets(output: string): Source[] {
  return parseColumns(output, [{ key: 'name', label: /^/ }, { key: 'url', label: /\bSource\b/, required: true }, { key: 'updated', label: /\bUpdated\b/ }])
    .filter((row) => isSafeSourceName(row.name)).map((row) => ({ name: row.name, url: row.url, builtIn: row.name === 'main' }));
}

export function parsePsRepositories(json: string): Source[] {
  const text = json.trim();
  if (!text) return [];
  return ([] as Array<{ Name?: string; SourceLocation?: string }>).concat(JSON.parse(text))
    .filter((row) => typeof row.Name === 'string' && isSafeSourceName(row.Name))
    .map((row) => ({ name: row.Name as string, url: row.SourceLocation ?? '', builtIn: row.Name === 'PSGallery' }));
}

export const PS_REPOSITORIES = "$ErrorActionPreference='SilentlyContinue'; @(Get-PSRepository | ForEach-Object { [pscustomobject]@{ Name = $_.Name; SourceLocation = $_.SourceLocation } }) | ConvertTo-Json -Compress";

export type SourceCall = { kind: 'run'; args: string[] } | { kind: 'ps'; script: string } | { kind: 'elevated'; args: string[] };

export function listSourcesCall(manager: SourceManager): SourceCall {
  switch (manager) {
    case 'brew': return { kind: 'run', args: ['tap'] };
    case 'winget': return { kind: 'run', args: ['source', 'list'] };
    case 'choco': return { kind: 'run', args: ['source', 'list', '--limit-output'] };
    case 'scoop': return { kind: 'run', args: ['bucket', 'list'] };
    case 'pwsh': case 'winps': return { kind: 'ps', script: PS_REPOSITORIES };
  }
}

export function parseSources(manager: SourceManager, output: string): Source[] {
  switch (manager) {
    case 'brew': return parseBrewTaps(output);
    case 'winget': return parseWingetSources(output);
    case 'choco': return parseChocoSources(output);
    case 'scoop': return parseScoopBuckets(output);
    case 'pwsh': case 'winps': return parsePsRepositories(output);
  }
}

// Adding needs a name; a URL is optional for taps and buckets and required for the rest.
export function addSourceCall(manager: SourceManager, name: string, url: string): SourceCall {
  if (!isSafeSourceName(name)) throw new Error('use letters, numbers and . _ - / @ for the name');
  if (url && !isSafeSourceUrl(url)) throw new Error('the address must start with https://');
  if (!url && (manager === 'winget' || manager === 'choco' || manager === 'pwsh' || manager === 'winps')) throw new Error('this manager needs the address of the source');
  switch (manager) {
    case 'brew': return { kind: 'run', args: ['tap', name, ...(url ? [url] : [])] };
    // Adding winget sources needs admin rights.
    case 'winget': return { kind: 'elevated', args: ['source', 'add', '--name', name, '--arg', url, '--accept-source-agreements'] };
    case 'choco': return { kind: 'elevated', args: ['source', 'add', `--name=${name}`, `--source=${url}`] };
    case 'scoop': return { kind: 'run', args: ['bucket', 'add', name, ...(url ? [url] : [])] };
    case 'pwsh': case 'winps': return { kind: 'ps', script: `$ErrorActionPreference='Stop'; Register-PSRepository -Name ${psQuote(name)} -SourceLocation ${psQuote(url)} -InstallationPolicy Trusted` };
  }
}

export function removeSourceCall(manager: SourceManager, name: string): SourceCall {
  if (!isSafeSourceName(name)) throw new Error('unknown source');
  switch (manager) {
    case 'brew': return { kind: 'run', args: ['untap', name] };
    case 'winget': return { kind: 'elevated', args: ['source', 'remove', '--name', name] };
    case 'choco': return { kind: 'elevated', args: ['source', 'remove', `--name=${name}`] };
    case 'scoop': return { kind: 'run', args: ['bucket', 'rm', name] };
    case 'pwsh': case 'winps': return { kind: 'ps', script: `$ErrorActionPreference='Stop'; Unregister-PSRepository -Name ${psQuote(name)}` };
  }
}
