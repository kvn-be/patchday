// Package bundles in the UniGetUI format (.ubundle, export_version 3), so bundles move between both
// apps. Older UniGetUI bundles in .json, .yaml and .xml are read too. Patchday keeps its extras in
// keys UniGetUI does not read, so a bundle saved here still opens there.
import { parse as parseYaml } from 'yaml';
import { isSafeId, managersFor, type Manager, type Package } from './packages.ts';
import { cleanOptions, COMMAND_KEYS, isEmptyOptions, PARAMETER_KEYS, type InstallOptions } from './options.ts';

export const BUNDLE_VERSION = 3;
export const INCOMPATIBLE_INFO = 'Incompatible packages cannot be installed from UniGetUI, either because they came from a local source (for example Local PC) or because the package manager was unavailable. Nevertheless, they have been listed here for logging purposes.';

// UniGetUI writes the manager id; older bundles hold its name or display name.
const MANAGER_IDS: Record<Manager, string> = {
  brew: 'homebrew', winget: 'winget', choco: 'chocolatey', scoop: 'scoop', pip: 'pip', npm: 'npm',
  dotnet: 'dotnet-tool', pwsh: 'pwsh', winps: 'winps', cargo: 'cargo', vcpkg: 'vcpkg',
};
const MANAGER_ALIASES: Record<string, Manager> = {
  homebrew: 'brew', brew: 'brew', winget: 'winget', chocolatey: 'choco', choco: 'choco', scoop: 'scoop', pip: 'pip',
  npm: 'npm', 'dotnet-tool': 'dotnet', '.net tool': 'dotnet', dotnet: 'dotnet', pwsh: 'pwsh', powershell7: 'pwsh',
  'powershell 7': 'pwsh', winps: 'winps', powershell: 'winps', 'windows powershell': 'winps', cargo: 'cargo', vcpkg: 'vcpkg',
};
const DEFAULT_SOURCES: Record<Manager, string> = {
  brew: 'Homebrew', winget: 'winget', choco: 'chocolatey', scoop: 'main', pip: 'pip', npm: 'npm',
  dotnet: 'nuget.org', pwsh: 'PSGallery', winps: 'PSGallery', cargo: 'crates.io', vcpkg: 'vcpkg',
};

export function managerFromBundle(name: string): Manager | null {
  return MANAGER_ALIASES[name.trim().toLowerCase()] ?? null;
}

export interface BundlePackage {
  manager: Manager;
  id: string;
  name: string;
  version: string;
  kind?: 'formula' | 'cask';
  options: InstallOptions;
  // '*' ignores every update, a version skips only that one.
  ignored?: string;
}

export interface IncompatiblePackage {
  id: string;
  name: string;
  version: string;
  source: string;
  // Why Patchday cannot install it here.
  reason: 'manager-unknown' | 'other-system' | 'invalid-id';
  manager?: string;
}

export interface Bundle {
  version: number;
  packages: BundlePackage[];
  incompatible: IncompatiblePackage[];
}

// ---------- Writing ----------

export function bundleSource(entry: Pick<BundlePackage, 'manager' | 'id' | 'kind'>): string {
  if (entry.manager === 'brew') return entry.kind === 'cask' ? 'Homebrew Cask' : 'Homebrew';
  if (entry.manager === 'scoop' && entry.id.includes('/')) return entry.id.split('/')[0];
  return DEFAULT_SOURCES[entry.manager];
}

export function serializeBundle(bundle: Pick<Bundle, 'packages' | 'incompatible'>): string {
  const data = {
    export_version: BUNDLE_VERSION,
    packages: bundle.packages.map((entry) => {
      const options = cleanOptions(entry.options);
      return {
        Id: entry.manager === 'scoop' ? entry.id.split('/').pop() : entry.id,
        Name: entry.name,
        Version: entry.version,
        Source: bundleSource(entry),
        ManagerName: MANAGER_IDS[entry.manager],
        ...(isEmptyOptions(options) ? {} : { InstallationOptions: { OverridesNextLevelOpts: true, ...options } }),
        ...(entry.ignored ? { Updates: { UpdatesIgnored: true, IgnoredVersion: entry.ignored } } : {}),
      };
    }),
    incompatible_packages_info: INCOMPATIBLE_INFO,
    incompatible_packages: bundle.incompatible.map((entry) => ({ Id: entry.id, Name: entry.name, Version: entry.version, Source: entry.source })),
  };
  return JSON.stringify(data, null, 2);
}

