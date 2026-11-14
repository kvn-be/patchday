import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// macOS and Linux: Homebrew calls `sudo -A` when SUDO_ASKPASS is set. That helper starts Patchday
// with ASKPASS_FLAG, which prints the saved admin password, but only while an update run holds
// a session: the run passes a random token, and only its hash is kept on disk until the run ends.
export const ASKPASS_FLAG = '--askpass';
export const ASKPASS_TOKEN_ENV = 'PATCHDAY_ASKPASS_TOKEN';
export const SESSION_HOURS = 6;

export interface Session {
  hash: string;
  expires: string;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export function newSession(now: Date): { token: string; session: Session } {
  const token = randomBytes(32).toString('hex');
  return { token, session: { hash: sha256(token), expires: new Date(now.getTime() + SESSION_HOURS * 3_600_000).toISOString() } };
}

export function sessionAllows(session: Session | null, token: string | undefined, now: Date): boolean {
  if (!session || !token || !/^[0-9a-f]{64}$/.test(token)) return false;
  if (!(new Date(session.expires).getTime() > now.getTime())) return false;
  const given = Buffer.from(sha256(token), 'hex');
  const kept = Buffer.from(session.hash, 'hex');
  return kept.length === given.length && timingSafeEqual(kept, given);
}

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

// The helper only says how to start Patchday and carries the run's token; it never holds the password.
// The token sits in the script, not in the environment: Homebrew restarts itself with `env -i` and keeps
// only HOMEBREW_* and a few other variables, so anything else never reaches sudo. The script is written
// for each run and removed when the run ends.
export function askpassScript(program: string[], token: string, env: Record<string, string> = {}): string {
  const vars = Object.entries({ ...env, [ASKPASS_TOKEN_ENV]: token }).map(([name, value]) => `${name}=${quote(value)}`).join(' ');
  return `#!/bin/sh\n${vars} exec ${program.map(quote).join(' ')} ${ASKPASS_FLAG}\n`;
}

// Asks sudo itself whether the password is right, then forgets the login again.
export function checkPassword(password: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/sudo', ['-k', '-S', '-p', '', '-v'], { stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => {
      clearTimeout(timer);
      spawn('/usr/bin/sudo', ['-k'], { stdio: 'ignore' }).on('error', () => {});
      resolve(code === 0);
    });
    child.stdin.end(`${password}\n`);
  });
}
