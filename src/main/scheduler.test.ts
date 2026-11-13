import assert from 'node:assert/strict';
import test from 'node:test';
import { launchdPlist, schtasksArgs } from '../core/schedule.ts';
import { toSchedule } from './scheduler.ts';

// The dial counts hours from Monday 00:00. launchd and schtasks count days from Sunday = 0.
test('toSchedule maps every dial day from Monday to Sunday', () => {
  const expected = [1, 2, 3, 4, 5, 6, 0];
  for (let day = 0; day < 7; day++) {
    assert.deepEqual(toSchedule(day * 24 + 3), { enabled: true, days: [expected[day]], hour: 3, minute: 0 }, `dial day ${day}`);
  }
});

test('toSchedule keeps the hour at the edges of the week', () => {
  assert.deepEqual(toSchedule(0), { enabled: true, days: [1], hour: 0, minute: 0 });
  assert.deepEqual(toSchedule(23), { enabled: true, days: [1], hour: 23, minute: 0 });
  assert.deepEqual(toSchedule(24), { enabled: true, days: [2], hour: 0, minute: 0 });
  assert.deepEqual(toSchedule(167), { enabled: true, days: [0], hour: 23, minute: 0 });
});

test('the default dial position, Sunday 03:00, reaches both schedulers as Sunday', () => {
  const schedule = toSchedule(147);
  assert.match(launchdPlist(schedule, 'io.github.kvn-be.patchday', ['/Applications/Patchday.app/Contents/MacOS/Patchday']), /<key>Weekday<\/key><integer>0<\/integer>/);
  assert.deepEqual(schtasksArgs(schedule, 'Patchday', 'patchday.exe').slice(-4), ['/D', 'SUN', '/ST', '03:00']);
});

test('Saturday night stays on Saturday', () => {
  assert.deepEqual(schtasksArgs(toSchedule(5 * 24 + 22), 'Patchday', 'patchday.exe').slice(-4), ['/D', 'SAT', '/ST', '22:00']);
});
