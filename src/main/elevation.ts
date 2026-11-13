import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { WORKER_TASK, workerTaskXml } from '../core/elevation.ts';
import type { Exec, ProgressItem, Report } from '../engine/types.ts';

export interface WorkerStatus {
  state: 'running' | 'done';
  items: ProgressItem[];
  report?: Report;
  // Set while the worker updates Patchday itself.
  selfUpdate?: { percent: number; error?: string };
}

const START_LIMIT_MS = 60_000;
const POLL_MS = 500;

export async function workerReady(exec: Exec): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  return (await exec('schtasks', ['/Query', '/TN', WORKER_TASK])).code === 0;
}

// The only moment Windows asks for admin rights. Later runs start this task without a prompt.
export async function setupWorker(exec: Exec, xmlPath: string, program: string): Promise<boolean> {
  const user = (await exec('whoami', [])).stdout.trim();
  await writeFile(xmlPath, Buffer.from(`﻿${workerTaskXml(user, program)}`, 'utf16le'));
  const path = xmlPath.replace(/'/g, "''");
  const script = `Start-Process -FilePath schtasks.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '/Create /F /TN "${WORKER_TASK}" /XML "${path}"'`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  await exec('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeoutMs: 5 * 60_000 });
  await rm(xmlPath, { force: true });
  return workerReady(exec);
}

export async function writeStatus(path: string, status: WorkerStatus): Promise<void> {
  // Renamed into place, so a reader never sees half a file.
  await writeFile(`${path}.tmp`, JSON.stringify(status));
  await rename(`${path}.tmp`, path);
}

async function startAndWatch(exec: Exec, statusPath: string, onStatus: (status: WorkerStatus) => boolean): Promise<void> {
  await rm(statusPath, { force: true });
  const started = await exec('schtasks', ['/Run', '/TN', WORKER_TASK]);
  if (started.code !== 0) throw new Error('the update task did not start');

  const begun = Date.now();
  let seen = false;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const text = await readFile(statusPath, 'utf8').catch(() => null);
    if (text === null) {
      if (!seen && Date.now() - begun > START_LIMIT_MS) throw new Error('the update task did not start');
      continue;
    }
    seen = true;
    if (onStatus(JSON.parse(text) as WorkerStatus)) return;
  }
}

export async function runWorker(exec: Exec, statusPath: string, onItems: (items: ProgressItem[]) => void): Promise<Report> {
  let report: Report | undefined;
  await startAndWatch(exec, statusPath, (status) => {
    onItems(status.items);
    report = status.report;
    return status.state === 'done' && Boolean(report);
  });
  return report as Report;
}

// The job file only selects the action. What gets installed is decided inside the worker,
// so a process without admin rights cannot make the worker run anything of its own.
export async function runWorkerSelfUpdate(exec: Exec, jobPath: string, statusPath: string, onPercent: (percent: number) => void): Promise<void> {
  await writeFile(jobPath, JSON.stringify({ action: 'self-update' }));
  await startAndWatch(exec, statusPath, (status) => {
    if (status.selfUpdate?.error) throw new Error(status.selfUpdate.error);
    if (status.selfUpdate) onPercent(status.selfUpdate.percent);
    return status.state === 'done';
  });
}

// Used when Patchday closes: the task installs the update in the background and nothing waits for it.
export async function startWorkerSelfUpdate(exec: Exec, jobPath: string): Promise<boolean> {
  await writeFile(jobPath, JSON.stringify({ action: 'self-update', reopen: false }));
  return (await exec('schtasks', ['/Run', '/TN', WORKER_TASK])).code === 0;
}
