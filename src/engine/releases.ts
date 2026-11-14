import { parseTag } from '../core/version.ts';
import type { FetchLike } from './registry.ts';

export interface GithubRepo {
  owner: string;
  repo: string;
}

const NAME = /^[A-Za-z0-9_.-]+$/;

// The image says where its code lives (OCI label); ghcr.io images live on GitHub under the same name.
// Docker Hub names are not guessed: a wrong repository could hand over the wrong notes.
export function githubRepo(repository: string, source: string | null): GithubRepo | null {
  const fromSource = source ? /^(?:https?:\/\/|git@)github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?\/?(?:[#?].*)?$/i.exec(source.trim()) : null;
  const fromGhcr = /^ghcr\.io\/([^/]+)\/([^/]+)$/i.exec(repository);
  const match = fromSource ?? fromGhcr;
  if (!match || !NAME.test(match[1]) || !NAME.test(match[2])) return null;
  return { owner: match[1], repo: match[2] };
}

interface Release {
  tag_name: string;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
}

// The version numbers in a tag, without prefixes like "v" or "release-" and suffixes like "-alpine".
function versionOf(tag: string): number[] | null {
  const match = /(\d+(?:\.\d+)*)/.exec(tag);
  if (!match) return null;
  return match[1].split('.').map(Number);
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// The notes of every release after the running version, up to and including the new one.
// A breaking change in a release in between counts as well. null: the new version has no release here.
export function notesBetween(releases: Release[], from: string, to: string): string | null {
  const low = parseTag(from)?.numbers ?? versionOf(from);
  const high = parseTag(to)?.numbers ?? versionOf(to);
  if (!low || !high) return null;
  const picked = releases.filter((release) => {
    if (release.draft || release.prerelease) return false;
    const version = versionOf(release.tag_name);
    return version !== null && compare(version, low) > 0 && compare(version, high) <= 0;
  });
  const target = picked.find((release) => compare(versionOf(release.tag_name) as number[], high) === 0);
  if (!target || !target.body?.trim()) return null;
  return picked.map((release) => `${release.tag_name}\n${release.body ?? ''}`).join('\n\n');
}

export type ReleaseNotesLookup = (repository: string, source: string | null, from: string, to: string) => Promise<string | null>;

export function createReleaseNotesLookup(fetcher: FetchLike = fetch as unknown as FetchLike): ReleaseNotesLookup {
  return async (repository, source, from, to) => {
    const repo = githubRepo(repository, source);
    if (!repo) return null;
    const response = await fetcher(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=100`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Patchday' },
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return notesBetween(await response.json(), from, to);
  };
}
