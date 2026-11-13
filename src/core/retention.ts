// Backups live in one folder per stack update, named after the time it started, for example
// 2026-11-08T03-00-12-345Z. Only folders with exactly that name are ever removed.
const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

export const BACKUP_KEEP_NEWEST = 10;
export const BACKUP_MAX_AGE_DAYS = 30;

export function stampDate(name: string): Date | null {
  const match = STAMP.exec(name);
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Returns the backup folders to delete: older than the age limit and not among the newest ones.
export function backupsToRemove(
  names: string[],
  now: Date,
  keepNewest = BACKUP_KEEP_NEWEST,
  maxAgeDays = BACKUP_MAX_AGE_DAYS,
): string[] {
  const limit = now.getTime() - maxAgeDays * 86_400_000;
  return names
    .map((name) => ({ name, date: stampDate(name) }))
    .filter((entry): entry is { name: string; date: Date } => entry.date !== null)
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(keepNewest)
    .filter((entry) => entry.date.getTime() < limit)
    .map((entry) => entry.name);
}
