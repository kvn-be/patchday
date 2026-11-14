import { app, BrowserWindow, dialog, ipcMain, Notification, safeStorage, screen, shell } from 'electron';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { release as osRelease } from 'node:os';
import { createPortainerClient } from '../engine/portainer.ts';
import { exec } from '../engine/exec.ts';
import { createTagLookup } from '../engine/registry.ts';
import { createReleaseNotesLookup } from '../engine/releases.ts';
import { run } from '../engine/run.ts';
import { WORKER_FLAG } from '../core/elevation.ts';
import { backupsToRemove } from '../core/retention.ts';
import { addHistory, type HistoryEntry } from '../core/history.ts';
import { formatLogs, formatRun, LOG_ROTATE_BYTES, runLogName, runLogsToRemove } from '../core/logs.ts';
import { exportList, importList, isSafeId, MANAGERS, packageKey, type Manager, type Package, type PackageAction } from '../core/packages.ts';
import { selfCheckDue } from '../core/selfupdate.ts';
import { act, listInstalled, managersFor, search } from '../engine/packages.ts';
import { DEFAULT_SETTINGS, type ProgressItem, type Report, type Settings } from '../engine/types.ts';
import { runWorker, runWorkerSelfUpdate, setupWorker, startWorkerSelfUpdate, workerReady, writeStatus } from './elevation.ts';
import { ASKPASS_FLAG, ASKPASS_TOKEN_ENV, askpassScript, checkPassword, newSession, sessionAllows, type Session } from './askpass.ts';
import { syncSchedule } from './scheduler.ts';
import { cancelInstallOnQuit, findUpdate, installMac, installWindows, stageMac, stageWindows, swapMac, type StagedMac } from './updater.ts';

const COFFEE_URL = 'https://ko-fi.com/kvnbe';
const SCHEDULED_FLAG = '--run-scheduled';
const scheduled = process.argv.includes(SCHEDULED_FLAG);
const worker = process.argv.includes(WORKER_FLAG);
const askpass = process.argv.includes(ASKPASS_FLAG);
const headless = scheduled || worker || askpass;

// Development only: a separate data folder, so a dev build runs next to an installed Patchday
// and screenshots never show data from this machine.
if (!app.isPackaged && process.env.PATCHDAY_USER_DATA) app.setPath('userData', process.env.PATCHDAY_USER_DATA);

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

// The admin password for unattended Homebrew runs, encrypted like the token. Only the askpass
// helper reads it, and only while a run's session is open.
async function hasAdminPassword(): Promise<boolean> {
  return stat(data('admin.password')).then((info) => info.size > 0).catch(() => false);
}

async function openSudoSession(): Promise<{ env: Record<string, string>; close(): Promise<void> } | null> {
  if (process.platform === 'win32' || !(await hasAdminPassword())) return null;
  const script = data('askpass.sh');
  const { token, session } = newSession(new Date());
  // A development build keeps its own data folder, also inside the helper.
  const keep: Record<string, string> = !app.isPackaged && process.env.PATCHDAY_USER_DATA ? { PATCHDAY_USER_DATA: process.env.PATCHDAY_USER_DATA } : {};
  await saveFile(script, '');
  await chmod(script, 0o700);
  await writeFile(script, askpassScript(program().slice(0, -1), token, keep));
  await saveFile(data('askpass.session'), JSON.stringify(session));
  return {
    env: { SUDO_ASKPASS: script },
    close: async () => {
      await rm(data('askpass.session'), { force: true });
      await rm(script, { force: true });
    },
  };
}

async function runAskpass(): Promise<void> {
  app.dock?.hide();
  try {
    const session = await readFile(data('askpass.session'), 'utf8').then((text) => JSON.parse(text) as Session).catch(() => null);
    if (!sessionAllows(session, process.env[ASKPASS_TOKEN_ENV], new Date())) return app.exit(1);
    const password = await safeStorage.decryptStringAsync(await readFile(data('admin.password'))).then((result) => (typeof result === 'string' ? result : result.result));
    process.stdout.write(`${password}\n`, () => app.exit(0));
  } catch {
    app.exit(1);
  }
}

async function listReports(): Promise<Report[]> {
  const names = await readdir(data('reports')).catch(() => []);
  const newest = names.filter((name) => name.endsWith('.json')).sort().reverse().slice(0, 20);
  return Promise.all(newest.map(async (name) => JSON.parse(await readFile(data('reports', name), 'utf8'))));
}

