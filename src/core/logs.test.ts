import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRun, runLogName, runLogsToRemove } from './logs.ts';

const report = {
  startedAt: '2026-11-14T10:39:26.177Z',
  finishedAt: '2026-11-14T10:45:01.002Z',
  mode: 'apply',
  status: 'error',
  items: [
    { source: 'docker', name: 'uptime-kuma', from: '2.5.9', to: '2.5.11', outcome: 'applied', reason: 'patch update' },
    { source: 'docker', name: 'paperless-db', from: '18.6', to: '18.7', outcome: 'waiting', reason: 'protected: database' },
    { source: 'brew', name: 'bartender', from: '7.1.0', to: '7.2.0', outcome: 'failed', reason: 'needs your admin password', detail: 'sudo: a password is required' },
    { source: 'docker', name: 'homepage', from: 'v2.7.0', to: 'v2.8.0', outcome: 'rolled-back', reason: 'not healthy within 5 minutes' },
  ],
  notes: ['Portainer: Portainer answered 401. Portainer stacks stay untouched.'],
};

test('a run log lists every update under its status, failures first', () => {
  const text = formatRun(report, '1.1.2', 'macOS 27.2.0 (arm64)');
  assert.match(text, /^Patchday Update run\n/);
  assert.match(text, /status error/);
  assert.match(text, /Failed: 2 · Applied: 1 · Waiting for you: 1 · Planned: 0/);
  assert.ok(text.indexOf('== Failed ==') < text.indexOf('== Applied =='));
  assert.ok(text.indexOf('== Applied ==') < text.indexOf('== Waiting for you =='));
  assert.match(text, /FAILED: bartender \(Homebrew\) 7\.1\.0 → 7\.2\.0 · needs your admin password\n {4}Tool output:\n {6}sudo: a password is required/);
  assert.match(text, /ROLLED BACK: homepage \(Container\)/);
  assert.match(text, /== Applied ==\n {2}uptime-kuma \(Container\) 2\.5\.9 → 2\.5\.11 · patch update/);
  assert.match(text, /== Waiting for you ==\n {2}paperless-db \(Container\) 18\.6 → 18\.7 · protected: database/);
  assert.match(text, /== Notes ==\n {2}Portainer: Portainer answered 401/);
  assert.doesNotMatch(text, /== Planned ==/);
});

test('an empty check says so', () => {
  const text = formatRun({ ...report, mode: 'preview', items: [], notes: [] }, '1.1.2', 'macOS');
  assert.match(text, /^Patchday Check\n/);
  assert.match(text, /Nothing to update\.\n$/);
});

test('run log names sort by time and say what kind of run it was', () => {
  assert.equal(runLogName(report), '2026-11-14T10-39-26-177Z-update.txt');
  assert.equal(runLogName({ ...report, mode: 'preview' }), '2026-11-14T10-39-26-177Z-check.txt');
});

test('only the oldest run logs beyond the limit are removed, other files never', () => {
  const names = ['2026-11-01T03-00-00-000Z-update.txt', '2026-11-02T03-00-00-000Z-check.txt', '2026-11-03T03-00-00-000Z-update.txt', 'notes.txt', 'patchday.log'];
  assert.deepEqual(runLogsToRemove(names, 2), ['2026-11-01T03-00-00-000Z-update.txt']);
  assert.deepEqual(runLogsToRemove(names, 5), []);
});
