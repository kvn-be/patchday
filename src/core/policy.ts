import { classify, isPrerelease, parseTag } from './version.ts';

export type Action = 'auto' | 'propose' | 'skip';

export interface UpdateCandidate {
  image: string;
  currentTag: string;
  candidateTag: string;
  healthy: boolean;
  managed: boolean;
  releaseNotes?: string;
}

export interface PolicyOptions {
  autoMinor: boolean;
  holds: string[];
}

export interface Decision {
  action: Action;
  reason: string;
}

export const DEFAULT_POLICY: PolicyOptions = { autoMinor: true, holds: [] };

const PROTECTED: Array<[RegExp, string]> = [
  [/(^|\/)(postgres|postgis|mysql|mariadb|mongo|mongodb|timescaledb|influxdb|couchdb)(:|$|-)/i, 'database'],
  [/(^|\/)(redis|valkey|memcached|keydb)(:|$|-)/i, 'cache'],
  [/(^|\/)(cloudflared|adguardhome|adguardhome-sync|pihole|unbound|traefik|caddy|wireguard|tailscale)(:|$|-)/i, 'network or DNS'],
  [/(^|\/)portainer(-ce|-ee|-agent)?(:|$)/i, 'container manager'],
  [/immich/i, 'services that must be updated together'],
];

// Databases, caches and DNS take bug-fix releases by themselves: same data format, and the stack
// is backed up (with a pg_dumpall for PostgreSQL), health-checked and rolled back on failure.
// Anything bigger changes data or behaviour and stays with the user.
const BUGFIX_OK = new Set(['database', 'cache', 'network or DNS']);
// Since version 10, PostgreSQL counts X.Y: X is the major version, Y a bug-fix release.
const POSTGRES = /(^|\/)(postgres|postgis|timescaledb)(:|$|-)/i;

const BREAKING = /\b(breaking change|breaking changes|breaking:|migration required|manual migration|action required)\b/i;

export function hasBreakingHint(notes: string): boolean {
  return BREAKING.test(notes);
}

export function protectedCategory(image: string): string | null {
  if (image.startsWith('local/')) return 'locally built image';
  for (const [pattern, category] of PROTECTED) {
    if (pattern.test(image)) return category;
  }
  return null;
}

export function decide(candidate: UpdateCandidate, options: PolicyOptions = DEFAULT_POLICY): Decision {
  const { image, currentTag, candidateTag, healthy, managed, releaseNotes } = candidate;
  const bump = classify(currentTag, candidateTag);

  if (bump === null) return { action: 'propose', reason: 'tag schemes differ' };
  if (bump === 'none') return { action: 'skip', reason: 'already up to date' };
  if (options.holds.some((hold) => image.includes(hold))) return { action: 'propose', reason: 'on hold list' };

  const category = protectedCategory(image);
  if (category) {
    const fix = bump === 'patch' || (bump === 'minor' && POSTGRES.test(image) && (parseTag(currentTag)?.numbers.length ?? 0) === 2);
    if (!BUGFIX_OK.has(category) || !fix) return { action: 'propose', reason: `protected: ${category}` };
    if (isPrerelease(currentTag) || isPrerelease(candidateTag)) return { action: 'propose', reason: 'prerelease' };
    if (!healthy) return { action: 'propose', reason: 'container is not healthy' };
    if (!managed) return { action: 'propose', reason: 'not managed by Compose or Portainer' };
    if (releaseNotes && hasBreakingHint(releaseNotes)) return { action: 'propose', reason: 'release notes mention breaking changes' };
    return { action: 'auto', reason: `bug-fix update (${category})` };
  }
  if (isPrerelease(currentTag) || isPrerelease(candidateTag)) return { action: 'propose', reason: 'prerelease' };
  if (bump === 'major') return { action: 'propose', reason: 'major update' };
  if (!healthy) return { action: 'propose', reason: 'container is not healthy' };
  if (!managed) return { action: 'propose', reason: 'not managed by Compose or Portainer' };
  if (releaseNotes && hasBreakingHint(releaseNotes)) return { action: 'propose', reason: 'release notes mention breaking changes' };

  if (bump === 'minor') {
    if (!options.autoMinor) return { action: 'propose', reason: 'minor updates need approval' };
    if (!releaseNotes) return { action: 'propose', reason: 'minor update without release notes' };
  }
  return { action: 'auto', reason: `${bump} update` };
}
