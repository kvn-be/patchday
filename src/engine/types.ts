export type Outcome = 'planned' | 'applied' | 'waiting' | 'rolled-back' | 'failed';
export type ItemSource = 'docker' | 'brew' | 'winget' | 'choco' | 'scoop';

export interface ReportItem {
  source: ItemSource;
  name: string;
  from: string;
  to: string;
  outcome: Outcome;
  reason: string;
  // The tool's own last lines, for failures only.
  detail?: string;
}

export interface Report {
  startedAt: string;
  finishedAt: string;
  mode: 'preview' | 'apply';
  status: 'ok' | 'warning' | 'error';
  items: ReportItem[];
  notes: string[];
}

export type ProgressState = 'queued' | 'running' | 'done' | 'failed';
export type Phase = 'backup' | 'update' | 'test' | 'rollback' | 'retry';

export interface ProgressItem {
  id: string;
  source: ItemSource;
  name: string;
  from: string;
  to: string;
  state: ProgressState;
  phase: Phase | null;
  // null means the tool reports no progress, so the bar only shows activity.
  percent: number | null;
  reason: string;
}

export interface Settings {
  hourOfWeek: number;
  scheduleEnabled: boolean;
  applyUpdates: boolean;
  autoMinor: boolean;
  holds: string[];
  language: 'en' | 'de';
  theme: 'dark' | 'light';
  portainerUrl: string;
  adminAsked: boolean;
  // Versions the user chose to skip, by manager:id.
  skipped: Record<string, string>;
  // Patchday checks for a new version of itself once a day and installs it when it closes.
  autoSelfUpdate: boolean;
  lastSelfCheck?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  hourOfWeek: 147,
  scheduleEnabled: false,
  applyUpdates: false,
  autoMinor: true,
  holds: [],
  language: 'en',
  theme: 'dark',
  portainerUrl: '',
  adminAsked: false,
  skipped: {},
  autoSelfUpdate: true,
};

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (command: string, args: string[], options?: { timeoutMs?: number; env?: Record<string, string> }) => Promise<ExecResult>;
