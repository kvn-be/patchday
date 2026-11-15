// Package icons come from UniGetUI's public icon list (MIT), keyed the way UniGetUI keys them, so
// both apps show the same icon for the same package.
import type { Package } from './packages.ts';

export const ICON_DATABASE_URL = 'https://github.com/Devolutions/UniGetUI/raw/refs/heads/main/WebBasedData/screenshot-database-v2.json';

export function iconId(entry: Pick<Package, 'manager' | 'id'>): string {
  let id = entry.id;
  if (entry.manager === 'winget') id = id.includes('.') ? id.split('.').slice(1).join('.') : id;
  else if (entry.manager === 'scoop') id = id.split('/').pop()!.replace('.app', '');
  else if (entry.manager === 'choco') id = id.replace('.install', '').replace('.portable', '');
  else if (entry.manager === 'vcpkg') id = id.split(':')[0].split('[')[0];
  return id.toLowerCase().replace(/[_. /,]/g, '-');
}

export interface IconDatabase {
  icons: Record<string, { icon?: string; images?: string[] }>;
}

export function parseIconDatabase(json: string): IconDatabase {
  const data = JSON.parse(json) as { icons_and_screenshots?: Record<string, { icon?: string; images?: string[] }> };
  return { icons: data.icons_and_screenshots ?? {} };
}

// Only plain https images are fetched.
export function iconUrl(database: IconDatabase, entry: Pick<Package, 'manager' | 'id'>): string | null {
  const url = database.icons[iconId(entry)]?.icon ?? '';
  return /^https:\/\/[^\s"'<>]+$/i.test(url) ? url : null;
}

export function screenshots(database: IconDatabase, entry: Pick<Package, 'manager' | 'id'>): string[] {
  return (database.icons[iconId(entry)]?.images ?? []).filter((url) => /^https:\/\/[^\s"'<>]+$/i.test(url)).slice(0, 6);
}
