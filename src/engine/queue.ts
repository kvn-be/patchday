// The operations queue: installs, updates and removals wait their turn here. Operations of the same
// manager never run side by side (installers lock each other out); different managers may, up to
// the number set in Settings.
import { packageKey, type Package, type PackageAction } from '../core/packages.ts';
import type { ActionResult } from './packages.ts';

export type OperationState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Operation {
  id: number;
  action: PackageAction;
  package: Package;
  state: OperationState;
  phase: string;
  reason: string;
  detail?: string;
  log: string[];
  queuedAt: string;
  finishedAt?: string;
}

export interface QueueRunner {
  run(operation: Operation, signal: AbortSignal, log: (line: string) => void, phase: (name: string) => void): Promise<ActionResult>;
  // Called once per finished operation, for history and logs.
  finished(operation: Operation): void;
  // Extra condition, e.g. no scheduled run in progress.
  canStart?(): boolean;
}

const LOG_LIMIT = 400;
const KEEP_FINISHED = 100;

export class OperationQueue {
  private operations: Operation[] = [];
  private controllers = new Map<number, AbortController>();
  private nextId = 1;
  private listeners = new Set<(operations: Operation[]) => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  private runner: QueueRunner;
  private parallel: () => number;

  constructor(runner: QueueRunner, parallel: () => number) {
    this.runner = runner;
    this.parallel = parallel;
  }

  onChange(listener: (operations: Operation[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): Operation[] {
    return this.operations.map((operation) => ({ ...operation, log: operation.log.slice(-60) }));
  }

  get(id: number): Operation | undefined {
    return this.operations.find((operation) => operation.id === id);
  }

  get active(): boolean {
    return this.operations.some((operation) => operation.state === 'queued' || operation.state === 'running');
  }

  // The same package with the same action is not queued twice.
  add(action: PackageAction, packages: Package[]): number[] {
    const ids: number[] = [];
    for (const entry of packages) {
      const waiting = this.operations.find((operation) => (operation.state === 'queued' || operation.state === 'running') && operation.action === action && packageKey(operation.package) === packageKey(entry));
      if (waiting) {
        ids.push(waiting.id);
        continue;
      }
      const operation: Operation = { id: this.nextId++, action, package: entry, state: 'queued', phase: '', reason: '', log: [], queuedAt: new Date().toISOString() };
      this.operations.push(operation);
      ids.push(operation.id);
    }
    this.trim();
    this.changed(true);
    this.pump();
    return ids;
  }

  cancel(id: number): void {
    const operation = this.get(id);
    if (!operation) return;
    if (operation.state === 'queued') {
      operation.state = 'cancelled';
      operation.reason = 'cancelled';
      operation.finishedAt = new Date().toISOString();
      this.changed(true);
      this.pump();
    } else if (operation.state === 'running') {
      this.controllers.get(id)?.abort();
    }
  }

  retry(id: number): number[] {
    const operation = this.get(id);
    if (!operation || (operation.state !== 'failed' && operation.state !== 'cancelled')) return [];
    return this.add(operation.action, [operation.package]);
  }

  clearFinished(): void {
    this.operations = this.operations.filter((operation) => operation.state === 'queued' || operation.state === 'running');
    this.changed(true);
  }

  // Starts what may start now; called after every change.
  pump(): void {
    if (this.runner.canStart && !this.runner.canStart()) return;
    const running = this.operations.filter((operation) => operation.state === 'running');
    const busyManagers = new Set(running.map((operation) => operation.package.manager));
    let room = Math.max(1, Math.min(4, this.parallel())) - running.length;
    for (const operation of this.operations) {
      if (room <= 0) break;
      if (operation.state !== 'queued' || busyManagers.has(operation.package.manager)) continue;
      busyManagers.add(operation.package.manager);
      room--;
      void this.start(operation);
    }
  }

  private async start(operation: Operation): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(operation.id, controller);
    operation.state = 'running';
    this.changed(true);
    const log = (line: string) => {
      operation.log.push(line.slice(0, 500));
      if (operation.log.length > LOG_LIMIT) operation.log.splice(0, operation.log.length - LOG_LIMIT);
      this.changed(false);
    };
    const phase = (name: string) => {
      operation.phase = name;
      this.changed(false);
    };
    let result: ActionResult;
    try {
      result = await this.runner.run(operation, controller.signal, log, phase);
    } catch (error) {
      result = { key: packageKey(operation.package), ok: false, reason: (error as Error).message };
    }
    this.controllers.delete(operation.id);
    operation.state = controller.signal.aborted ? 'cancelled' : result.ok ? 'done' : 'failed';
    operation.reason = controller.signal.aborted ? 'cancelled' : result.reason;
    if (result.detail) operation.detail = result.detail;
    operation.phase = '';
    operation.finishedAt = new Date().toISOString();
    try {
      this.runner.finished(operation);
    } finally {
      this.changed(true);
      this.pump();
    }
  }

  private trim(): void {
    const finished = this.operations.filter((operation) => operation.finishedAt);
    if (finished.length <= KEEP_FINISHED) return;
    const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED).map((operation) => operation.id));
    this.operations = this.operations.filter((operation) => !drop.has(operation.id));
  }

  // State changes go out at once; log lines at most a few times a second.
  private changed(now: boolean): void {
    if (now) {
      if (this.notifyTimer) clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
      const snapshot = this.snapshot();
      for (const listener of this.listeners) listener(snapshot);
      return;
    }
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => this.changed(true), 250);
  }
}
