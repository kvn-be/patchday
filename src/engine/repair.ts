import type { Diagnosis } from '../core/failures.ts';
import type { Command } from '../core/packages.ts';
import type { Exec, ExecResult } from './types.ts';

export interface RepairResult {
  ok: boolean;
  reason: string;
  detail?: string;
}

export type RepairPhase = 'update' | 'retry' | 'reinstall';

export interface RepairSteps {
  install(force: boolean): Promise<ExecResult>;
  diagnose(result: ExecResult): Diagnosis;
  refresh(): Promise<unknown>;
  // The last step: clean caches, then remove and install fresh.
  reinstall?(): Promise<ExecResult>;
  sleep(ms: number): Promise<void>;
  onPhase(phase: RepairPhase): void;
  log(message: string): void;
  name: string;
}

export const RETRY_WAIT_MS = 60_000;
export const REINSTALLED = 'reinstalled to finish the update';

export function lastLines(result: ExecResult): string {
  const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^[-\\|/ ]+$/.test(line));
  return lines.slice(-12).join('\n').slice(0, 1500);
}

// Three steps, each only when the one before failed: install, a targeted repair, a fresh install.
// It stops early where a fresh install cannot help, for example missing rights or a running app.
export async function installWithRepair(steps: RepairSteps): Promise<RepairResult> {
  steps.onPhase('update');
  let result = await steps.install(false);
  if (result.code === 0) return { ok: true, reason: '' };
  let diagnosis = steps.diagnose(result);
  if (diagnosis.applied) return { ok: true, reason: diagnosis.reason };
  if (diagnosis.final) return { ok: false, reason: diagnosis.reason, detail: lastLines(result) };

  if (diagnosis.fix) {
    steps.log(`${steps.name}: ${diagnosis.reason}, trying again`);
    steps.onPhase('retry');
    if (diagnosis.fix === 'wait-retry') await steps.sleep(RETRY_WAIT_MS);
    if (diagnosis.fix === 'refresh-retry') await steps.refresh();
    result = await steps.install(diagnosis.fix === 'force-retry');
    if (result.code === 0) return { ok: true, reason: '' };
    diagnosis = steps.diagnose(result);
    if (diagnosis.applied) return { ok: true, reason: diagnosis.reason };
    // A busy or running app is never removed: it would lose open work.
    if (diagnosis.final || diagnosis.fix === 'wait-retry') return { ok: false, reason: diagnosis.reason, detail: lastLines(result) };
  }
  if (!steps.reinstall) return { ok: false, reason: diagnosis.reason, detail: lastLines(result) };

  steps.log(`${steps.name}: ${diagnosis.reason}, installing it fresh`);
  steps.onPhase('reinstall');
  const fresh = await steps.reinstall();
  if (fresh.code === 0) return { ok: true, reason: REINSTALLED };
  const after = steps.diagnose(fresh);
  if (after.applied) return { ok: true, reason: after.reason };
  return { ok: false, reason: after.reason, detail: `${lastLines(result)}\n--- fresh install ---\n${lastLines(fresh)}` };
}

// Runs the commands in order; the result of the last one counts. A step that fails before it
// (for example removing an app that is already gone) does not stop the fresh install.
export async function runSequence(exec: Exec, commands: Command[], timeoutMs: number, env?: Record<string, string>): Promise<ExecResult> {
  let last: ExecResult = { code: 0, stdout: '', stderr: '' };
  for (const command of commands) last = await exec(command.command, command.args, { timeoutMs, ...(env ? { env } : {}) });
  return last;
}
