import assert from 'node:assert/strict';
import test from 'node:test';
import type { Package } from '../core/packages.ts';
import { act, listInstalled, search } from './packages.ts';
import { run, type Deps } from './run.ts';
import { DEFAULT_SETTINGS, type ExecResult } from './types.ts';

type Script = (command: string, args: string[], script: string) => Partial<ExecResult> | null;

// PowerShell calls carry their script encoded; the fake decodes it so tests can match on it.
function fake(platform: NodeJS.Platform, script: Script) {
  const calls: string[] = [];
  const exec = async (command: string, args: string[]): Promise<ExecResult> => {
    const decoded = command === 'powershell' ? Buffer.from(args.at(-1) as string, 'base64').toString('utf16le') : '';
    calls.push(command === 'powershell' ? `ps: ${decoded}` : [command, ...args].join(' '));
    return { code: 0, stdout: '', stderr: '', ...(script(command, args, decoded) ?? {}) };
  };
  return { deps: { exec, platform }, calls };
}

const WINGET_LIST = ['Name Id      Version Available Source', '------------------------------------', 'Git  Git.Git 2.46.0  2.47.0    winget'].join('\n');
const SCOOP_EXPORT = JSON.stringify({ apps: [{ Name: 'ripgrep', Version: '14.1.0', Source: 'main' }] });
const SCOOP_STATUS = ['Name    Installed Version Latest Version Missing Dependencies Info', '----    ----------------- -------------- -------------------- ----', 'ripgrep 14.1.0            14.1.1', ''].join('\n');

test('Windows inventory merges winget, Chocolatey and Scoop and skips missing managers', async () => {
  const { deps } = fake('win32', (command, args, decoded) => {
    if (command === 'winget' && args[0] === 'list') return { stdout: WINGET_LIST };
    if (command === 'choco' && args[0] === '--version') return { code: 1 };
    if (decoded.includes("'export'")) return { stdout: SCOOP_EXPORT };
    if (decoded.includes("'status'")) return { stdout: SCOOP_STATUS };
    return null;
  });
  const inventory = await listInstalled(deps);
  assert.deepEqual(inventory.managers, ['winget', 'scoop']);
  assert.deepEqual(inventory.packages.map((entry) => `${entry.manager}:${entry.id}:${entry.version}>${entry.available ?? ''}`), [
    'winget:Git.Git:2.46.0>2.47.0',
    'scoop:ripgrep:14.1.0>14.1.1',
  ]);
  assert.deepEqual(inventory.problems, []);
});

test('a broken manager is reported with a next step and the others still show', async () => {
  const { deps } = fake('darwin', (command, args) => (command === 'brew' && args[0] === 'info' ? { code: 1, stderr: 'Error: broken' } : null));
  const inventory = await listInstalled(deps);
  assert.deepEqual(inventory.packages, []);
  assert.deepEqual(inventory.problems, ['Homebrew: brew info failed. Run it once in a terminal to see why, then refresh.']);
});

test('search refuses unsafe queries and asks each chosen manager', async () => {
  const { deps, calls } = fake('darwin', (command, args) => {
    if (args[1] === '--formula') return { stdout: 'wget\n' };
    if (args[1] === '--cask') return { code: 1, stderr: 'Error: No casks found' };
    return null;
  });
  await assert.rejects(search(deps, '--help', ['brew']), /letters, numbers/);
  const result = await search(deps, 'wget', ['brew']);
  assert.deepEqual(result.packages.map((entry) => `${entry.kind}:${entry.id}`), ['formula:wget']);
  assert.deepEqual(calls, ['brew search --formula wget', 'brew search --cask wget']);
});

test('actions run one by one, a failure keeps its reason and the rest go on', async () => {
  const { deps, calls } = fake('win32', (command, args, decoded) => {
    if (command === 'winget' && args.includes('Bad.App')) return { code: 0x8a150019 - 0x100000000, stdout: 'needs admin' };
    if (decoded.includes('Start-Process')) return { code: 1, stderr: 'The operation was canceled by the user.' };
    return null;
  });
  const packages: Package[] = [
    { manager: 'winget', id: 'Git.Git', name: 'Git', version: '' },
    { manager: 'winget', id: 'Bad.App', name: 'Bad', version: '' },
    { manager: 'choco', id: 'git', name: 'git', version: '' },
    { manager: 'scoop', id: 'main/ripgrep', name: 'ripgrep', version: '' },
  ];
  const seen: number[] = [];
  const results = await act(deps, 'install', packages, (_, index) => seen.push(index));
  assert.deepEqual(seen, [0, 1, 2, 3]);
  assert.deepEqual(results.map((result) => [result.key, result.ok, result.reason]), [
    ['winget:Git.Git', true, ''],
    ['winget:Bad.App', false, 'needs administrator rights'],
    ['choco:git', false, 'the admin prompt was cancelled'],
    ['scoop:main/ripgrep', true, ''],
  ]);
  assert.equal(calls.length, 4);
});

test('an invalid id never reaches a command', async () => {
  const { deps, calls } = fake('win32', () => null);
  const [result] = await act(deps, 'uninstall', [{ manager: 'choco', id: 'x & calc', name: 'x', version: '' }]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /not a valid package name/);
  assert.deepEqual(calls, []);
});

function runDeps(script: Script): { deps: Deps; calls: string[] } {
  const { deps, calls } = fake('win32', script);
  let clock = 0;
  return {
    calls,
    deps: {
      exec: deps.exec, tags: async () => [], portainer: null, platform: 'win32', arch: 'x64', backupDir: '/b',
      readFile: async () => '', writeFile: async () => {}, sleep: async (ms) => { clock += ms; }, now: () => new Date(clock), log: () => {},
    },
  };
}

test('scheduled runs update Scoop apps and leave skipped versions alone', async () => {
  let updated = false;
  const { deps, calls } = runDeps((command, args, decoded) => {
    if (command === 'docker' || command === 'choco') return { code: 1 };
    if (decoded.includes("'status'")) return { stdout: updated ? '' : SCOOP_STATUS };
    if (decoded.includes("'update' 'ripgrep'")) { updated = true; return null; }
    return null;
  });
  const preview = await run(deps, { ...DEFAULT_SETTINGS }, 'preview');
  assert.deepEqual(preview.items.map((item) => `${item.source}:${item.name}:${item.outcome}`), ['scoop:ripgrep:planned']);
  const skipped = await run(deps, { ...DEFAULT_SETTINGS, skipped: { 'scoop:ripgrep': '14.1.1' } }, 'preview');
  assert.deepEqual(skipped.items, []);
  const applied = await run(deps, { ...DEFAULT_SETTINGS }, 'apply');
  assert.deepEqual(applied.items.map((item) => `${item.name}:${item.outcome}:${item.from}>${item.to}`), ['ripgrep:applied:14.1.0>14.1.1']);
  assert.ok(calls.includes("ps: & scoop 'update'; exit $LASTEXITCODE"), 'buckets are refreshed before a real run');
});
