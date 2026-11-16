// The package hub in the main process: operations queue, bundles, details, sources, icons, backups,
// the menu bar / tray icon and the background check for package updates.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, safeStorage, shell, Tray } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { bundleFromPackages, formatFromName, parseBundle, reviewBundle, serializeBundle, type Bundle, type BundlePackage } from '../core/bundle.ts';
import { ICON_DATABASE_URL, iconUrl, parseIconDatabase, screenshots, type IconDatabase } from '../core/icons.ts';
import { cleanOptions, isEmptyOptions, skipsUpdate, type InstallOptions } from '../core/options.ts';
import { isSafeId, managersFor, MANAGERS, packageKey, type Manager, type Package, type PackageAction } from '../core/packages.ts';
import { hasSources, type SourceManager } from '../core/sources.ts';
import { asSafeUrl } from '../core/url.ts';
import { exec } from '../engine/exec.ts';
import { changeSource, details, listSources } from '../engine/hub.ts';
import { listInstalled, managerStatus, operate, type Inventory, type PackageDeps } from '../engine/packages.ts';
import { OperationQueue, type Operation } from '../engine/queue.ts';
import { createAppFinder, startApp } from '../engine/rescue.ts';
import { BREW_ENV } from '../engine/run.ts';
import type { HistoryEntry } from '../core/history.ts';
import type { Settings } from '../engine/types.ts';

export interface HubEnv {
  data(...parts: string[]): string;
  loadSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  appendLog(message: string): void;
  recordHistory(entries: HistoryEntry[]): Promise<unknown>;
  // True while a scheduled or manual update run is going.
  runBusy(): boolean;
  showWindow(): void;
  checkContainers(): void;
}

const USER_AGENT = 'Patchday (+https://github.com/kvn-be/patchday)';
const MAX_FETCH = 4 * 1024 * 1024;

// Public registries only; nothing about this computer is sent.
export async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000), redirect: 'follow' });
    if (!response.ok) return null;
    const text = await response.text();
    return text.length > MAX_FETCH ? null : text;
  } catch {
    return null;
  }
}

