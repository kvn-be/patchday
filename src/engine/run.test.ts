import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bumpImage } from '../core/compose.ts';
import { isNewer, MAC_SWAP_SCRIPT, macChecksum, macSize, pickRelease } from '../core/selfupdate.ts';
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

test('update now applies a waiting major update with backup and health test', async () => {
  const { deps, files, current } = harness({ healthyAfterDeploy: true, tags: ['1.27.1', '2.0.0'] });
  const preview = await run(deps, DEFAULT_SETTINGS, 'preview');
  assert.equal(preview.items[0].key, 'nginx:2.0.0');
  const report = await run(deps, DEFAULT_SETTINGS, 'apply', ['nginx:2.0.0']);
  assert.deepEqual([report.items[0].outcome, report.items[0].reason], ['applied', 'updated by you']);
  assert.equal(current(), 'nginx:2.0.0');
  assert.ok([...files.keys()].some((path) => path.startsWith('/backup/')));
});

test('update now rolls back an unhealthy container', async () => {
  const { deps, current } = harness({ healthyAfterDeploy: false, tags: ['1.27.1', '2.0.0'] });
  const report = await run(deps, DEFAULT_SETTINGS, 'apply', ['nginx:2.0.0']);
  assert.equal(report.items[0].outcome, 'rolled-back');
  assert.equal(current(), 'nginx:1.27.1');
});

