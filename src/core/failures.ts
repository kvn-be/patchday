export type Fix = 'retry' | 'wait-retry' | 'refresh-retry' | 'force-retry';

export interface Diagnosis {
  reason: string;
  fix?: Fix;
  // The install worked, but needs something else to finish.
  applied?: boolean;
  // A fresh install would not help: rights, policy, space, a running app or a decision by the user.
  final?: boolean;
}

const UNKNOWN = 'installer stopped with an error';
const PATH_PROBLEM: Diagnosis = { reason: 'a folder of the installed app is missing', fix: 'force-retry' };
const PATH_TEXT = /cannot find the path|path not found|path specified|invalid path|Pfad nicht|angegebene Pfad|Pfad ist/i;

function hex(code: number): string {
  return `0x${(code >>> 0).toString(16).toUpperCase()}`;
}

// From winget's return code documentation.
const WINGET: Record<number, Diagnosis> = {
  0x8a150010: { reason: 'no installer for this system', final: true },
  0x8a150011: { reason: 'download did not match its checksum', fix: 'refresh-retry' },
  0x8a150019: { reason: 'needs administrator rights', final: true },
  0x8a15002b: { reason: 'no update path from the installed version', fix: 'force-retry' },
  0x8a15003a: { reason: 'blocked by a Group Policy', final: true },
  0x8a15004f: { reason: 'installed version is already newer', applied: true },
  0x8a150050: { reason: 'installed version is unknown' },
  0x8a150056: { reason: 'installer refuses to run as administrator' },
  0x8a150068: { reason: 'pinned in winget', final: true },
  0x8a15006b: { reason: 'dependencies could not be downloaded', fix: 'retry' },
  0x8a150086: { reason: 'download was empty', fix: 'retry' },
  0x8a15008e: { reason: 'new version uses a different installer, reinstall it once' },
  0x8a150101: { reason: 'app is running, close it', fix: 'wait-retry' },
  0x8a150102: { reason: 'another installation is running', fix: 'wait-retry' },
  0x8a150103: { reason: 'files are in use, close the app', fix: 'wait-retry' },
  0x8a150104: { reason: 'a required component is missing' },
  0x8a150105: { reason: 'disk is full', final: true },
  0x8a150106: { reason: 'not enough memory', final: true },
  0x8a150107: { reason: 'no internet connection', fix: 'wait-retry' },
  0x8a150109: { reason: 'restart to finish', applied: true },
  0x8a15010a: { reason: 'restart Windows, then it updates', final: true },
  0x8a15010b: { reason: 'Windows restarts to finish', applied: true },
  0x8a15010c: { reason: 'installation was cancelled', final: true },
  0x8a15010d: { reason: 'another version is already installed' },
  0x8a15010e: { reason: 'a newer version is already installed', applied: true },
  0x8a15010f: { reason: 'blocked by your organization', final: true },
  0x8a150110: { reason: 'dependencies could not be installed' },
  0x8a150111: { reason: 'app is in use, close it', fix: 'wait-retry' },
};

// winget refuses to touch a per-user install from an elevated process. Patchday retries it
// from the user's own session after the admin run.
export const USER_SCOPE = 'installed for your user only';
const USER_SCOPE_TEXT = /installed for user scope cannot be (uninstalled|upgraded)|user scope.*administrator privileges/i;

// Visual Studio updates through its own installer, which stops when it needs its own update,
// a restart or a closed Visual Studio. A fresh install cannot help.
const VISUAL_STUDIO = 'Visual Studio Installer needs you: open it once and update there';
const VISUAL_STUDIO_TEXT = /Visual ?Studio.*(lower than the desired version|update failed)|VisualStudio\.\d{4}\.[A-Za-z]+\].*Installer failed/is;

