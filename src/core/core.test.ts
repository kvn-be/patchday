import assert from 'node:assert/strict';
import { test } from 'node:test';
import { upgradeArgs, upgradeOrder } from './brew.ts';
import { decide, OPTIONAL_MINOR, protectedCategory } from './policy.ts';
import { DEFAULT_SETTINGS, migrateSettings } from '../engine/types.ts';
import { launchdPlist, nextRun, schtasksArgs, validateSchedule } from './schedule.ts';
import { classify, latestTag } from './version.ts';

const base = { image: 'ghcr.io/acme/app', currentTag: '1.2.3', candidateTag: '1.2.4', healthy: true, managed: true };

test('classify keeps the tag scheme', () => {
  assert.equal(classify('1.2.3', '1.2.4'), 'patch');
  assert.equal(classify('v1.2.3', 'v1.3.0'), 'minor');
  assert.equal(classify('1.2.3-alpine', '2.0.0-alpine'), 'major');
  assert.equal(classify('1.2.3-alpine', '1.2.4'), null);
  assert.equal(classify('latest', '1.2.4'), null);
  assert.equal(classify('1.2.3', '1.2.3'), 'none');
  assert.equal(classify('1.10.0', '1.9.0'), 'none');
});

test('latestTag compares numerically and ignores prereleases', () => {
  const tags = ['1.9.0', '1.10.0', '1.11.0-rc1', '1.10.0-alpine', 'latest', '2.0'];
  assert.equal(latestTag('1.8.0', tags), '1.10.0');
  assert.equal(latestTag('1.10.0', tags), null);
  assert.equal(latestTag('1.8.0-alpine', tags), '1.10.0-alpine');
});

test('policy updates safe patches automatically', () => {
  assert.equal(decide(base).action, 'auto');
  assert.equal(decide({ ...base, candidateTag: '1.3.0', releaseNotes: 'Fixes' }, { autoMinor: true, holds: [] }).action, 'auto');
});

test('policy never auto-updates risky candidates', () => {
  const risky = [
    { ...base, candidateTag: '2.0.0' },
    { ...base, candidateTag: '1.3.0' },
    { ...base, healthy: false },
    { ...base, managed: false },
    { ...base, releaseNotes: 'BREAKING CHANGE: config moved' },
    { ...base, image: 'postgres', currentTag: '16.15-alpine3.23', candidateTag: '18.7-alpine3.23' },
    { ...base, image: 'ghcr.io/immich-app/postgres', currentTag: '14', candidateTag: '16' },
    { ...base, image: 'mariadb', currentTag: '11.4.2', candidateTag: '11.5.0' },
    { ...base, image: 'docker.io/library/redis', candidateTag: '1.3.0' },
    { ...base, image: 'valkey/valkey', candidateTag: '2.0.0' },
    { ...base, image: 'redis', healthy: false },
    { ...base, image: 'postgres', currentTag: '16.1', candidateTag: '16.2', managed: false },
    { ...base, image: 'local/immich-server' },
    { ...base, image: 'ghcr.io/immich-app/immich-machine-learning' },
    { ...base, image: 'cloudflare/cloudflared', currentTag: '2026.10.7', candidateTag: '2026.11.0' },
    { ...base, image: 'portainer/portainer-ce' },
    { ...base, currentTag: '6.0.0-beta13', candidateTag: '6.0.1-beta13' },
  ];
  for (const candidate of risky) assert.equal(decide(candidate).action, 'propose', candidate.image);
});

test('databases, caches and DNS take bug-fix releases by themselves', () => {
  const fixes = [
    { ...base, image: 'postgres', currentTag: '18.6-alpine3.23', candidateTag: '18.7-alpine3.23' },
    { ...base, image: 'redis', currentTag: '7.4.11-alpine3.21', candidateTag: '7.4.12-alpine3.21' },
    { ...base, image: 'valkey/valkey', currentTag: '9.1.2-alpine', candidateTag: '9.1.3-alpine' },
    { ...base, image: 'ghcr.io/bakito/adguardhome-sync', currentTag: 'v0.9.5', candidateTag: 'v0.9.6' },
    { ...base, image: 'cloudflare/cloudflared' },
  ];
  for (const candidate of fixes) assert.deepEqual(decide(candidate).action, 'auto', candidate.image);
  assert.equal(decide(fixes[0]).reason, 'bug-fix update (database)');
  assert.equal(decide({ ...fixes[0], releaseNotes: 'Breaking change: x' }).action, 'propose');
  assert.equal(decide({ ...fixes[1], candidateTag: '7.4.12-rc1-alpine3.21' }).action, 'propose');
});

