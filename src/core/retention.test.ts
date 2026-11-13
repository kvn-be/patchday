import assert from 'node:assert/strict';
import test from 'node:test';
import { backupsToRemove, stampDate } from './retention.ts';

const stamp = (date: Date) => date.toISOString().replace(/[:.]/g, '-');
const now = new Date('2026-11-13T03:00:00.000Z');
const daysAgo = (days: number) => stamp(new Date(now.getTime() - days * 86_400_000));

test('stampDate reads the folder names that runs create', () => {
  assert.equal(stampDate('2026-11-08T03-00-12-345Z')?.toISOString(), '2026-11-08T03:00:12.345Z');
  assert.equal(stampDate('notes'), null);
  assert.equal(stampDate('2026-11-08T03-00-12Z'), null);
  assert.equal(stampDate('2026-13-40T03-00-12-345Z'), null);
});

test('old backups beyond the newest ten are removed', () => {
  const names = Array.from({ length: 15 }, (_, i) => daysAgo(40 + i));
  const removed = backupsToRemove(names, now);
  assert.equal(removed.length, 5);
  assert.deepEqual(removed, names.slice(10));
});

test('the newest ten stay even when they are old', () => {
  const names = Array.from({ length: 10 }, (_, i) => daysAgo(100 + i));
  assert.deepEqual(backupsToRemove(names, now), []);
});

test('recent backups stay even when there are many', () => {
  const names = Array.from({ length: 25 }, (_, i) => daysAgo(i));
  assert.deepEqual(backupsToRemove(names, now), []);
});

test('folders without a time stamp name are never removed', () => {
  const names = [...Array.from({ length: 12 }, (_, i) => daysAgo(i)), 'manual-copy', daysAgo(60)];
  assert.deepEqual(backupsToRemove(names, now), [daysAgo(60)]);
});