export function diagnoseWinget(code: number, output: string): Diagnosis {
  if (USER_SCOPE_TEXT.test(output)) return { reason: USER_SCOPE, final: true };
  if (VISUAL_STUDIO_TEXT.test(output)) return { reason: VISUAL_STUDIO, final: true };
  const known = WINGET[code >>> 0];
  if (known) return known;
  // Windows error codes 2 and 3, also as HRESULT; 206 is a path that is too long.
  if ([2, 3, 0x80070002, 0x80070003].includes(code >>> 0) || PATH_TEXT.test(output)) return PATH_PROBLEM;
  if ([206, 0x800700ce].includes(code >>> 0)) return { reason: 'a file path is too long' };
  // Installers report their own codes: 1602 cancelled, 1618 busy, 3010 restart needed.
  if (code === 3010 || code === 1641) return { reason: 'restart to finish', applied: true };
  if (code === 1618) return { reason: 'another installation is running', fix: 'wait-retry' };
  if (code === 1602) return { reason: 'installation was cancelled', final: true };
  if (/network|timed? ?out|connection/i.test(output)) return { reason: 'download failed', fix: 'retry' };
  return { reason: `${UNKNOWN} (${hex(code)})` };
}

const CHOCO: Array<[RegExp, Diagnosis]> = [
  [/not.*elevated|administrative permissions|Access to the path .* is denied/i, { reason: 'needs administrator rights', final: true }],
  [/being used by another process|in use/i, { reason: 'app is in use, close it', fix: 'wait-retry' }],
  [/another (instance|process)|lock file/i, { reason: 'another installation is running', fix: 'wait-retry' }],
  [/checksum/i, { reason: 'download did not match its checksum', fix: 'refresh-retry' }],
  [/timed? ?out|Unable to connect|could not be resolved|\(404\)|\(503\)/i, { reason: 'download failed', fix: 'retry' }],
  [/not enough space|disk full/i, { reason: 'disk is full', final: true }],
  [PATH_TEXT, { reason: 'a folder of the installed app is missing', fix: 'force-retry' }],
];

export function diagnoseChoco(code: number, output: string): Diagnosis {
  if (VISUAL_STUDIO_TEXT.test(output)) return { reason: VISUAL_STUDIO, final: true };
  if (code === 3010 || code === 1641 || code === 350) return { reason: 'restart to finish', applied: true };
  return CHOCO.find(([pattern]) => pattern.test(output))?.[1] ?? { reason: `${UNKNOWN} (${code})` };
}

const BREW: Array<[RegExp, Diagnosis]> = [
  [/already an App at|It seems there is already/i, { reason: 'app already exists in Applications', fix: 'force-retry' }],
  [/SHA-?256 mismatch|checksum/i, { reason: 'download did not match its checksum', fix: 'refresh-retry' }],
  [/another active Homebrew|has already locked/i, { reason: 'Homebrew is busy', fix: 'wait-retry' }],
  [/Could not resolve|timed out|Connection|Failure while executing.*curl|Download failed/i, { reason: 'download failed', fix: 'retry' }],
  [/sudo:|a password is required|a terminal is required|must be run as root/i, { reason: 'needs your admin password', final: true }],
  [/is (still )?running|quit the app/i, { reason: 'app is running, close it', final: true }],
  [/No space left/i, { reason: 'disk is full', final: true }],
  [/has been disabled|is disabled|deprecated/i, { reason: 'discontinued by Homebrew', final: true }],
  [/Permission denied|Operation not permitted/i, { reason: 'macOS denied access', final: true }],
];

export function diagnoseBrew(output: string): Diagnosis {
  return BREW.find(([pattern]) => pattern.test(output))?.[1] ?? { reason: UNKNOWN };
}

const ELEVATION_CANCELLED = /canceled by the user|cancelled by the user|vom Benutzer abgebrochen/i;

// Scoop prints its messages in English only.
export function diagnoseScoop(output: string): Diagnosis {
  if (ELEVATION_CANCELLED.test(output)) return { reason: 'the admin prompt was cancelled', final: true };
  if (/is already installed|Latest versions for all apps are installed|is up to date/i.test(output)) return { reason: 'already up to date', applied: true };
  if (/Couldn't find manifest/i.test(output)) return { reason: 'Scoop does not know this app', final: true };
  if (/is still running|access is denied|being used by another process/i.test(output)) return { reason: 'app is running, close it', fix: 'wait-retry' };
  if (/hash check failed/i.test(output)) return { reason: 'download did not match its checksum', fix: 'refresh-retry' };
  return { reason: 'Scoop stopped with an error' };
}

// Chocolatey changes run through the Windows admin prompt.
export function diagnoseElevated(code: number, output: string): Diagnosis {
  if (ELEVATION_CANCELLED.test(output)) return { reason: 'the admin prompt was cancelled', final: true };
  return diagnoseChoco(code, output);
}