// The log book behind the export: one line per event, kept to about 1 MB plus one older file.
let logQueue: Promise<unknown> = Promise.resolve();
function appendLog(message: string): void {
  const line = `${new Date().toISOString()} ${message.replace(/\s+/g, ' ').trim()}\n`;
  logQueue = logQueue.then(async () => {
    await mkdir(data('logs'), { recursive: true });
    const size = await stat(data('logs', 'patchday.log')).then((info) => info.size).catch(() => 0);
    if (size > LOG_ROTATE_BYTES) await rename(data('logs', 'patchday.log'), data('logs', 'patchday.1.log')).catch(() => {});
    await appendFile(data('logs', 'patchday.log'), line);
  }).catch(() => {});
}

async function execute(mode: Report['mode'], onLog: (message: string) => void, onProgress: (items: ProgressItem[]) => void = () => {}): Promise<Report> {
  appendLog(`${mode === 'apply' ? 'update run' : 'check'} started`);
  const log = (message: string) => { appendLog(message); onLog(message); };
  const settings = await loadSettings();
  const token = await loadToken();
  const sudo = mode === 'apply' ? await openSudoSession().catch(() => null) : null;
  const report = await run(
    {
      exec,
      tags: createTagLookup(),
      releaseNotes: createReleaseNotesLookup(),
      portainer: settings.portainerUrl && token ? createPortainerClient(settings.portainerUrl, token) : null,
      platform: process.platform,
      arch: process.arch,
      backupDir: data('backups'),
      readFile: (path) => readFile(path, 'utf8'),
      writeFile: saveFile,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => new Date(),
      log,
      onProgress,
      ...(sudo ? { sudoEnv: sudo.env } : {}),
    },
    settings,
    mode,
  ).finally(() => sudo?.close());
  await saveFile(data('reports', `${report.startedAt.replace(/[:.]/g, '-')}.json`), JSON.stringify(report, null, 2));
  await writeRunLog(report).catch((error) => appendLog(`run log not written: ${(error as Error).message}`));
  for (const item of report.items) {
    if (item.outcome === 'failed' || item.outcome === 'rolled-back') appendLog(`${item.outcome}: ${item.name} ${item.from} -> ${item.to}: ${item.reason}`);
  }
  for (const note of report.notes) appendLog(`note: ${note}`);
  appendLog(`${mode === 'apply' ? 'update run' : 'check'} finished: ${report.items.length} items, status ${report.status}`);
  await pruneBackups(log);
  const problems = report.items.filter((item) => item.outcome === 'failed' || item.outcome === 'rolled-back').length;
  await recordHistory([{ at: report.finishedAt, action: 'run', name: mode === 'apply' ? 'Update run' : 'Check', ok: problems === 0, ...(problems ? { detail: `${problems} problems` } : {}) }]);
  return report;
}

function systemName(): string {
  return `${process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform} ${osRelease()} (${process.arch})`;
}

// Every run leaves a readable text file next to the app's logs, without asking.
async function writeRunLog(report: Report): Promise<void> {
  await saveFile(data('logs', 'runs', runLogName(report)), formatRun(report, app.getVersion(), systemName()));
  const names = await readdir(data('logs', 'runs')).catch(() => []);
  for (const name of runLogsToRemove(names)) await rm(data('logs', 'runs', name), { force: true });
}

// The history file is small and rewritten whole, so a crash leaves either the old or the new list.
let historyQueue: Promise<unknown> = Promise.resolve();
function recordHistory(entries: HistoryEntry[]): Promise<unknown> {
  historyQueue = historyQueue.then(async () => {
    const existing = await readFile(data('history.json'), 'utf8').then(JSON.parse).catch(() => []);
    await saveFile(data('history.json.tmp'), JSON.stringify(addHistory(existing, entries)));
    await rename(data('history.json.tmp'), data('history.json'));
  }).catch(() => {});
  return historyQueue;
}

// Anything from the renderer is checked again here before it can reach a command.
function cleanPackages(input: unknown): Package[] {
  if (!Array.isArray(input)) return [];
  const allowed = managersFor(process.platform);
  return input.flatMap((raw) => {
    const entry = raw as Partial<Package>;
    const manager = entry.manager as Manager;
    if (!MANAGERS.includes(manager) || !allowed.includes(manager) || typeof entry.id !== 'string' || !isSafeId(manager, entry.id)) return [];
    if (entry.kind !== undefined && entry.kind !== 'formula' && entry.kind !== 'cask') return [];
    return [{ manager, id: entry.id, name: typeof entry.name === 'string' ? entry.name.slice(0, 200) : entry.id, version: '', ...(entry.kind ? { kind: entry.kind } : {}) }];
  });
}

