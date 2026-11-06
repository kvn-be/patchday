export interface WingetPackage {
  name: string;
  id: string;
  installed: string;
  available: string;
}

// winget has no JSON output for upgrades, so columns are cut at the header's offsets.
export function parseWingetUpgrade(output: string): WingetPackage[] {
  const lines = output.replace(/\r/g, '').split('\n');
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
    if (line.length <= available || !line.slice(id, version).trim()) continue;
    packages.push({
      name: line.slice(0, id).trim(),
      id: line.slice(id, version).trim(),
      installed: line.slice(version, available).trim(),
      available: line.slice(available, source < 0 ? undefined : source).trim(),
    });
  }
  return packages;
}