export function bundleFromPackages(packages: Package[], options: Record<string, InstallOptions>, holds: string[], skipped: Record<string, string>): Bundle {
  return {
    version: BUNDLE_VERSION,
    incompatible: [],
    packages: packages.map((entry) => {
      const key = `${entry.manager}:${entry.id}`;
      const ignored = holds.includes(entry.id) || holds.includes(entry.name) ? '*' : skipped[key];
      return { manager: entry.manager, id: entry.id, name: entry.name, version: entry.version, ...(entry.kind ? { kind: entry.kind } : {}), options: options[key] ?? {}, ...(ignored ? { ignored } : {}) };
    }),
  };
}

// ---------- Reading ----------

export type BundleFormat = 'ubundle' | 'json' | 'yaml' | 'xml';

export function formatFromName(name: string): BundleFormat {
  const extension = name.toLowerCase().split('.').pop();
  return extension === 'yaml' || extension === 'yml' ? 'yaml' : extension === 'xml' ? 'xml' : extension === 'json' ? 'json' : 'ubundle';
}

// A small XML reader for UniGetUI's old bundles: elements, attributes and text only. No DTDs and no
// entities beyond the five built-in ones, so nothing can be pulled in from outside the file.
export function xmlToJson(xml: string): unknown {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML bundles with a DOCTYPE are not read');
  const text = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  const decode = (value: string) => value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(x?)([0-9a-f]+);/gi, (_, hex, code) => String.fromCodePoint(Number.parseInt(code, hex ? 16 : 10))).replace(/&amp;/g, '&');
  let index = 0;
  const node = (): unknown => {
    const open = /^<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(text.slice(index));
    if (!open) throw new Error('the XML bundle could not be read');
    index += open[0].length;
    const [, tag, attributes, selfClosing] = open;
    const object: Record<string, unknown> = {};
    for (const match of attributes.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) object[`@${match[1]}`] = decode(match[2] ?? match[3] ?? '');
    if (selfClosing) return Object.keys(object).length ? object : '';
    const children = new Map<string, unknown[]>();
    let ownText = '';
    while (index < text.length) {
      if (text.startsWith(`</${tag}`, index)) {
        index = text.indexOf('>', index) + 1;
        break;
      }
      if (text.startsWith('<![CDATA[', index)) {
        const end = text.indexOf(']]>', index);
        ownText += text.slice(index + 9, end);
        index = end + 3;
      } else if (text[index] === '<') {
        const name = /^<([\w:.-]+)/.exec(text.slice(index))?.[1] ?? '';
        const value = node();
        children.set(name, [...(children.get(name) ?? []), value]);
      } else {
        const end = text.indexOf('<', index);
        ownText += text.slice(index, end < 0 ? text.length : end);
        index = end < 0 ? text.length : end;
      }
    }
    if (children.size === 0 && Object.keys(object).length === 0) return decode(ownText.trim());
    // Same rule as UniGetUI: an element with one kind of child and no attributes becomes that child.
    if (children.size === 1 && Object.keys(object).length === 0) {
      const [values] = children.values();
      return values.length === 1 ? values[0] : values;
    }
    for (const [name, values] of children) object[name] = values.length === 1 ? values[0] : values;
    return object;
  };
  return node();
}

const str = (value: unknown) => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : []);
const bool = (value: unknown) => value === true || value === 'true' || value === 'True';

// XML and YAML carry every value as text; turn the option values back into their types.
function typedOptions(raw: unknown): InstallOptions {
  if (!raw || typeof raw !== 'object') return {};
  const input = { ...(raw as Record<string, unknown>) };
  for (const [key, value] of Object.entries(input)) {
    if (value === 'true' || value === 'false' || value === 'True' || value === 'False') input[key] = bool(value);
    if (key.startsWith('CustomParameters') || key === 'KillBeforeOperation') input[key] = Array.isArray(value) ? value.map(str) : typeof value === 'string' ? [value] : value;
  }
  return cleanOptions(input);
}

