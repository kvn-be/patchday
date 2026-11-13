import { terminalLines } from './table.ts';

export interface WingetPackage {
  name: string;
  id: string;
  installed: string;
  available: string;
}

// winget has no JSON output for upgrades, so columns are cut at the header's offsets.
export function parseWingetUpgrade(output: string): WingetPackage[] {
  const lines = terminalLines(output);
  const rule = lines.findIndex((line) => /^-{10,}/.test(line.trim()));
  if (rule < 1) return [];
  const header = lines[rule - 1];
  const start = (label: RegExp) => header.search(label);
  const id = start(/\bId\b|\bID\b/);
  const version = start(/\bVersion\b/);
  const available = start(/\bAvailable\b|\bVerfügbar\b/);
  const source = start(/\bSource\b|\bQuelle\b/);
  if ([id, version, available].some((column) => column < 0)) return [];

  const packages: WingetPackage[] = [];
  for (const line of lines.slice(rule + 1)) {
    const row = {
      name: line.slice(0, id).trim(),
      id: line.slice(id, version).trim(),
      installed: line.slice(version, available).trim(),
      available: line.slice(available, source < 0 ? undefined : source).trim(),
    };
    // The table ends at the first line that is no package. Below it winget prints notices such as
    // "2 package(s) have version numbers that cannot be determined".
    if (!row.name || !row.id || /\s/.test(row.id) || !/\d/.test(row.installed + row.available) || !/\d/.test(row.available)) break;
    packages.push(row);
  }
  return packages;
}
