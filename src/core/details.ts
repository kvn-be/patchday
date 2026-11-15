// Package details from each manager's own output or public registry, in one shape.
import { asSafeUrl } from './url.ts';

export interface Details {
  description?: string;
  publisher?: string;
  author?: string;
  homepage?: string;
  license?: string;
  licenseUrl?: string;
  releaseNotes?: string;
  releaseNotesUrl?: string;
  installerUrl?: string;
  updated?: string;
  tags?: string[];
  // Versions that can be installed, newest first.
  versions?: string[];
}

const text = (value: unknown, max = 4000) => (typeof value === 'string' ? value.trim().slice(0, max) || undefined : undefined);
const clean = (details: Details): Details => {
  const out: Details = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    (out as Record<string, unknown>)[key] = /url$|homepage/i.test(key) ? asSafeUrl(value as string) : value;
  }
  for (const key of Object.keys(out) as (keyof Details)[]) if (out[key] === undefined) delete out[key];
  return out;
};

// "Key: value" lines, as winget show and scoop info print them. Indented lines continue the value
// before; "Tags:" with indented lines below becomes a list.
export function keyValues(output: string): Map<string, string> {
  const map = new Map<string, string>();
  let last = '';
  for (const raw of output.replace(/\r/g, '').split('\n')) {
    const match = /^([A-Za-zÄÖÜäöüß][\w ÄÖÜäöüß()-]{0,40}?)\s*:\s?(.*)$/.exec(raw);
    if (match && !/^\s/.test(raw)) {
      last = match[1].trim().toLowerCase();
      map.set(last, match[2].trim());
    } else if (last && /^\s+\S/.test(raw)) {
      map.set(last, [map.get(last), raw.trim()].filter(Boolean).join('\n'));
    }
  }
  return map;
}

const pick = (map: Map<string, string>, ...keys: string[]) => {
  for (const key of keys) {
    const value = map.get(key);
    if (value) return value;
  }
  return undefined;
};

export function parseWingetShow(output: string, versionsOutput = ''): Details {
  const map = keyValues(output);
  const versions = versionsOutput.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter((line) => /^\d[\w.+-]*$/.test(line));
  return clean({
    description: pick(map, 'description', 'beschreibung'),
    publisher: pick(map, 'publisher', 'herausgeber'),
    author: pick(map, 'author', 'autor'),
    homepage: pick(map, 'homepage', 'startseite', 'publisher url'),
    license: pick(map, 'license', 'lizenz'),
    licenseUrl: pick(map, 'license url', 'lizenz-url'),
    releaseNotes: pick(map, 'release notes', 'versionshinweise'),
    releaseNotesUrl: pick(map, 'release notes url', 'url der versionshinweise'),
    installerUrl: pick(map, 'installer url', 'installer-url'),
    updated: pick(map, 'release date', 'veröffentlichungsdatum'),
    tags: pick(map, 'tags', 'markierungen')?.split('\n').map((tag) => tag.trim()).filter(Boolean).slice(0, 20),
    versions: versions.slice(0, 100),
  });
}

export function parseScoopInfo(output: string): Details {
  const map = keyValues(output);
  return clean({ description: pick(map, 'description'), homepage: pick(map, 'website'), license: pick(map, 'license'), updated: pick(map, 'updated at') });
}

// `choco info <id>` prints "Title: … | Published: …" and further "Key: value" lines.
export function parseChocoInfo(output: string): Details {
  const map = new Map<string, string>();
  for (const line of output.replace(/\r/g, '').split('\n')) {
    for (const part of line.split(' | ')) {
      const match = /^\s*([A-Za-z][\w ]{1,40}?):\s(.+)$/.exec(part);
      if (match) map.set(match[1].trim().toLowerCase(), match[2].trim());
    }
  }
  return clean({
    description: pick(map, 'description', 'summary'),
    author: pick(map, 'software author(s)', 'software author'),
    publisher: pick(map, 'package maintainer(s)', 'package maintainer'),
    homepage: pick(map, 'software site'),
    licenseUrl: pick(map, 'software license'),
    releaseNotes: pick(map, 'release notes'),
    updated: pick(map, 'published'),
    tags: pick(map, 'tags')?.split(/\s+/).filter(Boolean).slice(0, 20),
  });
}

