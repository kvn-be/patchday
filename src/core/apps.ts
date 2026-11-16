// Finding, starting, closing and reopening the program behind a package. Used by the name in the
// lists (it starts the program) and by the rescue after a failed update.
import { psQuote } from './extra.ts';

// ---------- macOS ----------

// A program on macOS: an .app name ("Dropbox.app") or, for casks that only run a .pkg installer,
// the bundle id the cask quits on removal ("bundle:io.tailscale.ipn.macsys").
// From `brew info --cask --json=v2 <token>`: the app artifact, else an /Applications/*.app the
// uninstall step deletes, else that bundle id.
export function parseCaskApps(json: string): string[] {
  try {
    const casks = (JSON.parse(json) as { casks?: Array<{ artifacts?: unknown[] }> }).casks ?? [];
    const artifacts = (casks[0]?.artifacts ?? []) as Array<Record<string, unknown>>;
    const apps: string[] = [];
    for (const artifact of artifacts) {
      const list = artifact?.app;
      if (!Array.isArray(list)) continue;
      // ["Name.app"], or ["Source.app", { target: "Other Name.app" }] when the cask renames it.
      const target = list.find((entry) => typeof (entry as { target?: unknown })?.target === 'string') as { target: string } | undefined;
      const name = target ? target.target : list.find((entry) => typeof entry === 'string');
      if (typeof name === 'string') apps.push(name.split('/').pop() as string);
    }
    const steps = artifacts.flatMap((artifact) => (Array.isArray(artifact?.uninstall) ? artifact.uninstall : [])) as Array<Record<string, unknown>>;
    const list = (value: unknown) => (Array.isArray(value) ? value : [value]).filter((entry): entry is string => typeof entry === 'string');
    for (const step of steps) {
      for (const path of list(step?.delete)) {
        const match = /^\/Applications\/([^/]+\.app)$/i.exec(path);
        if (match) apps.push(match[1]);
      }
    }
    for (const step of steps) for (const id of list(step?.quit)) if (isSafeBundleId(id)) apps.push(`bundle:${id}`);
    return [...new Set(apps)].filter((app) => app.startsWith('bundle:') || (isSafeAppName(app) && !/shim|helper|updater|autoupdate|uninstall/i.test(app)));
  } catch {
    return [];
  }
}