test('update now leaves other containers alone', async () => {
  const { deps, current } = harness({ healthyAfterDeploy: true });
  const report = await run(deps, DEFAULT_SETTINGS, 'apply', ['other:9.9.9']);
  assert.equal(report.items[0].outcome, 'planned');
  assert.equal(current(), 'nginx:1.27.1');
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

function packageHarness(platform: NodeJS.Platform, script: (command: string, args: string[], calls: number) => { code: number; stdout?: string; stderr?: string } | null) {
  let clock = 0;
  const commands: string[][] = [];
  const progress: string[] = [];
  const deps: Deps = {
    exec: async (command, args) => {
      commands.push([command, ...args]);
      if (command === 'docker') return { code: 1, stdout: '', stderr: '' };
      const calls = commands.filter((entry) => entry.join(' ') === [command, ...args].join(' ')).length;
      return { stdout: '', stderr: '', ...(script(command, args, calls) ?? { code: 0 }) };
    },
    tags: async () => [],
    portainer: null,
    platform,
    arch: 'arm64',
    backupDir: '/backup',
    readFile: async () => '',
    writeFile: async () => {},
    sleep: async (ms) => { clock += ms; },
    now: () => new Date(clock),
    log: () => {},
    onProgress: (items) => { progress.push(items.map((item) => `${item.name}:${item.state}`).join(',')); },
  };
  return { deps, commands, progress };
}

const WINGET_LIST = ['Name  Id     Version Available Source', '--------------------------------------', 'Fire  Fox.F  1.0     2.0       winget', 'Note  Pad.N  1.0     2.0       winget'].join('\n');

test('winget: a running app is retried and a failure keeps its short reason', async () => {
  const { deps, progress } = packageHarness('win32', (command, args, calls) => {
    if (args[0] === 'upgrade' && args[1] === '--id') {
      if (args[2] === 'Fox.F') return calls === 1 ? { code: 0x8a150101 - 2 ** 32 } : { code: 0 };
      return { code: 0x8a150105 - 2 ** 32 };
    }
    if (args[0] === 'upgrade') return { code: 0, stdout: calls === 1 ? WINGET_LIST : [WINGET_LIST.split('\n')[0], WINGET_LIST.split('\n')[1], WINGET_LIST.split('\n')[3]].join('\n') };
    return null;
  });
  const report = await run(deps, DEFAULT_SETTINGS, 'apply');
  const [fox, pad] = report.items;
  assert.equal(fox.outcome, 'applied');
  assert.equal(pad.outcome, 'failed');
  assert.equal(pad.reason, 'disk is full');
  assert.equal(progress[0], 'Fire:queued,Note:queued');
  assert.equal(progress.at(-1), 'Fire:done,Note:failed');
});

test('winget: a restart needed to finish counts as applied', async () => {
  const { deps } = packageHarness('win32', (_command, args) => {
    if (args[1] === '--id') return { code: 3010 };
    if (args[0] === 'upgrade') return { code: 0, stdout: WINGET_LIST };
    return null;
  });
  const report = await run(deps, DEFAULT_SETTINGS, 'apply');
  assert.deepEqual(report.items.map((item) => [item.outcome, item.reason]), [['applied', 'restart to finish'], ['applied', 'restart to finish']]);
});

test('brew: an existing app is repaired with one forced retry', async () => {
  const outdated = JSON.stringify({ formulae: [], casks: [{ name: 'firefox', installed_versions: '1', current_version: '2' }] });
  let fixed = false;
  const { deps, commands } = packageHarness('darwin', (_command, args) => {
    if (args[0] === 'outdated') return { code: 0, stdout: fixed ? '{}' : outdated };
    if (args[0] === 'upgrade') {
      if (!args.includes('--force')) return { code: 1, stderr: 'Error: It seems there is already an App at /Applications/Firefox.app' };
      fixed = true;
    }
    return null;
  });
  const report = await run(deps, DEFAULT_SETTINGS, 'apply');
  assert.equal(report.items[0].outcome, 'applied');
  assert.ok(commands.some((command) => command.includes('--force')));
});

test('brew: a failed package names the cause, not a command', async () => {
  const outdated = JSON.stringify({ formulae: [], casks: [{ name: 'tool', installed_versions: '1', current_version: '2' }] });
  const { deps } = packageHarness('darwin', (_command, args) => {
    if (args[0] === 'outdated') return { code: 0, stdout: outdated };
    if (args[0] === 'upgrade') return { code: 1, stderr: 'sudo: a terminal is required to read the password' };
    return null;
  });
  const report = await run(deps, DEFAULT_SETTINGS, 'apply');
  assert.equal(report.items[0].reason, 'needs your admin password');
});

test('self update picks the highest published version and skips drafts', () => {
  const release = (tag_name: string, draft = false) => ({ tag_name, draft, assets: [{ name: 'a.zip', browser_download_url: 'https://x/a.zip' }] });
  assert.equal(pickRelease([release('v0.3.0', true), release('v0.2.1'), release('v0.2.0')], '0.2.0')?.version, '0.2.1');
  assert.equal(pickRelease([release('v0.2.0'), release('v0.1.0')], '0.2.0'), null);
  assert.equal(isNewer('v0.10.0', '0.9.9'), true);
  assert.equal(isNewer('v1.0.0-beta', '0.9.9'), false);
  // A release still uploading, or missing this Mac's files, is skipped for the newest complete one.
  const asset = (name: string, state = 'uploaded') => ({ name, browser_download_url: `https://x/${name}`, state });
  const needs = (version: string) => ['latest-mac.yml', `Patchday-${version}-arm64.zip`];
  const uploading = { tag_name: 'v1.1.0', draft: false, assets: [asset('latest-mac.yml'), asset('Patchday-1.1.0-arm64.zip', 'starter')] };
  const partial = { tag_name: 'v1.0.1', draft: false, assets: [asset('latest-mac.yml')] };
  const complete = { tag_name: 'v1.0.0', draft: false, assets: [asset('latest-mac.yml'), asset('Patchday-1.0.0-arm64.zip')] };
  assert.equal(pickRelease([uploading, partial, complete], '0.2.3', needs)?.version, '1.0.0');
  assert.equal(macSize('files:\n  - url: a.zip\n    sha512: X\n    size: 42\npath: a.zip\n', 'a.zip'), 42);
});

test('macChecksum reads the checksum of exactly one file', () => {
  const yml = 'version: 0.3.0\nfiles:\n  - url: Patchday-0.3.0-arm64.zip\n    sha512: AAA==\n    size: 1\n  - url: Patchday-0.3.0-x64.zip\n    sha512: BBB==\n    size: 2\npath: x\n';
  assert.equal(macChecksum(yml, 'Patchday-0.3.0-x64.zip'), 'BBB==');
  assert.equal(macChecksum(yml, 'other.zip'), null);
});

test('the swap script keeps the old app when the new one cannot be moved', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'swap-'));
  const script = join(folder, 'swap.sh');
  await writeFile(script, MAC_SWAP_SCRIPT.replace('open "$2"', 'true'));
  await mkdir(join(folder, 'Old.app'));
  await writeFile(join(folder, 'Old.app', 'old'), '1');
  await mkdir(join(folder, 'New.app'));
  await writeFile(join(folder, 'New.app', 'new'), '1');
  const swap = (fresh: string) => new Promise((done) => execFile('bash', [script, '999999', join(folder, 'Old.app'), fresh], done));
  await swap(join(folder, 'Missing.app'));
  assert.deepEqual(await readdir(join(folder, 'Old.app')), ['old']);
  await swap(join(folder, 'New.app'));
  assert.deepEqual(await readdir(join(folder, 'Old.app')), ['new']);
  assert.ok(!(await readdir(folder)).includes('Old.app.previous'));
  await rm(folder, { recursive: true });
});

