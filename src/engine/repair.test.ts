import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnoseBrew, diagnoseWinget } from '../core/failures.ts';
import { repairPlan } from '../core/packages.ts';
import { installWithRepair, REINSTALLED, type RepairSteps } from './repair.ts';
import type { ExecResult } from './types.ts';

const fail = (stderr: string, code = 1): ExecResult => ({ code, stdout: '', stderr });
const ok: ExecResult = { code: 0, stdout: '', stderr: '' };

function steps(installs: ExecResult[], fresh: ExecResult | null, diagnose = (r: ExecResult) => diagnoseBrew(r.stderr)) {
  const phases: string[] = [];
  const calls = { refresh: 0, reinstall: 0, sleep: 0 };
  const s: RepairSteps = {
    name: 'demo',
    install: async () => installs.shift() ?? ok,
    diagnose,
    refresh: async () => { calls.refresh++; },
    ...(fresh ? { reinstall: async () => { calls.reinstall++; return fresh; } } : {}),
    sleep: async () => { calls.sleep++; },
    onPhase: (phase) => phases.push(phase),
    log: () => {},
  };
  return { s, phases, calls };
}

test('a working install needs no repair', async () => {
  const { s, phases } = steps([ok], ok);
  assert.deepEqual(await installWithRepair(s), { ok: true, reason: '' });
  assert.deepEqual(phases, ['update']);
});

test('a checksum mismatch refreshes, then installs fresh when it persists', async () => {
  const mismatch = fail('Error: SHA256 mismatch\nExpected: abc\nActual: def');
  const { s, phases, calls } = steps([mismatch, mismatch], ok);
  assert.deepEqual(await installWithRepair(s), { ok: true, reason: REINSTALLED });
  assert.deepEqual(phases, ['update', 'retry', 'reinstall']);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.reinstall, 1);
});

test('an unknown error goes straight to a fresh install', async () => {
  const { s, phases } = steps([fail('Error: something odd')], ok);
  assert.equal((await installWithRepair(s)).ok, true);
  assert.deepEqual(phases, ['update', 'reinstall']);
});

test('missing rights, a running app or a failed fresh install stop with the reason', async () => {
  const rights = steps([fail('sudo: a terminal is required to read the password')], ok);
  assert.deepEqual(await installWithRepair(rights.s), { ok: false, reason: 'needs your admin password', detail: 'sudo: a terminal is required to read the password' });
  assert.equal(rights.calls.reinstall, 0);

  const running = steps([fail('', 0x8a150101 - 0x100000000), fail('', 0x8a150101 - 0x100000000)], ok, (r) => diagnoseWinget(r.code, r.stderr));
  const result = await installWithRepair(running.s);
  assert.equal(result.reason, 'app is running, close it');
  assert.equal(running.calls.sleep, 1);
  assert.equal(running.calls.reinstall, 0, 'a running app is never removed');

  const broken = steps([fail('Error: something odd')], fail('Error: still odd'));
  const last = await installWithRepair(broken.s);
  assert.equal(last.ok, false);
  assert.match(last.detail ?? '', /--- fresh install ---\nError: still odd/);
});

test('repair plans clean the cache and install fresh, per package manager', () => {
  assert.deepEqual(repairPlan({ manager: 'brew', id: 'orbstack', kind: 'cask' }), {
    clean: [{ command: 'brew', args: ['fetch', '--force', '--cask', 'orbstack'] }],
    reinstall: [{ command: 'brew', args: ['reinstall', '--cask', 'orbstack'] }],
  });
  const winget = repairPlan({ manager: 'winget', id: 'Git.Git' });
  assert.deepEqual(winget.reinstall.map((c) => c.args[0]), ['uninstall', 'install']);
  const decode = (args: string[]) => Buffer.from(args.at(-1) as string, 'base64').toString('utf16le');
  assert.match(decode(repairPlan({ manager: 'choco', id: 'git' }).reinstall[0].args), /'install','git','-y','--force'/);
  assert.deepEqual(repairPlan({ manager: 'scoop', id: 'main/ripgrep' }).reinstall.map((c) => decode(c.args)), [
    "& scoop 'uninstall' 'ripgrep'; exit $LASTEXITCODE",
    "& scoop 'install' 'main/ripgrep'; exit $LASTEXITCODE",
  ]);
  assert.throws(() => repairPlan({ manager: 'brew', id: '--force' }), /not a valid package name/);
});

test('Visual Studio and per-user installs get a reason a fresh install cannot fix', async () => {
  const { diagnoseChoco } = await import('../core/failures.ts');
  const choco = "ERROR: After update operation, Visual Studio product: [installPath = 'C:\\BuildTools'] is at version 16.11.37627.13, which is lower than the desired version (16.11.37903.5). This means the update failed.";
  assert.deepEqual(diagnoseChoco(-1, choco), { reason: 'Visual Studio Installer needs you: open it once and update there', final: true });
  const winget = 'Found Visual Studio BuildTools 2019 [Microsoft.VisualStudio.2019.BuildTools] Version 16.11.63\nStarting package install...\nInstaller failed with exit code: 1';
  assert.equal(diagnoseWinget(0x8a150006, winget).reason, 'Visual Studio Installer needs you: open it once and update there');
  assert.equal(diagnoseWinget(0x8a15007d, 'The package installed for user scope cannot be uninstalled when running with administrator privileges.').reason, 'installed for your user only');
  assert.equal(diagnoseWinget(0x8a150006, 'Found Foo [Foo.Bar] Version 1\nInstaller failed with exit code: 1').reason, 'installer stopped with an error (0x8A150006)');
});
