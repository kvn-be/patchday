import { app } from 'electron';
import electronUpdater from 'electron-updater';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, chmod, constants, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MAC_SWAP_SCRIPT, macChecksum, pickRelease, type Release } from '../core/selfupdate.ts';
import { exec } from '../engine/exec.ts';

const RELEASES_URL = 'https://api.github.com/repos/kvn-be/patchday/releases?per_page=20';

export async function findUpdate(): Promise<Release | null> {
  const response = await fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  return pickRelease((await response.json()) as Parameters<typeof pickRelease>[0], app.getVersion());
}

function updater() {
  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // All Patchday releases are marked as previews for now.
  autoUpdater.allowPrerelease = true;
  return autoUpdater;
}

// Windows: electron-updater verifies the download against the checksum in the release.
export async function installWindows(onPercent: (percent: number) => void): Promise<void> {
  const autoUpdater = updater();
  autoUpdater.on('download-progress', (progress) => onPercent(Math.round(progress.percent)));
  const found = await autoUpdater.checkForUpdates();
  if (!found?.isUpdateAvailable) throw new Error('no update found');
  await autoUpdater.downloadUpdate();
  onPercent(100);
  setTimeout(() => autoUpdater.quitAndInstall(true, true), 2000);
}

async function download(url: string, path: string, onPercent: (percent: number) => void): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`download failed with ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  let received = 0;
  const source = Readable.fromWeb(response.body as never);
  source.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (total) onPercent(Math.round((received / total) * 95));
  });
  await pipeline(source, createWriteStream(path));
}

async function sha512(path: string): Promise<string> {
  const hash = createHash('sha512');
  await pipeline((await import('node:fs')).createReadStream(path), hash);
  return hash.digest('base64');
}

// macOS: the built-in updater only accepts signed apps, so the bundle is replaced directly.
export async function installMac(release: Release, onPercent: (percent: number) => void): Promise<void> {
  const bundle = resolve(process.execPath, '../../..');
  if (!bundle.endsWith('.app') || bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) {
    throw new Error('move Patchday to Applications first');
  }
  await access(dirname(bundle), constants.W_OK).catch(() => { throw new Error('no write access to the Applications folder'); });

  const fileName = `Patchday-${release.version}-${process.arch}.zip`;
  const zip = release.assets.find((asset) => asset.name === fileName);
  const manifest = release.assets.find((asset) => asset.name === 'latest-mac.yml');
  if (!zip || !manifest) throw new Error('this release has no update for your Mac');

  const folder = await mkdtemp(join(tmpdir(), 'patchday-update-'));
  try {
    const yml = await (await fetch(manifest.url)).text();
    const expected = macChecksum(yml, fileName);
    if (!expected) throw new Error('this release has no checksum');
    const archive = join(folder, fileName);
    await download(zip.url, archive, onPercent);
    if ((await sha512(archive)) !== expected) throw new Error('download did not match its checksum');

    const unpacked = join(folder, 'new');
    await mkdir(unpacked);
    if ((await exec('ditto', ['-x', '-k', archive, unpacked], { timeoutMs: 5 * 60_000 })).code !== 0) throw new Error('update could not be unpacked');
    const name = (await readdir(unpacked)).find((entry) => entry.endsWith('.app'));
    if (!name) throw new Error('update could not be unpacked');
    const fresh = join(unpacked, name);
    const info = await exec('defaults', ['read', join(fresh, 'Contents', 'Info'), 'CFBundleShortVersionString']);
    if (info.stdout.trim() !== release.version) throw new Error('update has the wrong version');
    await rm(archive, { force: true });

    const script = join(folder, 'swap.sh');
    await writeFile(script, MAC_SWAP_SCRIPT);
    await chmod(script, 0o700);
    onPercent(100);
    spawn('/bin/bash', [script, String(process.pid), bundle, fresh], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 500);
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}
