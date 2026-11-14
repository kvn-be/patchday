import type { HistoryEntry } from './history.ts';

// Only the fields the export needs, so this file stays free of engine types.
interface LogItem { source: string; name: string; from: string; to: string; outcome: string; reason: string; detail?: string }
interface LogReport { startedAt: string; finishedAt: string; mode: string; items: LogItem[]; notes: string[] }

export interface LogInput {
  version: string;
  system: string;
  exportedAt: Date;
  reports: LogReport[];
  history: HistoryEntry[];
  log: string;
}

const SOURCE: Record<string, string> = { docker: 'Container', brew: 'Homebrew', winget: 'winget', choco: 'Chocolatey', scoop: 'Scoop' };
const OUTCOME: Record<string, string> = { applied: 'applied', planned: 'planned', waiting: 'waiting for you', 'rolled-back': 'ROLLED BACK', failed: 'FAILED' };
const PROBLEM = new Set(['failed', 'rolled-back']);
export const LOG_ROTATE_BYTES = 1024 * 1024;

const stamp = (iso: string) => iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
const indent = (text: string, by = '      ') => text.split('\n').map((line) => by + line).join('\n');

// A plain text file that answers one question per update: what happened, and why.
// Problems come first in every run and carry the tool's own last lines.
export function formatLogs(input: LogInput): string {
  const out: string[] = [];
  out.push('Patchday logs');
  out.push(`Version ${input.version} · ${input.system} · exported ${stamp(input.exportedAt.toISOString())}`);
  const problems = input.reports.reduce((sum, report) => sum + report.items.filter((item) => PROBLEM.has(item.outcome)).length, 0);
  out.push(`${input.reports.length} runs, ${problems} failed updates.`);
  out.push('');
  out.push('== Runs, newest first ==');
  for (const report of [...input.reports].sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
    const count = (outcome: string) => report.items.filter((item) => item.outcome === outcome).length;
    const kind = report.mode === 'apply' ? 'Update run' : 'Check';
    out.push('');
    out.push(`${stamp(report.startedAt)} · ${kind} · ${count('applied')} applied, ${count('failed') + count('rolled-back')} failed, ${count('waiting')} waiting, ${count('planned')} planned`);
    const sorted = [...report.items].sort((a, b) => Number(PROBLEM.has(b.outcome)) - Number(PROBLEM.has(a.outcome)));
    for (const item of sorted) {
      out.push(`  ${OUTCOME[item.outcome] ?? item.outcome}: ${item.name} (${SOURCE[item.source] ?? item.source}) ${item.from} → ${item.to}${item.reason ? ` · ${item.reason}` : ''}`);
      if (item.detail) out.push('    Tool output:', indent(item.detail));
    }
    for (const note of report.notes) out.push(`  Note: ${note}`);
    if (report.items.length === 0 && report.notes.length === 0) out.push('  Nothing to update.');
  }
  out.push('');
  out.push('== History, newest first ==');
  for (const entry of input.history) {
    out.push(`${stamp(entry.at)} · ${entry.action} · ${entry.name}${entry.manager ? ` (${SOURCE[entry.manager] ?? entry.manager})` : ''} · ${entry.ok ? 'done' : 'FAILED'}`);
    if (entry.detail) out.push(indent(entry.detail, '    '));
  }
  out.push('');
  out.push('== Log ==');
  out.push(input.log.trim() || '(empty)');
  return `${out.join('\n')}\n`;
}
