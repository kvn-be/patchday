export interface ChocoPackage {
  name: string;
  installed: string;
  available: string;
  pinned: boolean;
}

// `choco outdated --limit-output` prints name|current|available|pinned, among other notices.
export function parseChocoOutdated(output: string): ChocoPackage[] {
  const packages: ChocoPackage[] = [];
  for (const line of output.replace(/\r/g, '').split('\n')) {
    const fields = line.trim().split('|');
    if (fields.length !== 4 || !fields[0]) continue;
    packages.push({ name: fields[0], installed: fields[1], available: fields[2], pinned: fields[3].toLowerCase() === 'true' });
  }
  return packages;
}