export function parseBrewInfo(json: string): Details {
  const { formulae = [], casks = [] } = JSON.parse(json) as {
    formulae?: Array<{ desc?: string; homepage?: string; license?: string; urls?: { stable?: { url?: string } } }>;
    casks?: Array<{ desc?: string; homepage?: string; url?: string; name?: string[] }>;
  };
  const formula = formulae[0];
  if (formula) return clean({ description: text(formula.desc), homepage: text(formula.homepage), license: text(formula.license), installerUrl: text(formula.urls?.stable?.url) });
  const cask = casks[0];
  return cask ? clean({ description: text(cask.desc), homepage: text(cask.homepage), installerUrl: text(cask.url), publisher: cask.name?.[0] }) : {};
}

export function parsePypi(json: string): Details {
  const { info = {}, releases = {} } = JSON.parse(json) as { info?: Record<string, unknown>; releases?: Record<string, unknown> };
  const urls = (info.project_urls ?? {}) as Record<string, string>;
  return clean({
    description: text(info.summary),
    author: text(info.author) ?? text(info.author_email),
    homepage: text(info.home_page) ?? urls.Homepage ?? urls.homepage ?? urls.Source,
    license: text(info.license, 200),
    releaseNotesUrl: urls.Changelog ?? urls['Release Notes'] ?? urls.changelog,
    versions: Object.keys(releases).reverse().slice(0, 100),
  });
}

export function parseNpmView(json: string): Details {
  const data = JSON.parse(json) as { description?: string; homepage?: string; license?: string; author?: string | { name?: string }; versions?: string[] | string; time?: { modified?: string } };
  const versions = Array.isArray(data.versions) ? data.versions : data.versions ? [data.versions] : [];
  return clean({
    description: text(data.description), homepage: text(data.homepage), license: text(data.license),
    author: typeof data.author === 'string' ? data.author : data.author?.name, updated: data.time?.modified,
    versions: [...versions].reverse().slice(0, 100),
  });
}

export function parseNugetSearch(json: string): Details {
  const entry = (JSON.parse(json) as { data?: Array<{ description?: string; authors?: string[]; projectUrl?: string; licenseUrl?: string; tags?: string[]; versions?: Array<{ version: string }> }> }).data?.[0];
  if (!entry) return {};
  return clean({
    description: text(entry.description), author: entry.authors?.join(', '), homepage: entry.projectUrl, licenseUrl: entry.licenseUrl,
    tags: entry.tags?.slice(0, 20), versions: (entry.versions ?? []).map((version) => version.version).reverse().slice(0, 100),
  });
}

export function parseCrate(json: string): Details {
  const data = JSON.parse(json) as { crate?: { description?: string; homepage?: string; repository?: string; updated_at?: string }; versions?: Array<{ num: string; license?: string; yanked?: boolean }> };
  return clean({
    description: text(data.crate?.description), homepage: data.crate?.homepage ?? data.crate?.repository, updated: data.crate?.updated_at,
    license: data.versions?.[0]?.license, versions: (data.versions ?? []).filter((version) => !version.yanked).map((version) => version.num).slice(0, 100),
  });
}

export function parsePsModule(json: string, versionsJson = ''): Details {
  const raw = json.trim() ? JSON.parse(json) : {};
  const data = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
  if (!data) return {};
  const versions = versionsJson.trim() ? ([] as unknown[]).concat(JSON.parse(versionsJson)).map(String) : [];
  return clean({
    description: text(data.Description), author: text(data.Author), publisher: text(data.CompanyName), homepage: text(data.ProjectUri),
    licenseUrl: text(data.LicenseUri), releaseNotes: text(data.ReleaseNotes), tags: Array.isArray(data.Tags) ? (data.Tags as string[]).slice(0, 20) : undefined,
    versions: versions.slice(0, 100),
  });
}
