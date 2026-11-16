import assert from 'node:assert/strict';
import test from 'node:test';
import { matchStartApp, parseCaskApps, parsePaths } from '../core/apps.ts';
import { CLOSED_AND_UPDATED, DID_NOT_CLOSE, OPENED_NO_UPDATE, rescue, UPDATED_BY_ITSELF, UPDATED_WITH_INSTALLER, type RescueDeps } from './rescue.ts';
import type { ExecResult, Report, ReportItem } from './types.ts';

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'error', code = 1): ExecResult => ({ code, stdout: '', stderr });
const decode = (args: string[]) => Buffer.from(args.at(-1) as string, 'base64').toString('utf16le');

const START = JSON.stringify([
  { Name: 'Autodesk Fusion', AppID: '{6D809377}\\Autodesk\\webdeploy\\production\\Fusion360.exe' },
  { Name: 'Uninstall Autodesk Fusion', AppID: 'uninstall' },
  { Name: 'Google Chrome', AppID: 'Chrome' },
]);

const report = (items: ReportItem[]): Report => ({ startedAt: 'a', finishedAt: 'b', mode: 'apply', status: 'error', items, notes: [] });
const fusion: ReportItem = { source: 'winget', name: 'Autodesk Fusion', id: 'Autodesk.Fusion', from: '2.0.1', to: '2.0.2', outcome: 'failed', reason: 'installer stopped with an error (0x1)' };

// A fake Windows: `handle` answers each call by a short name.
function windows(handle: (call: string) => ExecResult, attended = true) {
  const calls: string[] = [];
  const notices: string[] = [];
  const deps: RescueDeps = {
    platform: 'win32', attended, sleep: async () => {}, log: () => {},
    notifyClosing: (name) => notices.push(name),
    exec: async (command, args) => {
      let call = [command, ...args].join(' ');
      if (command === 'powershell') {
        const script = decode(args);
        call = script.includes('Get-StartApps') ? 'start-apps' : script.includes('CloseMainWindow') ? 'close' : script.includes('Start-Process') ? 'reopen' : 'running';
      }
      calls.push(call);
      if (call === 'start-apps') return ok(START);
      return handle(call);
    },
  };
  return { deps, calls, notices };
}

test('finds the program behind a package', () => {
  const apps = JSON.parse(START);
  assert.equal(matchStartApp(apps, 'Autodesk Fusion')?.AppID, apps[0].AppID);
  assert.equal(matchStartApp(apps, 'Fusion 360', 'Autodesk.Fusion')?.Name, 'Autodesk Fusion');
  assert.equal(matchStartApp(apps, 'Google Chrome (x64)')?.Name, 'Google Chrome');
  assert.equal(matchStartApp(apps, 'Visual Studio Code', 'Microsoft.VisualStudioCode'), undefined);
  assert.deepEqual(parseCaskApps(JSON.stringify({ casks: [{ artifacts: [{ uninstall: [] }, { app: ['Dropbox.app'] }] }] })), ['Dropbox.app']);
  assert.deepEqual(parseCaskApps(JSON.stringify({ casks: [{ artifacts: [{ app: ['Stats.app', { target: 'Stats Pro.app' }] }] }] })), ['Stats Pro.app']);
  assert.deepEqual(parseCaskApps('not json'), []);
  // .pkg casks: the app their uninstall deletes, else the bundle id it quits; helpers never.
  const pkg = { casks: [{ artifacts: [{ uninstall: [{ quit: ['com.microsoft.autoupdate2', 'io.tailscale.ipn.macsys'], delete: ['/Applications/Microsoft Defender Shim.app', '/Applications/Microsoft Teams.app', '/Library/Logs/x'] }] }, { pkg: ['Teams.pkg'] }] }] };
  assert.deepEqual(parseCaskApps(JSON.stringify(pkg)), ['Microsoft Teams.app', 'bundle:io.tailscale.ipn.macsys']);
  assert.deepEqual(parsePaths('["C:\\\\Apps\\\\Fusion360.exe","evil; rm"]'), ['C:\\Apps\\Fusion360.exe']);
});