test('the swap script opens the app again only after a restart, not after closing', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'swap-'));
  const script = join(folder, 'swap.sh');
  await writeFile(script, MAC_SWAP_SCRIPT);
  // A stand-in for macOS `open` that only leaves a mark.
  await writeFile(join(folder, 'open'), `#!/bin/bash\ntouch "${folder}/opened"\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${folder}:${process.env.PATH}` };
  const swap = async (name: string, ...extra: string[]) => {
    await mkdir(join(folder, `${name}.app`));
    await new Promise((done) => execFile('bash', [script, '999999', join(folder, 'Patchday.app'), join(folder, `${name}.app`), ...extra], { env }, done));
  };
  await mkdir(join(folder, 'Patchday.app'));
  await swap('A', '--no-open');
  assert.ok(!(await readdir(folder)).includes('opened'));
  await swap('B');
  assert.ok((await readdir(folder)).includes('opened'));
  await rm(folder, { recursive: true });
});

test('winget: a path error is repaired with a forced install', async () => {
  let done = false;
  const { deps, commands } = packageHarness('win32', (command, args) => {
    if (command === 'choco') return { code: 1 };
    if (args[0] === 'install') { done = true; return { code: 0 }; }
    if (args[1] === '--id') return { code: 1, stdout: 'The system cannot find the path specified.' };
    if (args[0] === 'upgrade') return { code: 0, stdout: done ? '' : ['Name  Id     Version Available Source', '--------------------------------------', 'Fire  Fox.F  1.0     2.0       winget'].join('\n') };
    return null;
  });
  const report = await run(deps, DEFAULT_SETTINGS, 'apply');
  assert.equal(report.items[0].outcome, 'applied');
  assert.ok(commands.some((command) => command.includes('install') && command.includes('--force')));
});

test('winget: a shortened id is matched by prefix, unknown errors keep their code', async () => {
  const { deps, commands } = packageHarness('win32', (command, args) => {
    if (command === 'choco') return { code: 1 };
    if (args[1] === '--id') return { code: 0x80004005 - 2 ** 32, stdout: 'Installer failed\nsome detail' };
    if (args[0] === 'upgrade') return { code: 0, stdout: ['Name  Id         Version Available Source', '------------------------------------------', 'Long  Very.Lon…  1.0     2.0       winget'].join('\n') };
    return null;
  });
  const report = await run(deps, DEFAULT_SETTINGS, 'apply');
  const call = commands.find((command) => command[2] === '--id') as string[];
  assert.equal(call[3], 'Very.Lon');
  assert.ok(!call.includes('--exact'));
  assert.equal(report.items[0].reason, 'installer stopped with an error (0x80004005)');
  assert.match(report.items[0].detail as string, /some detail/);
});

test('choco: runs before winget, skips pinned packages, and winget skips what it updated', async () => {
  let updated = false;
  const { deps, commands } = packageHarness('win32', (command, args) => {
    if (command === 'choco') {
      if (args[0] === '--version') return { code: 0, stdout: '2.3.0' };
      if (args[0] === 'outdated') return { code: 0, stdout: updated ? 'Chocolatey v2.3.0\nkeep|1.0|2.0|true\n' : 'Chocolatey v2.3.0\nfirefox|130.0|131.0|false\nkeep|1.0|2.0|true\n' };
      if (args[0] === 'upgrade') { updated = true; return { code: 0 }; }
    }
    if (args[0] === 'upgrade' && args[1] !== '--id') return { code: 0, stdout: updated ? '' : ['Name  Id     Version Available Source', '--------------------------------------', 'Fire  Fox.F  130.0   131.0     winget'].join('\n') };
    return null;
  });
  const report = await run(deps, DEFAULT_SETTINGS, 'apply');
  const by = (name: string) => report.items.find((item) => item.name === name);
  assert.equal(by('keep')?.outcome, 'waiting');
  assert.equal(by('firefox')?.outcome, 'applied');
  assert.equal(by('Fire')?.reason, 'already updated by Chocolatey');
  assert.ok(!commands.some((command) => command[0] === 'winget' && command[2] === '--id'));
});

