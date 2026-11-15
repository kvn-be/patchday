import assert from 'node:assert/strict';
import test from 'node:test';
import type { Package } from '../core/packages.ts';
import { OperationQueue, type Operation } from './queue.ts';

const pkg = (manager: Package['manager'], id: string): Package => ({ manager, id, name: id, version: '1.0' });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function harness(parallel = 2) {
  const started: string[] = [];
  const release = new Map<string, (ok: boolean) => void>();
  const finished: Operation[] = [];
  const queue = new OperationQueue({
    run: (operation, signal) => new Promise((resolve) => {
      started.push(operation.package.id);
      release.set(operation.package.id, (ok) => resolve({ key: operation.package.id, ok, reason: ok ? '' : 'broke' }));
      signal.addEventListener('abort', () => resolve({ key: operation.package.id, ok: false, reason: 'aborted' }));
    }),
    finished: (operation) => finished.push(operation),
  }, () => parallel);
  return { queue, started, release, finished };
}

test('the same manager runs one at a time, different managers side by side', async () => {
  const { queue, started, release } = harness(2);
  queue.add('install', [pkg('brew', 'a'), pkg('brew', 'b'), pkg('npm', 'c')]);
  await tick();
  assert.deepEqual(started, ['a', 'c']);
  release.get('a')!(true);
  await tick();
  assert.deepEqual(started, ['a', 'c', 'b']);
});

test('queued operations can be cancelled, running ones are aborted, failed ones retried', async () => {
  const { queue, started, release, finished } = harness(1);
  const [first, second] = queue.add('update', [pkg('pip', 'x'), pkg('pip', 'y')]);
  queue.cancel(second);
  await tick();
  queue.cancel(first);
  await tick();
  assert.deepEqual(finished.map((operation) => `${operation.package.id}:${operation.state}`), ['x:cancelled']);
  assert.equal(queue.get(second)?.state, 'cancelled');
  assert.deepEqual(started, ['x']);
  const [again] = queue.retry(first);
  await tick();
  release.get('x')!(false);
  await tick();
  assert.equal(queue.get(again)?.state, 'failed');
  assert.equal(queue.get(again)?.reason, 'broke');
});

test('the same package and action is not queued twice', () => {
  const { queue } = harness(1);
  const [a] = queue.add('install', [pkg('cargo', 'bat')]);
  const [b] = queue.add('install', [pkg('cargo', 'bat')]);
  assert.equal(a, b);
});
