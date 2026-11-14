import { app } from 'electron';
import electronUpdater from 'electron-updater';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, chmod, constants, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MAC_SWAP_SCRIPT, macChecksum, macSize, pickRelease, requiredAssets, type Release } from '../core/selfupdate.ts';
import { exec } from '../engine/exec.ts';

const RELEASES_URL = 'https://api.github.com/repos/kvn-be/patchday/releases?per_page=20';

export async function findUpdate(): Promise<Release | null> {
  const response = await fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const needs = (version: string) => requiredAssets(process.platform, process.arch, version);
  return pickRelease((await response.json()) as Parameters<typeof pickRelease>[0], app.getVersion(), needs);
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
export async function installWindows(onPercent: (percent: number) => void, reopen = true): Promise<void> {
  const autoUpdater = updater();
  autoUpdater.on('download-progress', (progress) => onPercent(Math.round(progress.percent)));
  const found = await autoUpdater.checkForUpdates();
  if (!found?.isUpdateAvailable) throw new Error('no update found');
  await autoUpdater.downloadUpdate();
  onPercent(100);
  setTimeout(() => autoUpdater.quitAndInstall(true, reopen), 2000);
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

export interface StagedMac {
  version: string;
  folder: string;
  fresh: string;
  bundle: string;
}

// macOS: the built-in updater only accepts signed apps, so the bundle is replaced directly.
// The new app is downloaded, checked and unpacked first; the swap happens once Patchday has quit.
export async function stageMac(release: Release, onPercent: (percent: number) => void): Promise<StagedMac> {
  const bundle = resolve(process.execPath, '../../..');
  if (!bundle.endsWith('.app') || bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) {
    throw new Error('move Patchday to Applications first');
  }
  await access(dirname(bundle), constants.W_OK).catch(() => { throw new Error('no write access to the Applications folder'); });

  const zipName = `Patchday-${release.version}-${process.arch}.zip`;
  const dmgName = `Patchday-${release.version}-${process.arch}.dmg`;
  const manifest = release.assets.find((asset) => asset.name === 'latest-mac.yml');
  if (!manifest || !release.assets.some((asset) => asset.name === zipName)) throw new Error('this release has no update for your Mac');

  const folder = await mkdtemp(join(tmpdir(), 'patchday-update-'));
  try {
    const unpacked = join(folder, 'new');
    await mkdir(unpacked);
    // First the zip, up to three times; then the disk image, the same app as a fresh install.
    let lastError: Error | null = null;
    let ready = false;
    for (const [fileName, tries] of [[zipName, 3], [dmgName, 2]] as const) {
      const asset = release.assets.find((entry) => entry.name === fileName);
      if (!asset || ready) continue;
      for (let attempt = 1; attempt <= tries && !ready; attempt++) {
        try {
          await fetchVerified(manifest.url, asset.url, fileName, join(folder, fileName), onPercent);
          await unpack(join(folder, fileName), unpacked, folder);
          ready = true;
        } catch (error) {
          lastError = error as Error;
          await rm(join(folder, fileName), { force: true });
          await rm(unpacked, { recursive: true, force: true });
          await mkdir(unpacked);
        }
      }
    }
    if (!ready) throw lastError ?? new Error('update could not be downloaded');

    const name = (await readdir(unpacked)).find((entry) => entry.endsWith('.app'));
    if (!name) throw new Error('update could not be unpacked');
    const fresh = join(unpacked, name);
    const info = await exec('defaults', ['read', join(fresh, 'Contents', 'Info'), 'CFBundleShortVersionString']);
    if (info.stdout.trim() !== release.version) throw new Error('update has the wrong version');
    onPercent(100);
    return { version: release.version, folder, fresh, bundle };
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}

// The manifest is read fresh for every try, so a release that was still uploading is seen complete.
async function fetchVerified(manifestUrl: string, url: string, fileName: string, path: string, onPercent: (percent: number) => void): Promise<void> {
  const yml = await (await fetch(manifestUrl, { cache: 'no-store' })).text();
  const expected = macChecksum(yml, fileName);
  if (!expected) throw new Error('this release has no checksum');
  await download(url, path, onPercent);
  const size = macSize(yml, fileName);
  if (size !== null && (await stat(path)).size !== size) throw new Error('download was incomplete');
  if ((await sha512(path)) !== expected) throw new Error('download did not match its checksum');
}

async function unpack(file: string, target: string, folder: string): Promise<void> {
  if (file.endsWith('.zip')) {
    if ((await exec('ditto', ['-x', '-k', file, target], { timeoutMs: 5 * 60_000 })).code !== 0) throw new Error('update could not be unpacked');
    return;
  }
  const mount = join(folder, 'mount');
  await mkdir(mount, { recursive: true });
  if ((await exec('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, file], { timeoutMs: 5 * 60_000 })).code !== 0) throw new Error('update could not be opened');
  try {
    const name = (await readdir(mount)).find((entry) => entry.endsWith('.app'));
    if (!name || (await exec('ditto', [join(mount, name), join(target, name)], { timeoutMs: 5 * 60_000 })).code !== 0) throw new Error('update could not be unpacked');
  } finally {
    await exec('hdiutil', ['detach', '-quiet', mount], { timeoutMs: 60_000 });
  }
}

// Starts the swap, which waits until this process has ended. With reopen, the new version starts afterwards.
export async function swapMac(staged: StagedMac, reopen: boolean): Promise<void> {
  await access(staged.fresh).catch(() => { throw new Error('the downloaded update is gone, check again'); });
  const script = join(staged.folder, 'swap.sh');
  await writeFile(script, MAC_SWAP_SCRIPT);
  await chmod(script, 0o700);
  spawn('/bin/bash', [script, String(process.pid), staged.bundle, staged.fresh, ...(reopen ? [] : ['--no-open'])], { detached: true, stdio: 'ignore' }).unref();
}

export async function installMac(release: Release, onPercent: (percent: number) => void): Promise<void> {
  await swapMac(await stageMac(release, onPercent), true);
  setTimeout(() => app.quit(), 500);
}

// Windows: electron-updater keeps the verified download and runs the installer when Patchday quits.
export async function stageWindows(): Promise<string | null> {
  const autoUpdater = updater();
  const found = await autoUpdater.checkForUpdates();
  if (!found?.isUpdateAvailable) return null;
  await autoUpdater.downloadUpdate();
  autoUpdater.autoInstallOnAppQuit = true;
  return found.updateInfo.version;
}

// Used when the admin task takes over, so the installer does not run twice.
export function cancelInstallOnQuit(): void {
  electronUpdater.autoUpdater.autoInstallOnAppQuit = false;
}
