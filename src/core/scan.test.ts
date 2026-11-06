import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOutdated } from './brew.ts';
import { parseImageRef, parseInspect } from './docker.ts';

test('parseImageRef separates registry port, tag and digest', () => {
  assert.deepEqual(parseImageRef('redis'), { repository: 'redis', tag: 'latest', digest: null });
  assert.deepEqual(parseImageRef('localhost:5000/app'), { repository: 'localhost:5000/app', tag: 'latest', digest: null });
  assert.deepEqual(parseImageRef('ghcr.io/a/b:1.2-alpine@sha256:abc'), { repository: 'ghcr.io/a/b', tag: '1.2-alpine', digest: 'sha256:abc' });
});

test('parseInspect detects manager and health', () => {
  const base = { Config: { Image: 'nginx:1.27' }, State: { Status: 'running' } };
  const [plain, compose, portainer, sick] = parseInspect([
    { ...base, Name: '/plain' },
    { Name: '/c', Config: { Image: 'nginx:1.27', Labels: { 'com.docker.compose.project': 'web', 'com.docker.compose.project.working_dir': '/srv/web' } }, State: { Status: 'running' } },
    { Name: '/p', Config: { Image: 'nginx:1.27', Labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.project.working_dir': '/data/compose/12' } }, State: { Status: 'running' } },
    { Name: '/s', Config: { Image: 'nginx:1.27' }, State: { Status: 'running', Health: { Status: 'unhealthy' } } },
  ]);
  assert.equal(plain.name, 'plain');
  assert.equal(plain.manager, null);
  assert.equal(plain.healthy, true);
  assert.equal(compose.manager, 'compose');
  assert.equal(portainer.manager, 'portainer');
  assert.equal(sick.healthy, false);
});

test('parseOutdated accepts array and string versions', () => {
  const json = JSON.stringify({
    formulae: [{ name: 'git', installed_versions: ['2.50.0', '2.51.0'], current_version: '2.52.0' }],
    casks: [{ name: 'orbstack', installed_versions: '1.9.0', current_version: '2.0.0' }],
  });
  assert.deepEqual(parseOutdated(json), [
    { name: 'git', kind: 'formula', installed: '2.51.0', available: '2.52.0' },
    { name: 'orbstack', kind: 'cask', installed: '1.9.0', available: '2.0.0' },
  ]);
});

test('parseInspect never treats a possible Portainer stack as plain Compose', () => {
  const running = { Status: 'running' };
  const service = (name: string, project: string, dir: string) => ({
    Name: name,
    Config: { Image: 'nginx:1.27', Labels: { 'com.docker.compose.project': project, 'com.docker.compose.project.working_dir': dir } },
    State: running,
  });
  const entries = [
    { Name: '/portainer', Config: { Image: 'portainer/portainer-ce:2.45.3' }, State: running },
    service('/a', 'mixed', '/data/compose/100'),
    service('/b', 'mixed', '/home/me/stacks/100'),
    service('/c', 'moved', '/home/me/stacks/103'),
  ];
  const managers = (stacks?: string[]) => parseInspect(entries, stacks).map((container) => container.manager);
  assert.deepEqual(managers(), [null, 'portainer', 'portainer', 'unverified']);
  assert.deepEqual(managers(['moved']), [null, 'portainer', 'portainer', 'portainer']);
  assert.deepEqual(managers([]), [null, 'portainer', 'portainer', 'compose']);
});
