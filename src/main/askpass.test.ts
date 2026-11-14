import assert from 'node:assert/strict';
import test from 'node:test';
import { askpassScript, newSession, sessionAllows, SESSION_HOURS } from './askpass.ts';

const now = new Date('2026-11-15T03:00:00Z');

test('only the token of the open run unlocks the password', () => {
  const { token, session } = newSession(now);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.notEqual(session.hash, token);
  assert.equal(sessionAllows(session, token, now), true);
  assert.equal(sessionAllows(session, newSession(now).token, now), false);
  assert.equal(sessionAllows(session, undefined, now), false);
  assert.equal(sessionAllows(session, 'x'.repeat(64), now), false);
  assert.equal(sessionAllows(null, token, now), false);
});

test('a session left behind by a crash expires', () => {
  const { token, session } = newSession(now);
  const later = new Date(now.getTime() + SESSION_HOURS * 3_600_000 + 1);
  assert.equal(sessionAllows(session, token, later), false);
  assert.equal(sessionAllows({ ...session, expires: 'garbage' }, token, now), false);
});

test('the helper script starts Patchday and holds no secret', () => {
  const script = askpassScript(['/Applications/Patchday.app/Contents/MacOS/Patchday']);
  assert.equal(script, "#!/bin/sh\nexec '/Applications/Patchday.app/Contents/MacOS/Patchday' --askpass\n");
  assert.match(askpassScript(["/tmp/it's here/electron", '/app']), /'\/tmp\/it'\\''s here\/electron' '\/app' --askpass/);
});
