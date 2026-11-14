import { classify, isPrerelease, parseTag } from './version.ts';

export type Action = 'auto' | 'propose' | 'skip';

export interface UpdateCandidate {
  image: string;
  currentTag: string;
  candidateTag: string;
  healthy: boolean;
  managed: boolean;
  releaseNotes?: string;
  // Security advisories (GHSA or CVE ids) the new version fixes.
  advisories?: string[];
}

export interface PolicyOptions {
  autoMinor: boolean;
  holds: string[];
  // Optional updates the user chose to install anyway, as "repository:tag".
  approved?: string[];
}

export interface Decision {
  action: Action;
  reason: string;
}

export const DEFAULT_POLICY: PolicyOptions = { autoMinor: false, holds: [] };

// Reasons the engine and the app look for: a minor update that is neither a security fix nor approved.
export const OPTIONAL_MINOR = 'optional minor update';
export const MINOR_WITHOUT_NOTES = 'minor update without release notes';

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

// A release that says it fixes a vulnerability: a CVE or GHSA id, or plain words like "security fix".
const SECURITY = /\b(CVE-\d{4}-\d{4,}|GHSA(-[23456789cfghjmpqrvwx]{4}){3}|security (fix|fixes|update|patch|release|issue|vulnerabilit(y|ies))|vulnerabilit(y|ies) (fix|fixed|patched))\b/i;

export function hasSecurityHint(notes: string): boolean {
  return SECURITY.test(notes);
}

export function isSecurityFix(candidate: Pick<UpdateCandidate, 'releaseNotes' | 'advisories'>): boolean {
  return (candidate.advisories?.length ?? 0) > 0 || (candidate.releaseNotes ? hasSecurityHint(candidate.releaseNotes) : false);
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

  // Patch releases carry security and bug fixes and go ahead by themselves.
  if (bump === 'patch') return { action: 'auto', reason: 'patch update' };
  // Minor releases: security fixes go ahead by themselves, everything else is optional.
  if (isSecurityFix(candidate)) return { action: 'auto', reason: 'security update' };
  if (options.approved?.includes(`${image}:${candidateTag}`)) return { action: 'auto', reason: 'approved by you' };
  if (!options.autoMinor) return { action: 'propose', reason: OPTIONAL_MINOR };
  if (!releaseNotes) return { action: 'propose', reason: MINOR_WITHOUT_NOTES };
  return { action: 'auto', reason: 'minor update' };
}
