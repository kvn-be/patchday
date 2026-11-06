import { app, BrowserWindow, ipcMain, Notification, safeStorage, screen, shell } from 'electron';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createPortainerClient } from '../engine/portainer.ts';
import { exec } from '../engine/exec.ts';
import { createTagLookup } from '../engine/registry.ts';
import { run } from '../engine/run.ts';
import { WORKER_FLAG } from '../core/elevation.ts';
import { DEFAULT_SETTINGS, type ProgressItem, type Report, type Settings } from '../engine/types.ts';
import { runWorker, runWorkerSelfUpdate, setupWorker, workerReady, writeStatus } from './elevation.ts';
import { syncSchedule } from './scheduler.ts';
import { findUpdate, installMac, installWindows } from './updater.ts';

const COFFEE_URL = 'https://ko-fi.com/kvnbe';
const SCHEDULED_FLAG = '--run-scheduled';
const scheduled = process.argv.includes(SCHEDULED_FLAG);
const worker = process.argv.includes(WORKER_FLAG);
const headless = scheduled || worker;

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

async function execute(mode: Report['mode'], onLog: (message: string) => void, onProgress: (items: ProgressItem[]) => void = () => {}): Promise<Report> {
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
      onProgress,
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

// The page is laid out once for this size. The window keeps its shape and the page zooms with it.
const DESIGN_WIDTH = 1280;
const DESIGN_HEIGHT = 720;
const MIN_WIDTH = 960;
const MAX_WIDTH = 1920;

function createWindow(): void {
  const area = screen.getPrimaryDisplay().workAreaSize;
  const room = Math.floor(Math.min(area.width, ((area.height - 40) * DESIGN_WIDTH) / DESIGN_HEIGHT));
  const width = Math.max(MIN_WIDTH, Math.min(DESIGN_WIDTH, room));
  const window = new BrowserWindow({
    width,
    height: Math.round((width * DESIGN_HEIGHT) / DESIGN_WIDTH),
    useContentSize: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#12142b',
    title: 'Patchday',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  window.setAspectRatio(DESIGN_WIDTH / DESIGN_HEIGHT);
  window.setContentSize(width, Math.round((width * DESIGN_HEIGHT) / DESIGN_WIDTH));
  const frameWidth = window.getSize()[0] - window.getContentSize()[0];
  const frameHeight = window.getSize()[1] - window.getContentSize()[1];
  const heightFor = (contentWidth: number) => Math.round((contentWidth * DESIGN_HEIGHT) / DESIGN_WIDTH) + frameHeight;
  window.setMinimumSize(MIN_WIDTH + frameWidth, heightFor(MIN_WIDTH));
  window.setMaximumSize(MAX_WIDTH + frameWidth, heightFor(MAX_WIDTH));
  const fit = () => window.webContents.setZoomFactor(window.getContentSize()[0] / DESIGN_WIDTH);
  window.on('resize', fit);
  window.webContents.on('did-finish-load', fit);
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
      const onItems = (items: ProgressItem[]) => sender.send('progress', items);
      // Windows: real updates go through the task that already holds admin rights.
      if (mode === 'apply' && (await workerReady(exec))) return await runWorker(exec, data('progress.json'), onItems);
      return await execute(mode, (message) => sender.send('log', message), onItems);
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
    adminReady: await workerReady(exec),
    packaged: app.isPackaged,
  }));
  ipcMain.handle('admin', async () => {
    if (process.platform !== 'win32' || !app.isPackaged) return false;
    await saveFile(data('settings.json'), JSON.stringify({ ...(await loadSettings()), adminAsked: true }, null, 2));
    return setupWorker(exec, data('worker-task.xml'), process.execPath);
  });
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
  ipcMain.handle('self-check', async () => {
    if (!app.isPackaged) return null;
    return (await findUpdate().catch(() => null))?.version ?? null;
  });
  ipcMain.handle('self-check-manual', async () => {
    if (!app.isPackaged) return null;
    return (await findUpdate())?.version ?? null;
  });
  ipcMain.handle('self-install', async (event) => {
    const onPercent = (percent: number) => event.sender.send('self-progress', percent);
    if (process.platform === 'darwin') {
      const release = await findUpdate();
      if (release) await installMac(release, onPercent);
      return;
    }
    if (await workerReady(exec)) {
      await runWorkerSelfUpdate(exec, data('job.json'), data('progress.json'), onPercent);
      app.quit();
      return;
    }
    await installWindows(onPercent);
  });
}

async function runScheduled(): Promise<void> {
  const settings = await loadSettings();
  const elevated = settings.applyUpdates && (await workerReady(exec));
  const report = elevated
    ? await runWorker(exec, data('progress.json'), () => {})
    : await execute(settings.applyUpdates ? 'apply' : 'preview', () => {});
  const changed = report.items.filter((item) => item.outcome === 'applied').length;
  const open = report.items.filter((item) => item.outcome !== 'applied').length;
  new Notification({ title: 'Patchday', body: `${changed} applied, ${open} need a look` }).show();
  setTimeout(() => app.quit(), 3000);
}

async function selfUpdateAsWorker(path: string): Promise<void> {
  try {
    await installWindows((percent) => void writeStatus(path, { state: 'running', items: [], selfUpdate: { percent } }));
    await writeStatus(path, { state: 'done', items: [], selfUpdate: { percent: 100 } });
  } catch (error) {
    await writeStatus(path, { state: 'running', items: [], selfUpdate: { percent: 0, error: (error as Error).message } });
    app.quit();
  }
}

async function runAsWorker(): Promise<void> {
  const path = data('progress.json');
  // Installers fail with a path error if the temp folder of this session is gone.
  await mkdir(app.getPath('temp'), { recursive: true }).catch(() => {});
  const job = await readFile(data('job.json'), 'utf8').catch(() => null);
  await rm(data('job.json'), { force: true });
  if (job && JSON.parse(job).action === 'self-update') return selfUpdateAsWorker(path);

  let items: ProgressItem[] = [];
  await writeStatus(path, { state: 'running', items });
  const report = await execute('apply', () => {}, (next) => {
    items = next;
    void writeStatus(path, { state: 'running', items });
  });
  await writeStatus(path, { state: 'done', items, report });
  app.quit();
}

if (!headless && !app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(() => {
  if (worker) return runAsWorker();
  if (scheduled) return runScheduled();
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  return undefined;
});

app.on('window-all-closed', () => { if (!headless) app.quit(); });