test('parseWingetUpgrade ignores notices and the second table below the packages', () => {
  const output = [
    'Name            Id              Version  Available Source',
    '---------------------------------------------------------',
    'Mozilla Firefox Mozilla.Firefox 130.0    131.0     winget',
    '1 upgrades available.',
    '',
    '2 package(s) have version numbers that cannot be determined. Use --include-unknown to see all results.',
    'The following packages have an upgrade available, but require explicit targeting for upgrade:',
    'Name  Id       Version Available Source',
    '---------------------------------------',
    'Other Some.App 1.0     2.0       winget',
  ].join('\r\n');
  assert.deepEqual(parseWingetUpgrade(output).map((entry) => entry.id), ['Mozilla.Firefox']);
});

test('winget: success without a new version gets one forced install', async () => {
  let forced = false;
  const { deps } = packageHarness('win32', (command, args) => {
    if (command === 'choco') return { code: 1 };
    if (args[0] === 'install') { forced = true; return { code: 0 }; }
    if (args[1] === '--id') return { code: 0 };
    if (args[0] === 'upgrade') return { code: 0, stdout: forced ? '' : ['Name  Id     Version Available Source', '--------------------------------------', 'Fire  Fox.F  1.0     2.0       winget'].join('\n') };
    return null;
  });
  const report = await run(deps, DEFAULT_SETTINGS, 'apply');
  assert.equal(report.items[0].outcome, 'applied');
  assert.ok(forced);
});

test('winget: no update path is repaired with a forced install', async () => {
  let forced = false;
  const { deps } = packageHarness('win32', (command, args) => {
    if (command === 'choco') return { code: 1 };
    if (args[0] === 'install') { forced = true; return { code: 0 }; }
    if (args[1] === '--id') return { code: 0x8a15002b - 2 ** 32 };
    if (args[0] === 'upgrade') return { code: 0, stdout: forced ? '' : ['Name  Id     Version Available Source', '--------------------------------------', 'Fire  Fox.F  1.0     2.0       winget'].join('\n') };
    return null;
  });
  assert.equal((await run(deps, DEFAULT_SETTINGS, 'apply')).items[0].outcome, 'applied');
});

test('winget: a beta is never offered for a stable install', async () => {
  const list = ['Name      Id                  Version Available     Source', '-'.repeat(60), 'TeamSpeak TeamSpeakSystems.TS 5.0.0   6.0.0-beta4.1 winget'].join('\n');
  const { deps, commands } = packageHarness('win32', (_command, args) => (args[0] === 'upgrade' && args[1] !== '--id' ? { code: 0, stdout: list } : null));
  const report = await run(deps, DEFAULT_SETTINGS, 'apply');
  assert.deepEqual(report.items.map((item) => [item.name, item.outcome, item.reason, item.id]), [['TeamSpeak', 'waiting', 'prerelease', 'TeamSpeakSystems.TS']]);
  assert.ok(!commands.some((entry) => entry.includes('TeamSpeakSystems.TS') && entry[1] !== 'list'));
});

test('winget: a per-user install in an admin run is reported for the retry and keeps its id', async () => {
  const userScope = 'Successfully extracted archive\nThe package installed for user scope cannot be uninstalled when running with administrator privileges.';
  const { deps } = packageHarness('win32', (_command, args) => {
    if (args[1] === '--id') return { code: 0x8a15007d - 2 ** 32, stdout: userScope };
    if (args[0] === 'upgrade') return { code: 0, stdout: WINGET_LIST.split('\n').slice(0, 3).join('\n') };
    return null;
  });
  const [fox] = (await run(deps, DEFAULT_SETTINGS, 'apply')).items;
  assert.equal(fox.outcome, 'failed');
  assert.equal(fox.reason, 'installed for your user only');
  assert.equal(fox.id, 'Fox.F');
});