test('a running app is closed after a notice, updated and started again', async () => {
  let closed = false;
  const { deps, calls, notices } = windows((call) => {
    if (call === 'running') return ok(closed ? '' : '["C:\\\\Apps\\\\Fusion360.exe"]');
    if (call === 'close') { closed = true; return ok('0'); }
    if (call.startsWith('winget upgrade --id')) return closed ? ok() : fail();
    if (call.startsWith('winget upgrade --accept')) return ok('');
    return ok();
  });
  const result = await rescue(deps, report([fusion]));
  assert.equal(result.items[0].outcome, 'applied');
  assert.equal(result.items[0].reason, CLOSED_AND_UPDATED);
  assert.deepEqual(notices, ['Autodesk Fusion']);
  assert.ok(calls.indexOf('close') < calls.findIndex((call) => call.startsWith('winget upgrade --id')));
  assert.ok(calls.includes('reopen'), 'the closed app starts again');
  assert.equal(result.status, 'ok');
});

test('an app that will not close is left alone', async () => {
  const { deps, calls } = windows((call) => (call === 'running' ? ok('["C:\\\\Apps\\\\Fusion360.exe"]') : call === 'close' ? ok('1') : ok()));
  const result = await rescue(deps, report([fusion]));
  assert.equal(result.items[0].reason, DID_NOT_CLOSE);
  assert.ok(!calls.some((call) => call.startsWith('winget upgrade --id')), 'nothing installs over an open app');
});

test('then the installer with its window, then the app updates itself', async () => {
  const installer = windows((call) => (call.includes('--interactive') ? ok() : call.startsWith('winget upgrade --id') ? fail() : call === 'running' ? ok('') : ok('')));
  const shown = await rescue(installer.deps, report([fusion]));
  assert.equal(shown.items[0].reason, UPDATED_WITH_INSTALLER);

  // Nobody there at night: no installer window; the app starts and has updated after the wait.
  let started = false;
  const night = windows((call) => {
    if (call.startsWith('explorer.exe')) { started = true; return fail('', 1); }
    if (call.startsWith('winget upgrade --id')) return fail();
    if (call.startsWith('winget upgrade --accept')) return ok(started ? '' : 'Name Id Version Available\n-----\nAutodesk Fusion Autodesk.Fusion 2.0.1 2.0.2\n');
    return ok('');
  }, false);
  const self = await rescue(night.deps, report([fusion]));
  assert.ok(!night.calls.some((call) => call.includes('--interactive')));
  assert.ok(night.calls.includes('explorer.exe shell:AppsFolder\\{6D809377}\\Autodesk\\webdeploy\\production\\Fusion360.exe'));
  assert.equal(self.items[0].outcome, 'applied');
  assert.equal(self.items[0].reason, UPDATED_BY_ITSELF);
});

test('an app that did not update itself stays a problem with the next step in words', async () => {
  const listed = 'Name                Id               Version Available Source\n------------------------------------------------------------\nAutodesk Fusion     Autodesk.Fusion  2.0.1   2.0.2     winget\n';
  const { deps } = windows((call) => (call.startsWith('winget upgrade --id') ? fail() : call.startsWith('winget upgrade --accept') ? ok(listed) : ok('')), false);
  const result = await rescue(deps, report([fusion]));
  assert.equal(result.items[0].outcome, 'failed');
  assert.equal(result.items[0].reason, OPENED_NO_UPDATE);
});

test('policy, space and pinned failures are not touched', async () => {
  const { deps, calls } = windows(() => ok());
  const pinned = { ...fusion, reason: 'pinned in winget' };
  const result = await rescue(deps, report([pinned, { ...fusion, outcome: 'applied', reason: '' }]));
  assert.deepEqual(calls, []);
  assert.equal(result.items[0], pinned);
});