async function fetchImage(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000), redirect: 'follow' });
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!response.ok || !/^image\/(png|jpeg|webp|gif|svg\+xml|x-icon|vnd\.microsoft\.icon)$/.test(type)) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 400 * 1024) return null;
    return `data:${type};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

// What the renderer may change in Settings for the hub, checked before it is saved.
export async function sanitizeHubSettings(patch: Partial<Settings>): Promise<Partial<Settings>> {
  const out: Partial<Settings> = { ...patch };
  if ('parallelOps' in patch) out.parallelOps = Math.max(1, Math.min(4, Math.round(Number(patch.parallelOps) || 1)));
  if ('checkEveryHours' in patch) out.checkEveryHours = [0, 1, 3, 6, 12, 24].includes(Number(patch.checkEveryHours)) ? Number(patch.checkEveryHours) : 24;
  if ('backupKeep' in patch) out.backupKeep = Math.max(1, Math.min(100, Math.round(Number(patch.backupKeep) || 10)));
  if ('disabledManagers' in patch) out.disabledManagers = (Array.isArray(patch.disabledManagers) ? patch.disabledManagers : []).filter((manager) => MANAGERS.includes(manager));
  if ('backupFolder' in patch) out.backupFolder = typeof patch.backupFolder === 'string' && isAbsolute(patch.backupFolder) ? patch.backupFolder : '';
  if ('managerPaths' in patch) {
    const paths: Partial<Record<Manager, string>> = {};
    for (const [manager, path] of Object.entries(patch.managerPaths ?? {})) {
      if (!MANAGERS.includes(manager as Manager) || typeof path !== 'string' || !path.trim()) continue;
      if (!isAbsolute(path) || !(await stat(path).then((info) => info.isFile()).catch(() => false))) throw new Error(`${path} is not a program on this computer`);
      paths[manager as Manager] = path;
    }
    out.managerPaths = paths;
  }
  if ('packageOptions' in patch) {
    const options: Record<string, InstallOptions> = {};
    for (const [key, value] of Object.entries(patch.packageOptions ?? {}).slice(0, 5000)) {
      const cleaned = cleanOptions(value);
      if (/^[\w-]+:[^\s]{1,300}$/.test(key) && !isEmptyOptions(cleaned)) options[key] = cleaned;
    }
    out.packageOptions = options;
  }
  for (const key of ['allowParameters', 'allowCommands', 'allowSkipHash', 'importParameters', 'importCommands', 'closeToTray', 'startAtLogin', 'notifyUpdates', 'autoUpdatePackages', 'showIcons', 'backupEnabled', 'gistBackup'] as const) {
    if (key in patch) out[key] = Boolean(patch[key]);
  }
  return out;
}

export function createHub(env: HubEnv) {
  const depsFor = (settings: Settings): PackageDeps => ({
    exec, platform: process.platform, fetchText, executables: settings.managerPaths, disabled: settings.disabledManagers,
  });
  let cachedSettings: Settings | null = null;
  const settingsNow = async () => (cachedSettings = await env.loadSettings());
  void settingsNow();

  // ---------- Queue ----------

  const queue = new OperationQueue({
    canStart: () => !env.runBusy(),
    run: async (operation, signal, log, phase) => {
      const settings = await settingsNow();
      const key = packageKey(operation.package);
      return operate(depsFor(settings), operation.action, operation.package, {
        options: settings.packageOptions[key] ?? {},
        policy: { allowParameters: settings.allowParameters, allowSkipHash: settings.allowSkipHash },
        allowCommands: settings.allowCommands,
        signal, log, onPhase: phase,
      });
    },
    finished: (operation) => {
      const entry = operation.package;
      env.appendLog(`${operation.action} ${entry.manager} ${entry.id}: ${operation.state === 'done' ? 'done' : `${operation.state}: ${operation.reason}`}`);
      if (operation.state === 'cancelled' && !operation.log.length) return;
      void env.recordHistory([{
        at: operation.finishedAt ?? new Date().toISOString(), action: operation.action, manager: entry.manager, id: entry.id, name: entry.name,
        ok: operation.state === 'done', ...(operation.state === 'done' ? {} : { detail: [operation.reason, operation.detail].filter(Boolean).join('\n') }),
      }]);
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('package-done', { key: packageKey(entry), action: operation.action, ok: operation.state === 'done' });
    },
  }, () => cachedSettings?.parallelOps ?? 1);
  queue.onChange((operations) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('queue', operations);
    updateTray();
  });

  // Anything from the renderer is checked again here before it can reach a command.
  function cleanPackages(input: unknown): Package[] {
    if (!Array.isArray(input)) return [];
    const allowed = managersFor(process.platform);
    return input.slice(0, 2000).flatMap((raw) => {
      const entry = raw as Partial<Package>;
      const manager = entry.manager as Manager;
      if (!MANAGERS.includes(manager) || !allowed.includes(manager) || typeof entry.id !== 'string' || !isSafeId(manager, entry.id)) return [];
      if (entry.kind !== undefined && entry.kind !== 'formula' && entry.kind !== 'cask') return [];
      const version = typeof entry.version === 'string' ? entry.version.slice(0, 64) : '';
      const available = typeof entry.available === 'string' ? entry.available.slice(0, 64) : undefined;
      return [{ manager, id: entry.id, name: typeof entry.name === 'string' ? entry.name.slice(0, 200) : entry.id, version, ...(available ? { available } : {}), ...(entry.kind ? { kind: entry.kind } : {}) }];
    });
  }

  // ---------- Icons ----------

  let iconDb: IconDatabase | null = null;
  async function iconDatabase(): Promise<IconDatabase | null> {
    if (iconDb) return iconDb;
    const path = env.data('icons', 'database.json');
    const fresh = await stat(path).then((info) => Date.now() - info.mtimeMs < 24 * 3600_000).catch(() => false);
    let text = fresh ? await readFile(path, 'utf8').catch(() => null) : null;
    if (!text) {
      text = await fetchText(ICON_DATABASE_URL);
      if (text) await mkdir(env.data('icons'), { recursive: true }).then(() => writeFile(path, text as string)).catch(() => {});
      else text = await readFile(path, 'utf8').catch(() => null);
    }
    try {
      iconDb = text ? parseIconDatabase(text) : null;
    } catch {
      iconDb = null;
    }
    return iconDb;
  }

  async function iconFor(entry: Package): Promise<string | null> {
    const database = await iconDatabase();
    const url = database ? iconUrl(database, entry) : null;
    if (!url) return null;
    const file = env.data('icons', `${createHash('sha1').update(url).digest('hex')}.txt`);
    const cached = await readFile(file, 'utf8').catch(() => null);
    if (cached !== null) return cached || null;
    const image = await fetchImage(url);
    await writeFile(file, image ?? '').catch(() => {});
    return image;
  }

  // ---------- Background check and tray ----------

  let tray: Tray | null = null;
  let lastInventory: Inventory | null = null;
  let updatesCount = 0;
  let checkTimer: ReturnType<typeof setInterval> | undefined;

  function pendingUpdates(settings: Settings, inventory: Inventory): Package[] {
    return inventory.packages.filter((entry) => {
      if (!entry.available) return false;
      if (settings.holds.includes(entry.id) || settings.holds.includes(entry.name)) return false;
      if (settings.skipped[packageKey(entry)] === entry.available) return false;
      return !skipsUpdate(settings.packageOptions[packageKey(entry)] ?? {}, entry.version, entry.available);
    });
  }

  const de = () => cachedSettings?.language === 'de';
  function updateTray(): void {
    if (!tray) return;
    const running = queue.snapshot().filter((operation) => operation.state === 'running' || operation.state === 'queued').length;
    const label = updatesCount ? (de() ? `${updatesCount} Paket-Updates` : `${updatesCount} package updates`) : de() ? 'Alle Pakete aktuell' : 'All packages up to date';
    tray.setToolTip(`Patchday · ${label}${running ? ` · ${running} ${de() ? 'in Arbeit' : 'in progress'}` : ''}`);
    if (process.platform === 'darwin') tray.setTitle(updatesCount ? String(updatesCount) : '');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: de() ? 'Patchday öffnen' : 'Open Patchday', click: () => env.showWindow() },
      { type: 'separator' },
      { label, enabled: false },
      { label: de() ? 'Alle Pakete aktualisieren' : 'Update all packages', enabled: updatesCount > 0, click: () => void updateAllPackages() },
      { label: de() ? 'Jetzt nach Updates suchen' : 'Check for updates now', click: () => { void backgroundCheck(true); env.checkContainers(); } },
      { type: 'separator' },
      { label: de() ? 'Patchday beenden' : 'Quit Patchday', role: 'quit' },
    ]));
  }

  async function updateAllPackages(): Promise<void> {
    const settings = await settingsNow();
    if (!lastInventory) lastInventory = await listInstalled(depsFor(settings));
    queue.add('update', pendingUpdates(settings, lastInventory));
  }

  async function backgroundCheck(manual = false): Promise<void> {
    const settings = await settingsNow();
    if (!manual && settings.checkEveryHours === 0) return;
    if (queue.active) return;
    const inventory = await listInstalled(depsFor(settings)).catch(() => null);
    if (!inventory) return;
    lastInventory = inventory;
    const pending = pendingUpdates(settings, inventory);
    const before = updatesCount;
    updatesCount = pending.length;
    updateTray();
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('inventory', inventory);
    const automatic = pending.filter((entry) => settings.autoUpdatePackages || settings.packageOptions[packageKey(entry)]?.AutoUpdatePackage);
    if (automatic.length) queue.add('update', automatic);
    if (settings.notifyUpdates && updatesCount > before && Notification.isSupported()) {
      const names = pending.slice(0, 3).map((entry) => entry.name).join(', ');
      const notification = new Notification({
        title: de() ? `${updatesCount} Paket-Updates verfügbar` : `${updatesCount} package updates available`,
        body: automatic.length ? (de() ? `${automatic.length} werden automatisch installiert. ${names}` : `${automatic.length} install automatically. ${names}`) : names,
      });
      notification.on('click', () => env.showWindow());
      notification.show();
    }
    if (settings.backupEnabled) await backupIfDue(settings, inventory).catch((error) => env.appendLog(`backup failed: ${(error as Error).message}`));
  }

  function trayImage(): Electron.NativeImage {
    const name = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
    const image = nativeImage.createFromPath(join(__dirname, 'renderer', 'tray', name));
    if (process.platform === 'darwin') image.setTemplateImage(true);
    return image;
  }

  async function startBackground(): Promise<void> {
    const settings = await settingsNow();
    applyLoginItem(settings);
    if (settings.closeToTray && !tray) {
      tray = new Tray(trayImage());
      tray.on('click', () => { if (process.platform !== 'darwin') env.showWindow(); });
      updateTray();
    }
    clearInterval(checkTimer);
    if (settings.checkEveryHours > 0) checkTimer = setInterval(() => void backgroundCheck(), settings.checkEveryHours * 3600_000);
    setTimeout(() => void backgroundCheck(), 60_000);
  }

  function applyLoginItem(settings: Settings): void {
    if (!app.isPackaged || process.platform === 'linux') return;
    app.setLoginItemSettings({ openAtLogin: settings.startAtLogin, args: ['--hidden'] });
  }

  async function settingsChanged(previous: Settings, next: Settings): Promise<void> {
    cachedSettings = next;
    if (previous.startAtLogin !== next.startAtLogin) applyLoginItem(next);
    if (previous.closeToTray !== next.closeToTray) {
      if (!next.closeToTray) {
        tray?.destroy();
        tray = null;
      } else if (!tray) {
        tray = new Tray(trayImage());
        tray.on('click', () => { if (process.platform !== 'darwin') env.showWindow(); });
      }
      updateTray();
    }
    if (previous.checkEveryHours !== next.checkEveryHours) {
      clearInterval(checkTimer);
      if (next.checkEveryHours > 0) checkTimer = setInterval(() => void backgroundCheck(), next.checkEveryHours * 3600_000);
    }
    if (previous.language !== next.language) updateTray();
    queue.pump();
  }

  // ---------- Backups ----------

  const backupFolder = (settings: Settings) => settings.backupFolder || join(homedir(), 'Documents', 'Patchday backups');
  const machine = () => hostname().replace(/[^\w.-]+/g, '-').slice(0, 40) || 'computer';

  function backupText(settings: Settings, inventory: Inventory): string {
    return serializeBundle(bundleFromPackages(inventory.packages, settings.packageOptions, settings.holds, settings.skipped));
  }

  async function backupNow(settings: Settings, inventory?: Inventory): Promise<string> {
    const list = inventory ?? (await listInstalled(depsFor(settings)));
    const text = backupText(settings, list);
    const folder = backupFolder(settings);
    await mkdir(folder, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const prefix = `Patchday ${machine()} `;
    const path = join(folder, `${prefix}${stamp}.ubundle`);
    await writeFile(path, text);
    const old = (await readdir(folder)).filter((name) => name.startsWith(prefix) && name.endsWith('.ubundle')).sort().reverse().slice(settings.backupKeep);
    for (const name of old) await rm(join(folder, name), { force: true });
    if (settings.gistBackup) await uploadGist(settings, text);
    await env.saveSettings({ ...(await env.loadSettings()), lastBackup: new Date().toISOString() });
    env.appendLog(`backup written: ${path}`);
    return path;
  }

  async function backupIfDue(settings: Settings, inventory: Inventory): Promise<void> {
    if (settings.lastBackup && Date.now() - Date.parse(settings.lastBackup) < 23 * 3600_000) return;
    await backupNow(settings, inventory);
  }

  // ---------- GitHub Gist ----------

  async function gistToken(): Promise<string | null> {
    try {
      return safeStorage.decryptString(await readFile(env.data('github.token')));
    } catch {
      return null;
    }
  }

  async function github(method: string, path: string, token: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT, 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401) throw new Error('GitHub did not accept the token');
    if (response.status === 404) throw new Error('the backup gist was not found');
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }

  const gistFile = () => `patchday-${machine()}.ubundle`;

  async function uploadGist(settings: Settings, text: string): Promise<void> {
    const token = await gistToken();
    if (!token) throw new Error('no GitHub token saved');
    const files = { [gistFile()]: { content: text } };
    if (settings.gistId) {
      await github('PATCH', `/gists/${encodeURIComponent(settings.gistId)}`, token, { files });
      return;
    }
    const created = await github('POST', '/gists', token, { description: 'Patchday package backup', public: false, files });
    if (typeof created.id === 'string') await env.saveSettings({ ...(await env.loadSettings()), gistId: created.id });
  }

  async function readGist(settings: Settings): Promise<{ name: string; text: string }[]> {
    const token = await gistToken();
    if (!token || !settings.gistId) throw new Error('no gist backup yet');
    const gist = await github('GET', `/gists/${encodeURIComponent(settings.gistId)}`, token);
    const files = (gist.files ?? {}) as Record<string, { filename?: string; content?: string; truncated?: boolean; raw_url?: string }>;
    return Object.values(files).filter((file) => file.filename?.endsWith('.ubundle') && typeof file.content === 'string' && !file.truncated)
      .map((file) => ({ name: file.filename as string, text: file.content as string }));
  }

  // ---------- Bundles ----------

  function importPolicy(settings: Settings) {
    return { allowParameters: settings.allowParameters && settings.importParameters, allowCommands: settings.allowCommands && settings.importCommands };
  }

  function openBundle(settings: Settings, name: string, text: string) {
    const { bundle, findings } = reviewBundle(parseBundle(text, formatFromName(name), process.platform), importPolicy(settings));
    return { name, bundle, findings };
  }

  function cleanBundlePackages(input: unknown): BundlePackage[] {
    const raw = Array.isArray(input) ? input : [];
    const packages = cleanPackages(raw);
    return packages.map((entry) => {
      const source = raw.find((item) => (item as Package)?.manager === entry.manager && (item as Package)?.id === entry.id) as Partial<BundlePackage> | undefined;
      const ignored = typeof source?.ignored === 'string' && source.ignored.length <= 64 ? source.ignored : undefined;
      return { manager: entry.manager, id: entry.id, name: entry.name, version: entry.version, ...(entry.kind ? { kind: entry.kind } : {}), options: cleanOptions(source?.options), ...(ignored ? { ignored } : {}) };
    });
  }

  // ---------- IPC ----------

  function register(): void {
    const owner = (event: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const save = async (event: Electron.IpcMainInvokeEvent, options: Electron.SaveDialogOptions) => {
      const window = owner(event);
      return window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options);
    };
    const open = async (event: Electron.IpcMainInvokeEvent, options: Electron.OpenDialogOptions) => {
      const window = owner(event);
      return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options);
    };

    ipcMain.handle('packages', async () => {
      const settings = await settingsNow();
      lastInventory = await listInstalled(depsFor(settings));
      updatesCount = pendingUpdates(settings, lastInventory).length;
      updateTray();
      return lastInventory;
    });
    ipcMain.handle('queue', () => queue.snapshot());
    ipcMain.handle('queue-add', (_event, action: unknown, input: unknown) => {
      if (action !== 'install' && action !== 'uninstall' && action !== 'update') throw new Error('unknown action');
      if (env.runBusy()) env.appendLog('package operations wait for the update run to finish');
      return queue.add(action as PackageAction, cleanPackages(input));
    });
    ipcMain.handle('queue-cancel', (_event, id: unknown) => queue.cancel(Number(id)));
    ipcMain.handle('queue-retry', (_event, id: unknown) => queue.retry(Number(id)));
    ipcMain.handle('queue-clear', () => queue.clearFinished());
    ipcMain.handle('queue-log', (_event, id: unknown) => queue.get(Number(id))?.log ?? []);

    ipcMain.handle('managers', async () => managerStatus(depsFor(await settingsNow())));
    ipcMain.handle('sources', async (_event, manager: unknown) => {
      if (!hasSources(manager as Manager) || !managersFor(process.platform).includes(manager as Manager)) throw new Error('this manager has no sources');
      return listSources(depsFor(await settingsNow()), manager as SourceManager);
    });
    ipcMain.handle('source-change', async (_event, manager: unknown, change: unknown, name: unknown, url: unknown) => {
      if (!hasSources(manager as Manager) || !managersFor(process.platform).includes(manager as Manager)) throw new Error('this manager has no sources');
      if (change !== 'add' && change !== 'remove') throw new Error('unknown change');
      await changeSource(depsFor(await settingsNow()), manager as SourceManager, change, String(name ?? ''), String(url ?? ''));
      env.appendLog(`source ${change} ${manager} ${String(name)}`);
      return listSources(depsFor(await settingsNow()), manager as SourceManager);
    });

    ipcMain.handle('details', async (_event, input: unknown) => {
      const [entry] = cleanPackages([input]);
      if (!entry) throw new Error('unknown package');
      const settings = await settingsNow();
      const [info, database] = await Promise.all([details(depsFor(settings), entry).catch(() => ({})), settings.showIcons ? iconDatabase() : null]);
      return { ...info, screenshots: database ? screenshots(database, entry) : [] };
    });
    ipcMain.handle('icons', async (_event, input: unknown) => {
      const settings = await settingsNow();
      if (!settings.showIcons) return {};
      const packages = cleanPackages(input).slice(0, 400);
      const result: Record<string, string> = {};
      let next = 0;
      await Promise.all(Array.from({ length: 6 }, async () => {
        while (next < packages.length) {
          const entry = packages[next++];
          const icon = await iconFor(entry).catch(() => null);
          if (icon) result[packageKey(entry)] = icon;
        }
      }));
      return result;
    });
    // The name in the lists starts the program behind a package, when there is one.
    let finder: { at: number; find: ReturnType<typeof createAppFinder> } | null = null;
    ipcMain.handle('open-app', async (_event, input: unknown) => {
      const [entry] = cleanPackages([input]);
      if (!entry) return 'none';
      if (!finder || Date.now() - finder.at > 5 * 60_000) finder = { at: Date.now(), find: createAppFinder(exec, process.platform, BREW_ENV) };
      const found = await finder.find(entry).catch(() => null);
      if (!found) return 'none';
      const ok = await startApp(exec, found).catch(() => false);
      env.appendLog(`start app ${entry.manager} ${entry.id}: ${ok ? 'started' : 'failed'}`);
      return ok ? 'started' : 'failed';
    });
    ipcMain.handle('open-url', (_event, url: unknown) => {
      const safe = asSafeUrl(typeof url === 'string' ? url : '');
      if (safe) void shell.openExternal(safe);
    });

    ipcMain.handle('options-set', async (_event, key: unknown, options: unknown) => {
      if (typeof key !== 'string' || !/^[\w-]+:[^\s]{1,300}$/.test(key)) throw new Error('unknown package');
      const settings = await env.loadSettings();
      const cleaned = cleanOptions(options);
      const next = { ...settings.packageOptions };
      if (isEmptyOptions(cleaned)) delete next[key];
      else next[key] = cleaned;
      const saved = { ...settings, packageOptions: next };
      await env.saveSettings(saved);
      cachedSettings = saved;
      return saved;
    });

    ipcMain.handle('bundle-open', async (event) => {
      const choice = await open(event, { properties: ['openFile'], filters: [{ name: 'Package bundles', extensions: ['ubundle', 'json', 'yaml', 'yml', 'xml'] }] });
      const path = choice.filePaths[0];
      if (choice.canceled || !path) return null;
      if ((await stat(path)).size > 5 * 1024 * 1024) throw new Error('the bundle is larger than 5 MB');
      return openBundle(await settingsNow(), path.split(/[\\/]/).pop() as string, await readFile(path, 'utf8'));
    });
    ipcMain.handle('bundle-save', async (event, input: unknown, incompatible: unknown) => {
      const packages = cleanBundlePackages(input);
      const others = (Array.isArray(incompatible) ? incompatible : []).slice(0, 5000).map((raw) => {
        const entry = raw as Record<string, unknown>;
        const str = (value: unknown) => (typeof value === 'string' ? value.slice(0, 200) : '');
        return { id: str(entry.id), name: str(entry.name), version: str(entry.version), source: str(entry.source), reason: 'manager-unknown' as const };
      });
      const choice = await save(event, { defaultPath: `Package bundle ${new Date().toISOString().slice(0, 10)}.ubundle`, filters: [{ name: 'Package bundle', extensions: ['ubundle'] }, { name: 'JSON', extensions: ['json'] }] });
      if (choice.canceled || !choice.filePath) return null;
      const bundle: Bundle = { version: 3, packages, incompatible: others };
      await writeFile(choice.filePath, serializeBundle(bundle));
      return choice.filePath.split(/[\\/]/).pop();
    });
    // Installing a bundle keeps its options and ignored updates for each package, like UniGetUI.
    ipcMain.handle('bundle-install', async (_event, input: unknown) => {
      const packages = cleanBundlePackages(input);
      const settings = await env.loadSettings();
      const options = { ...settings.packageOptions };
      const holds = new Set(settings.holds);
      const skipped = { ...settings.skipped };
      for (const entry of packages) {
        const key = packageKey(entry);
        if (!isEmptyOptions(entry.options)) options[key] = entry.options;
        if (entry.ignored === '*') holds.add(entry.id);
        else if (entry.ignored) skipped[key] = entry.ignored;
      }
      const saved = { ...settings, packageOptions: options, holds: [...holds], skipped };
      await env.saveSettings(saved);
      cachedSettings = saved;
      return { settings: saved, ids: queue.add('install', packages.map(({ manager, id, name, version, kind }) => ({ manager, id, name, version, ...(kind ? { kind } : {}) }))) };
    });
    ipcMain.handle('bundle-installed', async () => {
      const settings = await settingsNow();
      const inventory = lastInventory ?? (await listInstalled(depsFor(settings)));
      return bundleFromPackages(inventory.packages, settings.packageOptions, settings.holds, settings.skipped);
    });

    ipcMain.handle('backup-now', async () => backupNow(await settingsNow()));
    ipcMain.handle('backup-folder', async (event) => {
      const choice = await open(event, { properties: ['openDirectory', 'createDirectory'] });
      return choice.canceled ? null : choice.filePaths[0] ?? null;
    });
    ipcMain.handle('backup-open-folder', async () => {
      const folder = backupFolder(await settingsNow());
      await mkdir(folder, { recursive: true });
      await shell.openPath(folder);
    });
    ipcMain.handle('gist-token', async (_event, token: unknown) => {
      if (typeof token !== 'string' || !/^[\w-]{20,255}$/.test(token.trim())) throw new Error('this does not look like a GitHub token');
      if (!safeStorage.isEncryptionAvailable()) throw new Error('This system cannot store the token safely');
      await github('GET', '/gists?per_page=1', token.trim());
      await mkdir(env.data(), { recursive: true });
      await writeFile(env.data('github.token'), safeStorage.encryptString(token.trim()));
      return true;
    });
    ipcMain.handle('gist-forget', async () => {
      await rm(env.data('github.token'), { force: true });
      const settings = await env.loadSettings();
      await env.saveSettings({ ...settings, gistBackup: false, gistId: undefined });
    });
    ipcMain.handle('gist-state', async () => ({ hasToken: (await gistToken()) !== null }));
    ipcMain.handle('gist-restore', async () => {
      const settings = await settingsNow();
      const files = await readGist(settings);
      const mine = files.find((file) => file.name === gistFile()) ?? files[0];
      if (!mine) throw new Error('the gist holds no backup');
      return openBundle(settings, mine.name, mine.text);
    });
  }

  return { queue, register, startBackground, settingsChanged, cleanPackages, backgroundCheck };
}

export type Hub = ReturnType<typeof createHub>;
export type { Operation };
