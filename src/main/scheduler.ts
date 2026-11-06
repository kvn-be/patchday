import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { launchdPlist, schtasksArgs, type Schedule } from '../core/schedule.ts';
import type { Exec } from '../engine/types.ts';

const LABEL = 'io.github.kvn-be.patchday';
const TASK = 'Patchday';

export function toSchedule(hourOfWeek: number): Schedule {
  // The dial starts on Monday, launchd and schtasks on Sunday.
  const day = (Math.floor(hourOfWeek / 24) + 1) % 7;
  return { enabled: true, days: [day], hour: hourOfWeek % 24, minute: 0 };
}

export async function syncSchedule(exec: Exec, hourOfWeek: number, enabled: boolean, program: string[]): Promise<void> {
  if (process.platform === 'darwin') {
    const path = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const domain = `gui/${process.getuid?.()}`;
    await exec('launchctl', ['bootout', `${domain}/${LABEL}`]);
    if (!enabled) {
      await rm(path, { force: true });
      return;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, launchdPlist(toSchedule(hourOfWeek), LABEL, program));
    const result = await exec('launchctl', ['bootstrap', domain, path]);
    if (result.code !== 0) throw new Error('macOS did not accept the schedule');
    return;
  }
  if (process.platform === 'win32') {
    if (!enabled) {
      await exec('schtasks', ['/Delete', '/F', '/TN', TASK]);
      return;
    }
    const command = program.map((part) => `"${part}"`).join(' ');
    const result = await exec('schtasks', schtasksArgs(toSchedule(hourOfWeek), TASK, command));
    if (result.code !== 0) throw new Error('Windows did not accept the schedule');
  }
}
