export interface OutdatedPackage {
  name: string;
  kind: 'formula' | 'cask';
  installed: string;
  available: string;
}

interface OutdatedEntry {
  name: string;
  installed_versions: string[] | string;
  current_version: string;
}

function toPackage(entry: OutdatedEntry, kind: OutdatedPackage['kind']): OutdatedPackage {
  // Homebrew reports an array for formulae, and a string for casks on older versions.
  const versions = [entry.installed_versions].flat();
  return { name: entry.name, kind, installed: versions.at(-1) ?? '', available: entry.current_version };
}

export function parseOutdated(json: string): OutdatedPackage[] {
  const { formulae = [], casks = [] } = JSON.parse(json) as { formulae?: OutdatedEntry[]; casks?: OutdatedEntry[] };
  return [...formulae.map((entry) => toPackage(entry, 'formula')), ...casks.map((entry) => toPackage(entry, 'cask'))];
}

// Upgrading these restarts the Docker daemon, so they run last.
const DOCKER_RUNTIMES = new Set(['orbstack', 'docker', 'docker-desktop', 'colima', 'rancher']);

export function restartsDocker(entry: OutdatedPackage): boolean {
  return entry.kind === 'cask' && DOCKER_RUNTIMES.has(entry.name);
}

export function upgradeOrder(packages: OutdatedPackage[]): OutdatedPackage[] {
  return [...packages].sort((a, b) => Number(restartsDocker(a)) - Number(restartsDocker(b)));
}

export function upgradeArgs(entry: OutdatedPackage, force = false): string[] {
  const kind = entry.kind === 'cask' ? ['--cask', '--greedy'] : ['--formula'];
  return ['upgrade', ...kind, ...(force ? ['--force'] : []), entry.name];
}