// Keeps the backup folder from growing forever. A failed cleanup never fails the run.
async function pruneBackups(onLog: (message: string) => void): Promise<void> {
  const names = await readdir(data('backups')).catch(() => []);
  for (const name of backupsToRemove(names, new Date())) {
    try {
      await rm(data('backups', name), { recursive: true, force: true });
      onLog(`removed old backup ${name}`);
    } catch (error) {
      onLog(`could not remove old backup ${name}: ${(error as Error).message}. Delete it by hand if you need the space.`);
    }
  }
}

function program(): string[] {
  return app.isPackaged ? [process.execPath, SCHEDULED_FLAG] : [process.execPath, app.getAppPath(), SCHEDULED_FLAG];
}

// The page is laid out once for this size. The window keeps its shape and the page zooms with it.
const DESIGN_WIDTH = 1280;
const DESIGN_HEIGHT = 720;
const MIN_WIDTH = 960;
const MAX_WIDTH = 1920;

function createWindow(): BrowserWindow {
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
  return window;
}

let busy = false;

function registerIpc(): void {
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
    hasAdminPassword: await hasAdminPassword(),
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
  ipcMain.handle('admin-password', async (_event, password: unknown) => {
    if (process.platform === 'win32') throw new Error('Windows uses the admin task instead');
    if (typeof password !== 'string' || password.length === 0 || password.length > 1024) throw new Error('invalid password');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This system cannot store the password safely');
    if (!(await checkPassword(password))) return false;
    await saveFile(data('admin.password'), '');
    await chmod(data('admin.password'), 0o600);
    await writeFile(data('admin.password'), safeStorage.encryptString(password));
    return true;
  });
  ipcMain.handle('admin-password-forget', async () => {
    await rm(data('admin.password'), { force: true });
  });
  ipcMain.handle('coffee', () => shell.openExternal(COFFEE_URL));
  const deps = { exec, platform: process.platform };
  ipcMain.handle('packages', () => listInstalled(deps));
  ipcMain.handle('search', (_event, query: unknown, managers: unknown) => {
    const allowed = managersFor(process.platform);
    const chosen = Array.isArray(managers) ? allowed.filter((manager) => managers.includes(manager)) : allowed;
    return search(deps, String(query ?? ''), chosen);
  });
  ipcMain.handle('package-action', async (event, action: unknown, input: unknown) => {
    if (action !== 'install' && action !== 'uninstall' && action !== 'update') throw new Error('unknown action');
    const packages = cleanPackages(input);
    if (busy) throw new Error('A run is already in progress');
    busy = true;
    try {
      const results = await act(deps, action as PackageAction, packages, (result, index) => event.sender.send('package-progress', { ...result, index, total: packages.length }));
      packages.forEach((entry, index) => appendLog(`${action} ${entry.manager} ${entry.id}: ${results[index].ok ? 'done' : `failed: ${results[index].reason}`}`));
      await recordHistory(packages.map((entry, index) => ({
        at: new Date().toISOString(), action: action as PackageAction, manager: entry.manager, id: entry.id, name: entry.name,
        ok: results[index].ok, ...(results[index].ok ? {} : { detail: [results[index].reason, results[index].detail].filter(Boolean).join('\n') }),
      })));
      return results;
    } finally {
      busy = false;
    }
  });
  ipcMain.handle('skip', async (_event, key: unknown, version: unknown) => {
    if (typeof key !== 'string' || typeof version !== 'string' || key.length > 300 || version.length > 100) throw new Error('invalid version');
    const settings = await loadSettings();
    settings.skipped = { ...settings.skipped, [key]: version };
    await saveFile(data('settings.json'), JSON.stringify(settings, null, 2));
    return settings;
  });
  ipcMain.handle('export-logs', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = { defaultPath: `patchday-logs-${new Date().toISOString().slice(0, 10)}.txt`, filters: [{ name: 'Text', extensions: ['txt'] }] };
    const choice = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    if (choice.canceled || !choice.filePath) return false;
    const names = (await readdir(data('reports')).catch(() => [])).filter((name) => name.endsWith('.json')).sort().reverse().slice(0, 200);
    const reports = (await Promise.all(names.map((name) => readFile(data('reports', name), 'utf8').then(JSON.parse).catch(() => null)))).filter(Boolean);
    const history = await readFile(data('history.json'), 'utf8').then((text) => addHistory(JSON.parse(text), [])).catch(() => []);
    const log = [await readFile(data('logs', 'patchday.1.log'), 'utf8').catch(() => ''), await readFile(data('logs', 'patchday.log'), 'utf8').catch(() => '')].join('');
    await writeFile(choice.filePath, formatLogs({ version: app.getVersion(), system: systemName(), exportedAt: new Date(), reports, history, log }));
    return true;
  });
  ipcMain.handle('open-run-logs', async () => {
    await mkdir(data('logs', 'runs'), { recursive: true });
    const problem = await shell.openPath(data('logs', 'runs'));
    if (problem) throw new Error(problem);
  });
  ipcMain.handle('history', async () => readFile(data('history.json'), 'utf8').then((text) => addHistory(JSON.parse(text), [])).catch(() => []));
  ipcMain.handle('export', async (event, input: unknown) => {
    const packages = cleanPackages(input);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = { defaultPath: `patchday-packages-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'Patchday package list', extensions: ['json'] }] };
    const choice = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    if (choice.canceled || !choice.filePath) return null;
    await writeFile(choice.filePath, JSON.stringify(exportList(packages, new Date()), null, 2));
    return packages.length;
  });
  ipcMain.handle('import', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = { properties: ['openFile' as const], filters: [{ name: 'Patchday package list', extensions: ['json'] }] };
    const choice = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    const path = choice.filePaths[0];
    if (choice.canceled || !path) return null;
    if ((await stat(path)).size > 2 * 1024 * 1024) throw new Error('the file is larger than 2 MB, so it is not a Patchday package list');
    const result = importList(await readFile(path, 'utf8'));
    // Lists from another system keep only what this system can install.
    const usable = cleanPackages(result.packages);
    return { packages: usable, skipped: result.skipped + result.packages.length - usable.length };
  });
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
      // A version that is already downloaded in the background only needs the restart.
      if (stagedMac) {
        installingOnQuit = true;
        await swapMac(stagedMac, true);
        onPercent(100);
        setTimeout(() => app.quit(), 500);
        return;
      }
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

// ---------- Automatic self-update ----------

let stagedMac: StagedMac | null = null;
let stagedWindows: string | null = null;
let selfTimer: ReturnType<typeof setInterval> | undefined;

async function autoSelfUpdate(window: BrowserWindow): Promise<void> {
  const settings = await loadSettings();
  if (!app.isPackaged || !settings.autoSelfUpdate || stagedMac || stagedWindows) return;
  if (!selfCheckDue(settings.lastSelfCheck, new Date())) return;
  await saveFile(data('settings.json'), JSON.stringify({ ...settings, lastSelfCheck: new Date().toISOString() }, null, 2));
  try {
    if (process.platform === 'darwin') {
      const release = await findUpdate();
      if (!release) return;
      stagedMac = await stageMac(release, () => {});
      window.webContents.send('self-ready', release.version);
    } else if (process.platform === 'win32') {
      stagedWindows = await stageWindows();
      if (stagedWindows) window.webContents.send('self-ready', stagedWindows);
    }
  } catch (error) {
    // A failed background update is retried on the next day and never interrupts the app.
    console.error(`automatic update failed: ${(error as Error).message}`);
  }
}

function startAutoSelfUpdate(window: BrowserWindow): void {
  window.webContents.once('did-finish-load', () => void autoSelfUpdate(window));
  selfTimer = setInterval(() => void autoSelfUpdate(window), 60 * 60_000);
}

let installingOnQuit = false;
app.on('before-quit', (event) => {
  if (headless || installingOnQuit || (!stagedMac && !stagedWindows)) return;
  installingOnQuit = true;
  clearInterval(selfTimer);
  if (stagedMac) {
    const staged = stagedMac;
    event.preventDefault();
    void swapMac(staged, false)
      .then(() => recordHistory([{ at: new Date().toISOString(), action: 'self-update', name: `Patchday ${staged.version}`, ok: true }]))
      .catch(() => {})
      .finally(() => app.quit());
    return;
  }
  // Windows: the admin task installs without a prompt; otherwise electron-updater runs the installer on quit.
  event.preventDefault();
  void workerReady(exec)
    .then(async (ready) => {
      await recordHistory([{ at: new Date().toISOString(), action: 'self-update', name: `Patchday ${stagedWindows}`, ok: true }]);
      if (ready) {
        cancelInstallOnQuit();
        await startWorkerSelfUpdate(exec, data('job.json'));
      }
    })
    .catch(() => {})
    .finally(() => app.quit());
});

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

async function selfUpdateAsWorker(path: string, reopen: boolean): Promise<void> {
  try {
    await installWindows((percent) => void writeStatus(path, { state: 'running', items: [], selfUpdate: { percent } }), reopen);
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
  const parsed = job ? JSON.parse(job) : null;
  if (parsed?.action === 'self-update') return selfUpdateAsWorker(path, parsed.reopen !== false);

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
  if (askpass) return runAskpass();
  if (worker) return runAsWorker();
  if (scheduled) return runScheduled();
  registerIpc();
  startAutoSelfUpdate(createWindow());
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  return undefined;
});

app.on('window-all-closed', () => { if (!headless) app.quit(); });
