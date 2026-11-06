import { app, BrowserWindow, ipcMain, Notification, safeStorage, shell } from 'electron';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createPortainerClient } from '../engine/portainer.ts';
import { exec } from '../engine/exec.ts';
import { createTagLookup } from '../engine/registry.ts';
import { run } from '../engine/run.ts';
import { DEFAULT_SETTINGS, type Report, type Settings } from '../engine/types.ts';
import { syncSchedule } from './scheduler.ts';

const COFFEE_URL = 'https://ko-fi.com/kvnbe';
const SCHEDULED_FLAG = '--run-scheduled';
const scheduled = process.argv.includes(SCHEDULED_FLAG);

const data = (...parts: string[]) => join(app.getPath('userData'), ...parts);

async function loadSettings(): Promise<Settings> {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(await readFile(data('settings.json'), 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

// The token stays in the system keychain's care and is never sent to the renderer or any account.
async function loadToken(): Promise<string | null> {
  try {
    return safeStorage.decryptString(await readFile(data('portainer.token')));
  } catch {
    return null;
  }
}

async function listReports(): Promise<Report[]> {
  const names = await readdir(data('reports')).catch(() => []);
  const newest = names.filter((name) => name.endsWith('.json')).sort().reverse().slice(0, 20);
  return Promise.all(newest.map(async (name) => JSON.parse(await readFile(data('reports', name), 'utf8'))));
}

async function execute(mode: Report['mode'], onLog: (message: string) => void): Promise<Report> {
  const settings = await loadSettings();
  const token = await loadToken();
  const report = await run(
    {
      exec,
      tags: createTagLookup(),
      portainer: settings.portainerUrl && token ? createPortainerClient(settings.portainerUrl, token) : null,
      platform: process.platform,
      arch: process.arch,
      backupDir: data('backups'),
      readFile: (path) => readFile(path, 'utf8'),
      writeFile: saveFile,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => new Date(),
      log: onLog,
    },
    settings,
    mode,
  );
  await saveFile(data('reports', `${report.startedAt.replace(/[:.]/g, '-')}.json`), JSON.stringify(report, null, 2));
  return report;
}

function program(): string[] {
  return app.isPackaged ? [process.execPath, SCHEDULED_FLAG] : [process.execPath, app.getAppPath(), SCHEDULED_FLAG];
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 420,
    minHeight: 560,
    backgroundColor: '#12142b',
    title: 'Patchday',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  window.loadFile(join(__dirname, 'renderer', 'index.html'));
  // Nothing inside the app may open other pages.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
}

function registerIpc(): void {
  let busy = false;
  const guarded = async (mode: Report['mode'], sender: Electron.WebContents) => {
    if (busy) throw new Error('A run is already in progress');
    busy = true;
    try {
      return await execute(mode, (message) => sender.send('log', message));
    } finally {
      busy = false;
    }
  };
  ipcMain.handle('state', async () => ({
    settings: await loadSettings(),
    reports: await listReports(),
    version: app.getVersion(),
    platform: process.platform,
    hasToken: (await loadToken()) !== null,
  }));
  ipcMain.handle('settings', async (_event, patch: Partial<Settings>) => {
    const previous = await loadSettings();
    const settings = { ...previous, ...patch };
    await saveFile(data('settings.json'), JSON.stringify(settings, null, 2));
    const scheduleChanged = previous.hourOfWeek !== settings.hourOfWeek || previous.scheduleEnabled !== settings.scheduleEnabled;
    // A development build must never leave a job behind on the machine.
    if (scheduleChanged && app.isPackaged) await syncSchedule(exec, settings.hourOfWeek, settings.scheduleEnabled, program());
    return settings;
  });
  ipcMain.handle('check', (event) => guarded('preview', event.sender));
  ipcMain.handle('update', (event) => guarded('apply', event.sender));
  ipcMain.handle('token', async (_event, token: string) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This system cannot store the token safely');
    await saveFile(data('portainer.token'), '');
    await writeFile(data('portainer.token'), safeStorage.encryptString(token));
  });
  ipcMain.handle('coffee', () => shell.openExternal(COFFEE_URL));
}

async function runScheduled(): Promise<void> {
  const settings = await loadSettings();
  const report = await execute(settings.applyUpdates ? 'apply' : 'preview', () => {});
  const changed = report.items.filter((item) => item.outcome === 'applied').length;
  const open = report.items.filter((item) => item.outcome !== 'applied').length;
  new Notification({ title: 'Patchday', body: `${changed} applied, ${open} need a look` }).show();
  setTimeout(() => app.quit(), 3000);
}

if (!scheduled && !app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(() => {
  if (scheduled) return runScheduled();
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  return undefined;
});

app.on('window-all-closed', () => { if (!scheduled) app.quit(); });
