// 'unverified': Compose labels exist, but Portainer runs here and may own the stack.
export type Manager = 'portainer' | 'compose' | 'unverified' | null;

export interface ImageRef {
  repository: string;
  tag: string;
  digest: string | null;
}

export interface ContainerInfo {
  name: string;
  image: ImageRef;
  stack: string | null;
  manager: Manager;
  healthy: boolean;
  restartCount: number;
  service: string | null;
  composeFile: string | null;
  postgresUser: string | null;
  // Where the image's code lives, from the OCI label, for release notes.
  source: string | null;
}

interface InspectEntry {
  Name: string;
  RestartCount?: number;
  Config: { Image: string; Labels?: Record<string, string> | null; Env?: string[] | null };
  State: { Status: string; Health?: { Status: string } | null };
}

const PROJECT_LABEL = 'com.docker.compose.project';
const WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir';
const SERVICE_LABEL = 'com.docker.compose.service';
const CONFIG_FILES_LABEL = 'com.docker.compose.project.config_files';

// Portainer deploys stacks from its own data volume, e.g. /data/compose/12.
const PORTAINER_DIR = /(^|\/)compose\/\d+(\/|$)/;

function singleFile(files: string | undefined): string | null {
  if (!files || files.includes(',')) return null;
  return files;
}

export function parseImageRef(reference: string): ImageRef {
  const [withoutDigest, digest = null] = reference.split('@');
  // A colon before the last slash is a registry port, not a tag.
  const lastSlash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.indexOf(':', lastSlash + 1);
  if (colon === -1) return { repository: withoutDigest, tag: 'latest', digest };
  return { repository: withoutDigest.slice(0, colon), tag: withoutDigest.slice(colon + 1), digest };
}

// Compose labels alone cannot prove who owns a stack: a Portainer stack redeployed
// from elsewhere keeps its name but not its /data/compose path. Pass the stack names
// from the Portainer API when available; without them, nothing outside a proven
// Portainer project counts as plain Compose while Portainer is running.
export function parseInspect(entries: InspectEntry[], portainerStacks?: string[]): ContainerInfo[] {
  const owned = new Set(portainerStacks ?? []);
  let portainerRunning = false;
  for (const entry of entries) {
    const labels = entry.Config.Labels ?? {};
    const project = labels[PROJECT_LABEL];
    if (project && PORTAINER_DIR.test(labels[WORKING_DIR_LABEL] ?? '')) owned.add(project);
    if (/(^|\/)portainer(-ce|-ee)?$/.test(parseImageRef(entry.Config.Image).repository)) portainerRunning = true;
  }
  const fallback: Manager = portainerRunning && portainerStacks === undefined ? 'unverified' : 'compose';

  return entries.map((entry) => {
    const stack = entry.Config.Labels?.[PROJECT_LABEL] ?? null;
    const manager: Manager = stack === null ? null : owned.has(stack) ? 'portainer' : fallback;
    const health = entry.State.Health?.Status;
    return {
      name: entry.Name.replace(/^\//, ''),
      image: parseImageRef(entry.Config.Image),
      stack,
      manager,
      healthy: entry.State.Status === 'running' && (health === undefined || health === 'healthy'),
      restartCount: entry.RestartCount ?? 0,
      service: entry.Config.Labels?.[SERVICE_LABEL] ?? null,
      // Several files mean overrides; only a single file can be edited safely.
      composeFile: singleFile(entry.Config.Labels?.[CONFIG_FILES_LABEL]),
      postgresUser: entry.Config.Env?.find((line) => line.startsWith('POSTGRES_USER='))?.slice('POSTGRES_USER='.length) ?? null,
      source: entry.Config.Labels?.['org.opencontainers.image.source'] ?? null,
    };
  });
}
