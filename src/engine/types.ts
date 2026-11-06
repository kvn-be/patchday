export type Outcome = 'planned' | 'applied' | 'waiting' | 'rolled-back' | 'failed';
export type ItemSource = 'docker' | 'brew' | 'winget';

export interface ReportItem {
  source: ItemSource;
  name: string;
  from: string;
  to: string;
  outcome: Outcome;
  reason: string;
}

export interface Report {
  startedAt: string;
  finishedAt: string;
  mode: 'preview' | 'apply';
  status: 'ok' | 'warning' | 'error';
  items: ReportItem[];
  notes: string[];
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
};

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (command: string, args: string[], options?: { timeoutMs?: number; env?: Record<string, string> }) => Promise<ExecResult>;
