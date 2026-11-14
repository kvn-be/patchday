import assert from 'node:assert/strict';
import test from 'node:test';
import { createReleaseNotesLookup, githubRepo, notesBetween } from './releases.ts';

test('the GitHub repository comes from the OCI label or a ghcr.io name, never a guess', () => {
  assert.deepEqual(githubRepo('stirlingtools/stirling-pdf', 'https://github.com/Stirling-Tools/Stirling-PDF'), { owner: 'Stirling-Tools', repo: 'Stirling-PDF' });
  assert.deepEqual(githubRepo('x/y', 'https://github.com/a/b.git'), { owner: 'a', repo: 'b' });
  assert.deepEqual(githubRepo('ghcr.io/gethomepage/homepage', null), { owner: 'gethomepage', repo: 'homepage' });
  assert.equal(githubRepo('nginx', null), null);
  assert.equal(githubRepo('louislam/uptime-kuma', null), null);
  assert.equal(githubRepo('x/y', 'https://gitlab.com/a/b'), null);
});

const releases = [
  { tag_name: 'v2.9.0', body: 'next' },
  { tag_name: 'v2.8.0', body: 'New widgets' },
  { tag_name: 'v2.8.0-rc1', body: 'Breaking change: config moved', prerelease: true },
  { tag_name: 'v2.7.1', body: 'Breaking change: env renamed' },
  { tag_name: 'v2.7.0', body: 'old' },
];

test('notes cover every release after the running one up to the new one', () => {
  const notes = notesBetween(releases, 'v2.7.0', 'v2.8.0') as string;
  assert.match(notes, /New widgets/);
  assert.match(notes, /env renamed/);
  assert.doesNotMatch(notes, /next|old|config moved/);
});

test('tag suffixes do not stop the match', () => {
  assert.match(notesBetween([{ tag_name: 'release-1.31.0', body: 'ok' }], '1.30-alpine', '1.31-alpine') as string, /ok/);
});

test('no notes when the new version has no release or an empty one', () => {
  assert.equal(notesBetween(releases, 'v2.8.0', 'v2.10.0'), null);
  assert.equal(notesBetween([{ tag_name: '3.3.0', body: '  ' }], '3.2.2', '3.3.0'), null);
});

test('the lookup asks GitHub only for known repositories and reports its errors', async () => {
  const asked: string[] = [];
  const fetcher = async (url: string) => {
    asked.push(url);
    return { ok: !url.includes('broken'), status: 403, headers: { get: () => null }, json: async () => releases };
  };
  const lookup = createReleaseNotesLookup(fetcher);
  assert.match((await lookup('ghcr.io/gethomepage/homepage', null, 'v2.7.0', 'v2.8.0')) as string, /New widgets/);
  assert.equal(await lookup('nginx', null, '1.30', '1.31'), null);
  await assert.rejects(lookup('ghcr.io/x/broken', null, '1.0.0', '1.1.0'), /GitHub answered 403/);
  assert.deepEqual(asked.map((url) => new URL(url).pathname), ['/repos/gethomepage/homepage/releases', '/repos/x/broken/releases']);
});
