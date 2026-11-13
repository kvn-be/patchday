export type HistoryAction = 'install' | 'uninstall' | 'update' | 'run' | 'self-update';

export interface HistoryEntry {
  at: string;
  action: HistoryAction;
  manager?: string;
  id?: string;
  name: string;
  ok: boolean;
  // What failed and the tool's last lines, for failures only.
  detail?: string;
}

export const HISTORY_LIMIT = 1000;

// Newest first, at most HISTORY_LIMIT entries. Unreadable entries are dropped.
export function addHistory(existing: unknown, entries: HistoryEntry[]): HistoryEntry[] {
  const valid = Array.isArray(existing)
    ? existing.filter((entry): entry is HistoryEntry => typeof entry?.at === 'string' && typeof entry?.action === 'string' && typeof entry?.name === 'string')
    : [];
  return [...entries, ...valid].sort((a, b) => b.at.localeCompare(a.at)).slice(0, HISTORY_LIMIT);
}