test('minor updates are optional unless they fix a security issue', () => {
  const minor = { ...base, currentTag: '1.2.3', candidateTag: '1.3.0' };
  assert.deepEqual(decide(minor), { action: 'propose', reason: OPTIONAL_MINOR });
  assert.deepEqual(decide({ ...minor, releaseNotes: 'Fixes CVE-2026-12345 in the parser' }), { action: 'auto', reason: 'security update' });
  assert.deepEqual(decide({ ...minor, releaseNotes: 'See GHSA-x4qr-2fvf-3mr5' }).action, 'auto');
  assert.deepEqual(decide({ ...minor, releaseNotes: 'Security fix for the login form' }).action, 'auto');
  assert.deepEqual(decide({ ...minor, advisories: ['CVE-2026-1'] }), { action: 'auto', reason: 'security update' });
  assert.equal(decide({ ...minor, releaseNotes: 'New dashboard, better security settings page' }).reason, OPTIONAL_MINOR);
  // A breaking change still waits, security fix or not.
  assert.equal(decide({ ...minor, releaseNotes: 'CVE-2026-12345. Breaking change: config moved' }).action, 'propose');
  // A major update never goes ahead by itself.
  assert.equal(decide({ ...minor, candidateTag: '2.0.0', advisories: ['CVE-2026-1'] }).action, 'propose');
  // Patches carry security and bug fixes and stay automatic.
  assert.deepEqual(decide(base), { action: 'auto', reason: 'patch update' });
  // Approved by the user, or all minor updates switched on.
  assert.deepEqual(decide(minor, { autoMinor: false, holds: [], approved: ['ghcr.io/acme/app:1.3.0'] }), { action: 'auto', reason: 'approved by you' });
  assert.equal(decide(minor, { autoMinor: false, holds: [], approved: ['ghcr.io/acme/app:1.4.0'] }).reason, OPTIONAL_MINOR);
  assert.equal(decide(minor, { autoMinor: true, holds: [] }).reason, 'minor update without release notes');
  assert.equal(decide({ ...minor, releaseNotes: 'New widgets' }, { autoMinor: true, holds: [] }).action, 'auto');
});

test('old settings files lose the automatic minor updates once', () => {
  const old = { ...DEFAULT_SETTINGS, autoMinor: true, policyVersion: undefined };
  assert.equal(migrateSettings(old).autoMinor, false);
  assert.equal(migrateSettings(old).policyVersion, 2);
  assert.equal(migrateSettings({ ...DEFAULT_SETTINGS, autoMinor: true }).autoMinor, true);
});

test('policy honours holds and does not over-match protected names', () => {
  assert.equal(decide(base, { autoMinor: true, holds: ['acme'] }).action, 'propose');
  assert.equal(protectedCategory('ghcr.io/acme/postgres-exporter'), 'database');
  assert.equal(protectedCategory('ghcr.io/acme/redistribute'), null);
});

test('schedule validation and next run', () => {
  assert.deepEqual(validateSchedule({ enabled: true, days: [], hour: 24, minute: 0 }), ['at least one day is required', 'hour must be 0-23']);
  const schedule = { enabled: true, days: [0], hour: 3, minute: 0 };
  const saturday = new Date(2026, 10, 7, 12, 0);
  assert.deepEqual(nextRun(schedule, saturday), new Date(2026, 10, 8, 3, 0));
  const sundayLate = new Date(2026, 10, 8, 3, 0);
  assert.deepEqual(nextRun(schedule, sundayLate), new Date(2026, 10, 15, 3, 0));
  assert.equal(nextRun({ ...schedule, enabled: false }, saturday), null);
});

test('scheduler output for launchd and schtasks', () => {
  const schedule = { enabled: true, days: [0, 3], hour: 3, minute: 5 };
  const plist = launchdPlist(schedule, 'io.patchday.run', ['/Applications/A&B.app', '--run']);
  assert.match(plist, /A&amp;B/);
  assert.equal(plist.match(/<key>Weekday<\/key>/g)?.length, 2);
  assert.deepEqual(schtasksArgs(schedule, 'Patchday', 'patchday.exe --run').slice(-4), ['/D', 'SUN,WED', '/ST', '03:05']);
});

test('brew runs Docker runtimes last, one package at a time', () => {
  const cask = (name: string) => ({ name, kind: 'cask' as const, installed: '1', available: '2' });
  assert.deepEqual(upgradeOrder([cask('orbstack'), cask('firefox')]).map((entry) => entry.name), ['firefox', 'orbstack']);
  assert.deepEqual(upgradeArgs(cask('firefox'), true), ['upgrade', '--cask', '--greedy', '--force', 'firefox']);
});
