export interface BrewPlanOptions {
  holds: string[];
}

export interface BrewStep {
  args: string[];
  restartsDocker: boolean;
}

// Upgrading these restarts the Docker daemon, so they run last and alone.
const DOCKER_RUNTIMES = new Set(['orbstack', 'docker', 'docker-desktop', 'colima', 'rancher']);

// Never replace the app while it is running its own update job.
const SELF = 'patchday';

export function planBrew(outdatedCasks: string[], options: BrewPlanOptions = { holds: [] }): BrewStep[] {
  const held = new Set([SELF, ...options.holds]);
  const casks = outdatedCasks.filter((cask) => !held.has(cask));
  const regular = casks.filter((cask) => !DOCKER_RUNTIMES.has(cask));
  const runtimes = casks.filter((cask) => DOCKER_RUNTIMES.has(cask));

  const steps: BrewStep[] = [{ args: ['upgrade', '--formula'], restartsDocker: false }];
  if (regular.length > 0) steps.push({ args: ['upgrade', '--cask', '--greedy', ...regular], restartsDocker: false });
  for (const runtime of runtimes) steps.push({ args: ['upgrade', '--cask', '--greedy', runtime], restartsDocker: true });
  return steps;
}

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
