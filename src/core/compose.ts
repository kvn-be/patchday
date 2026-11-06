// Changes only the exact image line, so comments and layout of the file survive.
export function bumpImage(file: string, repository: string, fromTag: string, toTag: string): string | null {
  const escaped = `${repository}:${fromTag}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = new RegExp(`^(\\s*image:\\s*["']?)${escaped}(["']?\\s*(?:#.*)?)$`, 'gm');
  if (!line.test(file)) return null;
  line.lastIndex = 0;
  return file.replace(line, `$1${repository}:${toTag}$2`);
}