export function parseBundle(content: string, format: BundleFormat, platform: NodeJS.Platform): Bundle {
  if (content.length > 5 * 1024 * 1024) throw new Error('the bundle is larger than 5 MB');
  let data: unknown;
  try {
    data = format === 'yaml' ? parseYaml(content, { maxAliasCount: 50 }) : format === 'xml' ? xmlToJson(content) : JSON.parse(content.replace(/^﻿/, ''));
  } catch {
    throw new Error('the file is not a package bundle');
  }
  const root = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  if (!('packages' in root) && !('export_version' in root)) throw new Error('the file is not a package bundle');
  // Package lists exported by Patchday 1.x.
  if (root.format === 'patchday-packages' && Array.isArray(root.packages)) {
    root.packages = (root.packages as Array<Record<string, unknown>>).map((entry) => ({
      Id: entry.id, Name: entry.name, Version: '', ManagerName: entry.manager, Source: entry.kind === 'cask' ? 'Homebrew Cask' : '',
    }));
  }
  const available = new Set(managersFor(platform));
  const bundle: Bundle = { version: Number(root.export_version) || 0, packages: [], incompatible: [] };
  const seen = new Set<string>();
  for (const raw of list(root.packages).slice(0, 5000)) {
    const entry = raw as Record<string, unknown>;
    const id = str(entry.Id).trim();
    const name = str(entry.Name).trim().slice(0, 200) || id;
    const version = str(entry.Version).trim().slice(0, 64);
    const source = str(entry.Source).trim().slice(0, 200);
    const managerName = str(entry.ManagerName);
    const manager = managerFromBundle(managerName);
    if (!manager) {
      bundle.incompatible.push({ id, name, version, source, reason: 'manager-unknown', manager: managerName });
      continue;
    }
    // Sources may read "Scoop: extras"; only the part after the colon names it.
    const sourceName = source.includes(': ') ? source.split(': ').pop() as string : source;
    const kind = manager === 'brew' ? (/cask/i.test(sourceName) ? 'cask' : 'formula') : undefined;
    const fullId = manager === 'scoop' && sourceName && sourceName !== 'main' && !id.includes('/') ? `${sourceName}/${id}` : id;
    if (!isSafeId(manager, fullId)) {
      bundle.incompatible.push({ id, name, version, source, reason: 'invalid-id', manager: managerName });
      continue;
    }
    if (!available.has(manager)) {
      bundle.incompatible.push({ id, name, version, source, reason: 'other-system', manager: managerName });
      continue;
    }
    const key = `${manager}:${fullId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const updates = (entry.Updates && typeof entry.Updates === 'object' ? entry.Updates : {}) as Record<string, unknown>;
    const ignoredVersion = str(updates.IgnoredVersion).trim();
    const ignored = bool(updates.UpdatesIgnored) ? (ignoredVersion || '*') : '';
    bundle.packages.push({
      manager, id: fullId, name, version, ...(kind ? { kind } : {}),
      options: typedOptions(entry.InstallationOptions),
      ...(ignored && ignored.length <= 64 ? { ignored } : {}),
    });
  }
  for (const raw of list(root.incompatible_packages).slice(0, 5000)) {
    const entry = raw as Record<string, unknown>;
    bundle.incompatible.push({ id: str(entry.Id), name: str(entry.Name) || str(entry.Id), version: str(entry.Version), source: str(entry.Source), reason: 'manager-unknown' });
  }
  return bundle;
}

// ---------- Security report ----------

export type Severity = 'high' | 'warning' | 'info';

export interface Finding {
  key: string;
  manager: Manager;
  package: string;
  field: string;
  value: string;
  severity: Severity;
  // True when Patchday removed the value because Settings do not allow it.
  removed: boolean;
}

export interface ImportPolicy {
  // Custom arguments and before/after commands from bundles; both off unless turned on in Settings.
  allowParameters: boolean;
  allowCommands: boolean;
}

// Like UniGetUI: everything that could run code or weaken a check is listed before the import, and
// what Settings do not allow is taken out of the options first.
export function reviewBundle(bundle: Bundle, policy: ImportPolicy): { bundle: Bundle; findings: Finding[] } {
  const findings: Finding[] = [];
  const packages = bundle.packages.map((entry) => {
    const options: InstallOptions = { ...entry.options };
    const note = (field: string, value: string, severity: Severity, removed: boolean) =>
      findings.push({ key: `${entry.manager}:${entry.id}`, manager: entry.manager, package: entry.name, field, value, severity, removed });
    for (const key of PARAMETER_KEYS) {
      const value = options[key];
      if (!value?.length) continue;
      note(key, value.join(' '), 'warning', !policy.allowParameters);
      if (!policy.allowParameters) delete options[key];
    }
    for (const key of COMMAND_KEYS) {
      const value = options[key];
      if (!value) continue;
      note(key, value, 'high', !policy.allowCommands);
      if (!policy.allowCommands) delete options[key];
    }
    if (options.SkipHashCheck) note('SkipHashCheck', 'true', 'high', false);
    if (options.KillBeforeOperation?.length) note('KillBeforeOperation', options.KillBeforeOperation.join(', '), 'high', false);
    if (options.RunAsAdministrator) note('RunAsAdministrator', 'true', 'info', false);
    if (options.CustomInstallLocation) note('CustomInstallLocation', options.CustomInstallLocation, 'info', false);
    if (entry.manager === 'scoop' && entry.id.includes('/') && entry.id.split('/')[0] !== 'main') note('Source', entry.id.split('/')[0], 'info', false);
    return { ...entry, options };
  });
  return { bundle: { ...bundle, packages }, findings };
}
