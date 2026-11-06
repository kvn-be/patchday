export type Fix = 'retry' | 'wait-retry' | 'refresh-retry' | 'force-retry';

export interface Diagnosis {
  reason: string;
  fix?: Fix;
  // The install worked, but needs something else to finish.
  applied?: boolean;
}

const UNKNOWN = 'installer stopped with an error';

// From winget's return code documentation.
const WINGET: Record<number, Diagnosis> = {
  0x8a150010: { reason: 'no installer for this system' },
  0x8a150011: { reason: 'download did not match its checksum', fix: 'refresh-retry' },
  0x8a150019: { reason: 'needs administrator rights' },
  0x8a15002b: { reason: 'no update path from the installed version' },
  0x8a15003a: { reason: 'blocked by a Group Policy' },
  0x8a15004f: { reason: 'installed version is already newer' },
  0x8a150050: { reason: 'installed version is unknown' },
  0x8a150056: { reason: 'installer refuses to run as administrator' },
  0x8a150068: { reason: 'pinned in winget' },
  0x8a15006b: { reason: 'dependencies could not be downloaded', fix: 'retry' },
  0x8a150086: { reason: 'download was empty', fix: 'retry' },
  0x8a15008e: { reason: 'new version uses a different installer, reinstall it once' },
  0x8a150101: { reason: 'app is running, close it', fix: 'wait-retry' },
  0x8a150102: { reason: 'another installation is running', fix: 'wait-retry' },
  0x8a150103: { reason: 'files are in use, close the app', fix: 'wait-retry' },
  0x8a150104: { reason: 'a required component is missing' },
  0x8a150105: { reason: 'disk is full' },
  0x8a150106: { reason: 'not enough memory' },
  0x8a150107: { reason: 'no internet connection', fix: 'wait-retry' },
  0x8a150109: { reason: 'restart to finish', applied: true },
  0x8a15010a: { reason: 'restart Windows, then it updates' },
  0x8a15010b: { reason: 'Windows restarts to finish', applied: true },
  0x8a15010c: { reason: 'installation was cancelled' },
  0x8a15010d: { reason: 'another version is already installed' },
  0x8a15010e: { reason: 'a newer version is already installed' },
  0x8a15010f: { reason: 'blocked by your organization' },
  0x8a150110: { reason: 'dependencies could not be installed' },
  0x8a150111: { reason: 'app is in use, close it', fix: 'wait-retry' },
};

export function diagnoseWinget(code: number, output: string): Diagnosis {
  const known = WINGET[code >>> 0];
  if (known) return known;
  // Installers report their own codes: 1602 cancelled, 1618 busy, 3010 restart needed.
  if (code === 3010 || code === 1641) return { reason: 'restart to finish', applied: true };
  if (code === 1618) return { reason: 'another installation is running', fix: 'wait-retry' };
  if (code === 1602) return { reason: 'installation was cancelled' };
  if (/network|timed? ?out|connection/i.test(output)) return { reason: 'download failed', fix: 'retry' };
  return { reason: UNKNOWN };
}

const BREW: Array<[RegExp, Diagnosis]> = [
  [/already an App at|It seems there is already/i, { reason: 'app already exists in Applications', fix: 'force-retry' }],
  [/SHA-?256 mismatch|checksum/i, { reason: 'download did not match its checksum', fix: 'refresh-retry' }],
  [/another active Homebrew|has already locked/i, { reason: 'Homebrew is busy', fix: 'wait-retry' }],
  [/Could not resolve|timed out|Connection|Failure while executing.*curl|Download failed/i, { reason: 'download failed', fix: 'retry' }],
  [/sudo:|a password is required|a terminal is required|must be run as root/i, { reason: 'needs your admin password' }],
  [/is (still )?running|quit the app/i, { reason: 'app is running, close it' }],
  [/No space left/i, { reason: 'disk is full' }],
  [/has been disabled|is disabled|deprecated/i, { reason: 'discontinued by Homebrew' }],
  [/Permission denied|Operation not permitted/i, { reason: 'macOS denied access' }],
];

export function diagnoseBrew(output: string): Diagnosis {
  return BREW.find(([pattern]) => pattern.test(output))?.[1] ?? { reason: UNKNOWN };
}
