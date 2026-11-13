export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface Release {
  version: string;
  assets: ReleaseAsset[];
}

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  assets: Array<{ name: string; browser_download_url: string }>;
}

function parts(version: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parts(candidate);
  const b = parts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export function pickRelease(releases: GitHubRelease[], current: string): Release | null {
  let best: GitHubRelease | null = null;
  for (const release of releases) {
    if (release.draft || !isNewer(release.tag_name, best?.tag_name ?? current)) continue;
    best = release;
  }
  if (!best) return null;
  return {
    version: best.tag_name.replace(/^v/, ''),
    assets: best.assets.map((asset) => ({ name: asset.name, url: asset.browser_download_url })),
  };
}

// latest-mac.yml lists every file with its checksum. Only those two fields are needed.
export function macChecksum(yml: string, fileName: string): string | null {
  const lines = yml.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- url: ${fileName}`);
  if (start < 0) return null;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*- url:/.test(line) || /^\S/.test(line)) return null;
    const match = /^\s*sha512:\s*(\S+)/.exec(line);
    if (match) return match[1];
  }
  return null;
}

export const MAC_SWAP_SCRIPT = `#!/bin/bash
# Arguments: running process id, installed app, new app, and --no-open when Patchday was closed on purpose.
while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
backup="$2.previous"
rm -rf "$backup"
if mv "$2" "$backup"; then
  if mv "$3" "$2"; then
    rm -rf "$backup"
  else
    mv "$backup" "$2"
  fi
fi
if [ "$4" != "--no-open" ]; then open "$2"; fi
`;

export const SELF_CHECK_HOURS = 24;

// True when the last automatic check is older than the interval, or never happened.
export function selfCheckDue(lastCheck: string | undefined, now: Date, hours = SELF_CHECK_HOURS): boolean {
  if (!lastCheck) return true;
  const last = new Date(lastCheck).getTime();
  return Number.isNaN(last) || now.getTime() - last >= hours * 3_600_000 || last > now.getTime();
}
