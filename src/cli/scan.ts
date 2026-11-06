import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseOutdated, type OutdatedPackage } from '../core/brew.ts';
import { parseInspect, type ContainerInfo } from '../core/docker.ts';
import { protectedCategory } from '../core/policy.ts';

const run = promisify(execFile);
const OPTIONS = { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 };

// Read-only: this command must never change anything on the machine.
async function scanDocker(): Promise<ContainerInfo[]> {
  const { stdout: ids } = await run('docker', ['ps', '-q'], OPTIONS);
  const list = ids.split('\n').filter(Boolean);
  if (list.length === 0) return [];
  const { stdout } = await run('docker', ['inspect', ...list], OPTIONS);
  return parseInspect(JSON.parse(stdout));
}

async function scanBrew(): Promise<OutdatedPackage[]> {
  const { stdout } = await run('brew', ['outdated', '--json=v2', '--greedy'], {
    ...OPTIONS,
    env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1' },
  });
  return parseOutdated(stdout);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] : String(error);
}

const [docker, brew] = await Promise.allSettled([scanDocker(), scanBrew()]);

if (docker.status === 'fulfilled') {
  console.log(`Docker: ${docker.value.length} running containers`);
  for (const container of docker.value) {
    const { repository, tag } = container.image;
    const notes = [
      container.manager ?? 'unmanaged',
      container.healthy ? null : 'unhealthy',
      protectedCategory(repository) ? `protected: ${protectedCategory(repository)}` : null,
    ].filter(Boolean);
    console.log(`  ${container.name}  ${repository}:${tag}  [${notes.join(', ')}]`);
  }
} else {
  console.log(`Docker: not available (${reason(docker.reason)})`);
}

if (brew.status === 'fulfilled') {
  console.log(`Homebrew: ${brew.value.length} outdated packages`);
  for (const item of brew.value) console.log(`  ${item.kind} ${item.name}  ${item.installed} -> ${item.available}`);
} else {
  console.log(`Homebrew: not available (${reason(brew.reason)})`);
}
