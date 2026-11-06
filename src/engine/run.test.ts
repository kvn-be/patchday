import assert from 'node:assert/strict';
import test from 'node:test';
import { bumpImage } from '../core/compose.ts';
import { parseWingetUpgrade } from '../core/winget.ts';
import { registryRef } from './registry.ts';
import { run, type Deps } from './run.ts';
import { DEFAULT_SETTINGS, type Exec } from './types.ts';

const inspect = (name: string, image: string, health = 'healthy', file = '/srv/web/compose.yml') => ({
  Name: `/${name}`,
  Config: { Image: image, Labels: { 'com.docker.compose.project': 'web', 'com.docker.compose.project.working_dir': '/srv/web', 'com.docker.compose.project.config_files': file, 'com.docker.compose.service': name } },
  State: { Status: 'running', Health: { Status: health } },
});

function harness(options: { healthyAfterDeploy: boolean; tags?: string[]; image?: string }) {
  const image = options.image ?? 'nginx:1.27.1';
  const commands: string[][] = [];
  const files = new Map([['/srv/web/compose.yml', `services:\n  web:\n    image: ${image}\n`]]);
  let clock = 0;
  const current = () => /image: (.+)/.exec(files.get('/srv/web/compose.yml') as string)?.[1] as string;
  const exec: Exec = async (command, args) => {
    commands.push([command, ...args]);
    if (command === 'docker' && args[0] === 'ps') return { code: 0, stdout: 'abc\n', stderr: '' };
    if (command === 'docker' && args[0] === 'inspect') {
      const updated = current() !== image;
      return { code: 0, stdout: JSON.stringify([inspect('web', current(), updated && !options.healthyAfterDeploy ? 'unhealthy' : 'healthy')]), stderr: '' };
    }
    if (command === 'docker' && args[0] === 'manifest') return { code: 0, stdout: '{"manifests":[{"platform":{"architecture":"arm64"}}]}', stderr: '' };
    if (command === 'docker' && args[0] === 'compose') return { code: 0, stdout: '', stderr: '' };
    if (command === 'brew' && args[0] === '--version') return { code: 1, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  const deps: Deps = {
    exec,
    tags: async () => options.tags ?? ['1.27.1', '1.27.2'],
    portainer: null,
    platform: 'darwin',
    arch: 'arm64',
    backupDir: '/backup',
    readFile: async (path) => files.get(path) as string,
    writeFile: async (path, content) => { files.set(path, content); },
    sleep: async (ms) => { clock += ms; },
    now: () => new Date(clock),
    log: () => {},
  };
  return { deps, commands, files, current };
}

test('preview changes nothing', async () => {
  const { deps, commands, current } = harness({ healthyAfterDeploy: true });
  const report = await run(deps, DEFAULT_SETTINGS, 'preview');
  assert.equal(report.items[0].outcome, 'planned');
  assert.equal(current(), 'nginx:1.27.1');
  assert.ok(!commands.some((command) => command.includes('compose')));
});

test('apply backs up, updates and confirms health', async () => {
  const { deps, files, current } = harness({ healthyAfterDeploy: true });
  const report = await run(deps, DEFAULT_SETTINGS, 'apply');
  assert.equal(report.items[0].outcome, 'applied');
  assert.equal(current(), 'nginx:1.27.2');
  const backup = [...files.keys()].find((path) => path.startsWith('/backup/'));
  assert.match(files.get(backup as string) as string, /nginx:1\.27\.1/);
});

test('an unhealthy update rolls back to the old file', async () => {
  const { deps, current } = harness({ healthyAfterDeploy: false });
  const report = await run(deps, DEFAULT_SETTINGS, 'apply');
  assert.equal(report.items[0].outcome, 'rolled-back');
  assert.equal(report.status, 'error');
  assert.equal(current(), 'nginx:1.27.1');
});

test('a major update only becomes a suggestion', async () => {
  const { deps, commands, current } = harness({ healthyAfterDeploy: true, tags: ['1.27.1', '2.0.0'] });
  const report = await run(deps, DEFAULT_SETTINGS, 'apply');
  assert.equal(report.items[0].outcome, 'waiting');
  assert.equal(current(), 'nginx:1.27.1');
  assert.ok(!commands.some((command) => command.includes('compose')));
});

test('a stack that may belong to Portainer is never touched as Compose', async () => {
  const { deps, commands } = harness({ healthyAfterDeploy: true });
  const exec = deps.exec;
  deps.exec = async (command, args, options) => {
    if (args[0] === 'inspect') {
      const web = inspect('web', 'nginx:1.27.1');
      const portainer = { Name: '/portainer', Config: { Image: 'portainer/portainer-ce:2.45.3' }, State: { Status: 'running' } };
      return { code: 0, stdout: JSON.stringify([web, portainer]), stderr: '' };
    }
    return exec(command, args, options);
  };
  const report = await run(deps, DEFAULT_SETTINGS, 'apply');
  assert.equal(report.items.find((item) => item.name === 'web')?.outcome, 'waiting');
  assert.ok(!commands.some((command) => command.includes('compose')));
});

test('bumpImage keeps comments and refuses unknown lines', () => {
  const file = 'services:\n  a:\n    image: "ghcr.io/x/y:1.0.0" # pinned\n';
  assert.equal(bumpImage(file, 'ghcr.io/x/y', '1.0.0', '1.0.1'), 'services:\n  a:\n    image: "ghcr.io/x/y:1.0.1" # pinned\n');
  assert.equal(bumpImage(file, 'ghcr.io/x/z', '1.0.0', '1.0.1'), null);
});

test('registryRef resolves official, user and foreign images', () => {
  assert.deepEqual(registryRef('nginx'), { host: 'docker.io', path: 'library/nginx' });
  assert.deepEqual(registryRef('louislam/uptime-kuma'), { host: 'docker.io', path: 'louislam/uptime-kuma' });
  assert.deepEqual(registryRef('ghcr.io/a/b'), { host: 'ghcr.io', path: 'a/b' });
});

test('parseWingetUpgrade cuts columns at the header', () => {
  const output = [
    'Name            Id              Version  Available Source',
    '---------------------------------------------------------',
    'Mozilla Firefox Mozilla.Firefox 130.0    131.0     winget',
    '1 upgrades available.',
  ].join('\r\n');
  assert.deepEqual(parseWingetUpgrade(output), [{ name: 'Mozilla Firefox', id: 'Mozilla.Firefox', installed: '130.0', available: '131.0' }]);
});