export const isSafeAppName = (name: string) => /^[\w .()+&'-]{1,120}\.app$/i.test(name) && !name.includes('..');
const isSafeBundleId = (id: string) => /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(id) && !/autoupdate|updater|helper|daemon|agent/i.test(id);

// AppleScript string: backslash and quote escaped.
const appleQuote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const bundle = (app: string) => (app.startsWith('bundle:') ? app.slice(7) : null);
const appleTarget = (app: string) => (bundle(app) ? `application id ${appleQuote(bundle(app) as string)}` : `application ${appleQuote(app.replace(/\.app$/i, ''))}`);
export const macLabel = (app: string) => (bundle(app) ?? app).replace(/\.app$/i, '');

export function macOpen(app: string): { command: string; args: string[] } {
  return { command: 'open', args: bundle(app) ? ['-b', bundle(app) as string] : ['-a', app.replace(/\.app$/i, '')] };
}
// Asks the app to quit the normal way, so it can save or ask about open work.
export function macQuit(app: string): { command: string; args: string[] } {
  return { command: 'osascript', args: ['-e', `tell ${appleTarget(app)} to quit`] };
}
// Prints true or false, without starting the app.
export function macRunning(app: string): { command: string; args: string[] } {
  return { command: 'osascript', args: ['-e', `${appleTarget(app)} is running`] };
}

// ---------- Windows ----------

export interface StartApp {
  Name: string;
  AppID: string;
}

export const START_APPS = '@(Get-StartApps | Select-Object Name, AppID) | ConvertTo-Json -Compress';

export function parseStartApps(json: string): StartApp[] {
  const text = json.trim();
  if (!text) return [];
  try {
    return ([] as StartApp[]).concat(JSON.parse(text)).filter((entry) => typeof entry?.Name === 'string' && typeof entry?.AppID === 'string');
  } catch {
    return [];
  }
}

const NOISE = /\b(x64|x86|arm64|64-bit|32-bit|\d+(\.\d+)+|version|uninstall\w*|setup|installer|help|readme|documentation|release notes)\b/gi;
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\(.*?\)/g, ' ').replace(NOISE, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Shortcuts that never are the program itself.
const NOT_THE_APP = /uninstall|deinstall|readme|help|documentation|release notes|website|license|settings|manual/i;

// The Start menu entry for a package: same name first, then one name inside the other, then the
// words of a winget id ("Autodesk.Fusion" finds "Autodesk Fusion").
export function matchStartApp(apps: StartApp[], name: string, id?: string): StartApp | undefined {
  const candidates = apps.filter((app) => !NOT_THE_APP.test(app.Name) && normalizeName(app.Name));
  const wanted = normalizeName(name);
  if (wanted) {
    const exact = candidates.find((app) => normalizeName(app.Name) === wanted);
    if (exact) return exact;
    const starts = candidates.filter((app) => normalizeName(app.Name).startsWith(`${wanted} `) || wanted.startsWith(`${normalizeName(app.Name)} `));
    if (starts.length) return starts.sort((a, b) => a.Name.length - b.Name.length)[0];
  }
  const words = (id ?? '').split(/[.\-_]/).map((word) => word.toLowerCase()).filter((word) => word.length > 1);
  if (words.length < 2) return undefined;
  const all = candidates.filter((app) => {
    const tokens = new Set(normalizeName(app.Name).split(' '));
    return words.slice(1).every((word) => tokens.has(word));
  });
  return all.sort((a, b) => a.Name.length - b.Name.length)[0];
}

export function windowsOpen(app: StartApp): { command: string; args: string[] } {
  return { command: 'explorer.exe', args: [`shell:AppsFolder\\${app.AppID}`] };
}

// The program's folder from its uninstall entry (InstallLocation, else the folder of its icon).
// Matching processes are the ones started from that folder or naming the same product.
function processesOf(name: string): string {
  return [
    `$n = ${psQuote(name)}`,
    "$keys = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
    '$entry = Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and $_.DisplayName -like "$n*" } | Select-Object -First 1',
    '$dir = $null',
    'if ($entry.InstallLocation) { $dir = $entry.InstallLocation.Trim(\'"\').TrimEnd(\'\\\') }',
    'elseif ($entry.DisplayIcon) { $dir = Split-Path ($entry.DisplayIcon -replace \',\\d+$\',\'\').Trim(\'"\') -Parent }',
    '$procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID -and $_.Path -and (($dir -and $_.Path -like "$dir\\*") -or ($_.Product -and $_.Product -like "$n*")) })',
  ].join('; ');
}

// JSON: the windows' program paths, to start them again later.
export function windowsRunningScript(name: string): string {
  return `$ErrorActionPreference='SilentlyContinue'; ${processesOf(name)}; @($procs | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.Path } | Select-Object -Unique) | ConvertTo-Json -Compress`;
}

// Closes the windows the normal way (like clicking X), waits up to 45 s, then reports what is left.
// Nothing is killed: a program that asks about unsaved work stays open.
export function windowsCloseScript(name: string): string {
  return `$ErrorActionPreference='SilentlyContinue'; ${processesOf(name)}; foreach ($p in $procs) { if ($p.MainWindowHandle -ne 0) { [void]$p.CloseMainWindow() } }; $deadline = (Get-Date).AddSeconds(45); while ((Get-Date) -lt $deadline -and @($procs | Where-Object { -not $_.HasExited -and $_.MainWindowHandle -ne 0 }).Count -gt 0) { Start-Sleep -Milliseconds 500; foreach ($p in $procs) { $p.Refresh() } }; @($procs | Where-Object { -not $_.HasExited -and $_.MainWindowHandle -ne 0 }).Count`;
}

export function parsePaths(json: string): string[] {
  const text = json.trim();
  if (!text) return [];
  try {
    return ([] as unknown[]).concat(JSON.parse(text)).filter((path): path is string => typeof path === 'string' && /^[A-Za-z]:\\/.test(path) && /\.exe$/i.test(path));
  } catch {
    return [];
  }
}

// Visual Studio updates through its own installer. These are its documented command lines.
export const VS_INSTALLER = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\setup.exe';
export const VS_WHERE = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
export function parseVsPaths(json: string): string[] {
  try {
    return ([] as Array<{ installationPath?: unknown }>).concat(JSON.parse(json || '[]'))
      .map((entry) => entry.installationPath).filter((path): path is string => typeof path === 'string' && /^[A-Za-z]:\\/.test(path));
  } catch {
    return [];
  }
}
