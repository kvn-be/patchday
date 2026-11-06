export type Bump = 'none' | 'patch' | 'minor' | 'major';

export interface ParsedTag {
  prefix: string;
  numbers: number[];
  suffix: string;
}

const TAG = /^(v?)(\d+(?:\.\d+)*)(.*)$/;
const PRERELEASE = /(alpha|beta|rc|dev|nightly|snapshot|preview)/i;

export function parseTag(tag: string): ParsedTag | null {
  const match = TAG.exec(tag);
  if (!match) return null;
  return { prefix: match[1], numbers: match[2].split('.').map(Number), suffix: match[3] };
}

export function isPrerelease(tag: string): boolean {
  return PRERELEASE.test(tag);
}

// Tags are only comparable inside one scheme: 1.2.3-alpine never upgrades to 1.2.4 or 1.3-alpine.
export function sameScheme(a: ParsedTag, b: ParsedTag): boolean {
  return a.prefix === b.prefix && a.suffix === b.suffix && a.numbers.length === b.numbers.length;
}

export function classify(current: string, candidate: string): Bump | null {
  const a = parseTag(current);
  const b = parseTag(candidate);
  if (!a || !b || !sameScheme(a, b)) return null;
  for (let i = 0; i < a.numbers.length; i++) {
    if (b.numbers[i] > a.numbers[i]) return i === 0 ? 'major' : i === 1 ? 'minor' : 'patch';
    if (b.numbers[i] < a.numbers[i]) return 'none';
  }
  return 'none';
}

function compare(a: ParsedTag, b: ParsedTag): number {
  for (let i = 0; i < a.numbers.length; i++) {
    if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] - b.numbers[i];
  }
  return 0;
}

export function latestTag(current: string, tags: string[]): string | null {
  const base = parseTag(current);
  if (!base) return null;
  let best: { tag: string; parsed: ParsedTag } | null = null;
  for (const tag of tags) {
    const parsed = parseTag(tag);
    if (!parsed || !sameScheme(base, parsed)) continue;
    if (isPrerelease(tag) && !isPrerelease(current)) continue;
    if (compare(parsed, base) <= 0) continue;
    if (!best || compare(parsed, best.parsed) > 0) best = { tag, parsed };
  }
  return best?.tag ?? null;
}
