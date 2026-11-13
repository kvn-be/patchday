// winget and Scoop print tables with a header, a rule of dashes and fixed columns.
// The columns are cut at the offsets of the header labels.

export interface Column {
  key: string;
  label: RegExp;
  required?: boolean;
}

// In a pipe, winget still draws its progress spinner with carriage returns in front of the header.
// Like a terminal, only the text after the last carriage return of a line counts.
export function terminalLines(output: string): string[] {
  return output.split('\n').map((line) => {
    const text = line.replace(/\r$/, '');
    return text.slice(text.lastIndexOf('\r') + 1);
  });
}

const RULE = /^-{3,}[-\s]*$/;

// Returns one record per row, from the first table in the output. The first column starts at 0.
export function parseColumns(output: string, columns: Column[]): Record<string, string>[] {
  const lines = terminalLines(output);
  const rule = lines.findIndex((line) => RULE.test(line.trim()));
  if (rule < 1) return [];
  const header = lines[rule - 1];
  const found = columns
    .map((column, index) => ({ ...column, start: index === 0 ? 0 : header.search(column.label) }))
    .filter((column) => column.start >= 0);
  if (columns.some((column) => column.required && !found.some((entry) => entry.key === column.key))) return [];
  found.sort((a, b) => a.start - b.start);

  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(rule + 1)) {
    if (!line.trim() || RULE.test(line.trim())) break;
    const row: Record<string, string> = {};
    found.forEach((column, index) => {
      row[column.key] = line.slice(column.start, found[index + 1]?.start).trim();
    });
    rows.push(row);
  }
  return rows;
}
