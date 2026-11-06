import { execFile } from 'node:child_process';
import type { Exec } from './types.ts';

// Scheduled jobs and packaged apps start with a minimal PATH.
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin'];

export const exec: Exec = (command, args, options = {}) =>
  new Promise((resolve) => {
    const path = process.platform === 'win32' ? process.env.PATH : [...EXTRA_PATH, process.env.PATH].join(':');
    const child = execFile(
      command,
      args,
      { timeout: options.timeoutMs ?? 120_000, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, PATH: path, ...options.env } },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) || (error?.message ?? '') });
      },
    );
    // Nothing may wait for a prompt in an unattended run.
    child.stdin?.end();
  });
