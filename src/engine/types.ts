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
  // The package manager's id, when it differs from the name (winget).
  id?: string;
  // Set on optional updates (minor, no security fix): the "repository:tag" to approve them with.
  optional?: string;
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
export type Phase = 'backup' | 'update' | 'test' | 'rollback' | 'retry' | 'reinstall';

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
  // Minor container updates without a security fix install by themselves only while this is on.
  autoMinor: boolean;
  // Optional updates the user chose to install, as "repository:tag".
  approved: string[];
  // 2: minor updates became optional; older settings files are moved over once.
  policyVersion?: number;
  holds: string[];
  language: 'en' | 'de';
  // Kept for old settings files; the app reads appearance.
  theme: 'dark' | 'light';
  appearance: 'system' | 'light' | 'dark';
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
  autoMinor: false,
  approved: [],
  policyVersion: 2,
  holds: [],
  language: 'en',
  theme: 'dark',
  appearance: 'system',
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

// Settings files from before policy version 2 saved "autoMinor: true" as the default.
// Minor updates are optional now; security fixes still install by themselves.
export function migrateSettings(settings: Settings): Settings {
  if ((settings.policyVersion ?? 1) >= 2) return settings;
  return { ...settings, autoMinor: false, approved: settings.approved ?? [], policyVersion: 2 };
}
