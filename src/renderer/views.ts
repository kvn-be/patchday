import type { HistoryEntry } from '../core/history.ts';
import type { Bundle, BundlePackage, Finding, IncompatiblePackage } from '../core/bundle.ts';
import type { Details } from '../core/details.ts';
import type { Source } from '../core/sources.ts';
import type { Manager, Package, PackageAction } from '../core/packages.ts';
import { MANAGER_NAMES } from '../core/packages.ts';
import { cleanOptions, skipsUpdate, type InstallOptions } from '../core/options.ts';
import type { Operation } from '../engine/queue.ts';
import type { ManagerStatus } from '../engine/packages.ts';
import type { Settings } from '../engine/types.ts';
import { reason, STRINGS, type Language } from './i18n.ts';

type Strings = { readonly [K in keyof (typeof STRINGS)['en']]: (typeof STRINGS)['en'][K] extends string ? string : readonly string[] };
type Inventory = { packages: Package[]; managers: Manager[]; problems: string[] };
type OpenedBundle = { name: string; bundle: Bundle; findings: Finding[] };

export interface PackageApi {
  packages(): Promise<Inventory>;
  search(query: string, managers: Manager[]): Promise<{ packages: Package[]; problems: string[] }>;
  skip(key: string, version: string): Promise<Settings>;
  history(): Promise<HistoryEntry[]>;
  exportLogs(): Promise<boolean>;
  openRunLogs(): Promise<void>;
  queue(): Promise<Operation[]>;
  queueAdd(action: PackageAction, packages: Package[]): Promise<number[]>;
  queueCancel(id: number): Promise<void>;
  queueRetry(id: number): Promise<number[]>;
  queueClear(): Promise<void>;
  queueLog(id: number): Promise<string[]>;
  onQueue(listener: (operations: Operation[]) => void): void;
  onPackageDone(listener: (done: { key: string; action: PackageAction; ok: boolean }) => void): void;
  onInventory(listener: (inventory: Inventory) => void): void;
  managers(): Promise<ManagerStatus[]>;
  sources(manager: Manager): Promise<Source[]>;
  sourceChange(manager: Manager, change: 'add' | 'remove', name: string, url: string): Promise<Source[]>;
  details(entry: Package): Promise<Details & { screenshots: string[] }>;
  icons(packages: Package[]): Promise<Record<string, string>>;
  openUrl(url: string): Promise<void>;
  setOptions(key: string, options: InstallOptions): Promise<Settings>;
  bundleOpen(): Promise<OpenedBundle | null>;
  bundleSave(packages: BundlePackage[], incompatible: IncompatiblePackage[]): Promise<string | null>;
  bundleInstall(packages: BundlePackage[]): Promise<{ settings: Settings; ids: number[] }>;
  bundleInstalled(): Promise<Bundle>;
  backupNow(): Promise<string>;
  backupFolder(): Promise<string | null>;
  backupOpenFolder(): Promise<void>;
  gistToken(token: string): Promise<boolean>;
  gistForget(): Promise<void>;
  gistState(): Promise<{ hasToken: boolean }>;
  gistRestore(): Promise<OpenedBundle>;
}

export interface ViewContext {
  api: PackageApi;
  t(): Strings;
  settings(): Settings;
  setSettings(settings: Settings): void;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  busy(): boolean;
  setBusy(label: string): void;
  ask(title: string, text: string, yes: string): Promise<boolean>;
  // Draws the update run's steps into the box; false while no run is going.
  renderRun(box: HTMLElement): boolean;
  showPage(page: string): void;
  platform(): string;
}

const key = (entry: Pick<Package, 'manager' | 'id'>) => `${entry.manager}:${entry.id}`;
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const SEARCH_DELAY_MS = 700;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(label: string, tone: 'main' | 'line', onClick: () => void, small = true): HTMLButtonElement {
  const node = element('button', `pd-btn pd-btn-${tone}${small ? ' pd-btn-small' : ''}`, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function switchButton(on: boolean, label: string, onChange: (on: boolean) => void, disabled = false): HTMLButtonElement {
  const node = element('button', 'pd-switch');
  node.type = 'button';
  node.setAttribute('role', 'switch');
  node.setAttribute('aria-checked', String(on));
  node.setAttribute('aria-label', label);
  node.disabled = disabled;
  node.append(element('span'));
  node.addEventListener('click', () => {
    const next = node.getAttribute('aria-checked') !== 'true';
    node.setAttribute('aria-checked', String(next));
    onChange(next);
  });
  return node;
}

function iconNode(name: string, image: string | undefined, fresh = false, className = 'icon'): HTMLElement {
  const icon = element('span', `${className}${fresh ? ' new' : ''}`);
  icon.setAttribute('aria-hidden', 'true');
  if (image) {
    const img = element('img');
    img.src = image;
    img.alt = '';
    icon.append(img);
  } else {
    icon.textContent = (name.trim()[0] ?? '?').toUpperCase();
  }
  return icon;
}

// Every list row has the same anatomy: icon, name with source, version, then actions.
function row(name: string, meta: string, version: string, image?: string, fresh = false): { row: HTMLElement; acts: HTMLElement; title: HTMLElement } {
  const node = element('div', 'pd-item');
  const title = element('div', 'name');
  title.append(element('span', '', name), element('small', '', meta));
  const ver = element('span', 'ver', version);
  ver.title = version;
  const acts = element('div', 'acts');
  node.append(iconNode(name, image, fresh), title, ver, acts);
  return { row: node, acts, title };
}

function pageHead(id: string, title: string, lead: string, tools: HTMLElement[]): HTMLElement {
  const head = element('header', 'pd-page-head');
  const titles = element('div');
  const h1 = element('h1', '', title);
  h1.id = id;
  titles.append(h1, element('p', '', lead));
  head.append(titles);
  if (tools.length) {
    const bar = element('div', 'pd-toolbar pd-glass');
    bar.append(...tools);
    head.append(bar);
  }
  return head;
}

function scrollPanel(id?: string): { frame: HTMLElement; panel: HTMLElement } {
  const frame = element('div', 'panel pd-surface');
  const panel = element('div', 'panel-scroll pd-scroll-edge');
  if (id) panel.id = id;
  frame.append(panel);
  return { frame, panel };
}

// Which install options each manager understands; the options sheet shows only those.
const CAN: Record<string, Manager[]> = {
  version: ['winget', 'choco', 'scoop', 'pip', 'npm', 'dotnet', 'pwsh', 'winps', 'cargo'],
  scope: ['winget', 'scoop', 'pip', 'pwsh', 'winps'],
  arch: ['winget', 'choco', 'scoop'],
  location: ['winget'],
  interactive: ['winget'],
  prerelease: ['choco', 'pip', 'dotnet', 'pwsh', 'winps'],
  skipHash: ['winget', 'choco', 'scoop'],
  removeData: ['winget', 'scoop', 'brew'],
};

export function createViews(ctx: ViewContext) {
  let inventory: Inventory | null = null;
  let loading = false;
  let query = '';
  let tab: 'installed' | 'updates' | 'discover' = 'installed';
  let managerFilter: Manager | 'all' = 'all';
  let sortBy: 'name' | 'source' = 'name';
  let found: Package[] = [];
  let searching = false;
  let searchedFor = '';
  const selected = new Set<string>();
  const icons = new Map<string, string>();
  const iconAsked = new Set<string>();
  let history: HistoryEntry[] = [];
  let status = '';
  let historyStatus = '';
  let bundleStatus = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let operations: Operation[] = [];
  const openLogs = new Set<number>();
  let bundle: { name: string; packages: BundlePackage[]; incompatible: IncompatiblePackage[]; dirty: boolean } | null = null;
  const bundleSelected = new Set<string>();
  let managers: ManagerStatus[] | null = null;
  let hasGistToken = false;
  let hubMessage = '';
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;

  const t = ctx.t;
  const language = () => ctx.settings().language as Language;
  const settings = () => ctx.settings();
  const holds = () => new Set(settings().holds);
  const optionsOf = (entry: Pick<Package, 'manager' | 'id'>) => settings().packageOptions?.[key(entry)] ?? {};
  const skippedVersion = (entry: Package) => settings().skipped[key(entry)];
  const isHeld = (entry: Package) => holds().has(entry.id) || holds().has(entry.name);
  const hasUpdate = (entry: Package) => Boolean(entry.available) && skippedVersion(entry) !== entry.available && !isHeld(entry)
    && !skipsUpdate(optionsOf(entry), entry.version, entry.available as string);
  const installedEntry = (entry: Pick<Package, 'manager' | 'id'>) => {
    const short = (id: string) => id.split('/').pop();
    return (inventory?.packages ?? []).find((have) => have.manager === entry.manager && (have.id === entry.id || short(have.id) === short(entry.id)));
  };
  const clean = (error: unknown) => reason(language(), (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  const managerName = (manager: string) => (manager in MANAGER_NAMES ? MANAGER_NAMES[manager as Manager] : manager);
  const when = (iso: string) => new Date(iso).toLocaleString(t().locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

  // ---------- Loading ----------

  async function loadPackages(): Promise<void> {
    if (loading) return;
    loading = true;
    renderList();
    try {
      inventory = await ctx.api.packages();
    } catch (error) {
      status = `${t().actionFailed} ${clean(error)}`;
    } finally {
      loading = false;
      renderList();
      renderBundles();
    }
  }

  async function loadHistory(): Promise<void> {
    history = await ctx.api.history().catch(() => []);
    renderHistory();
  }

  function requestIcons(packages: Package[]): void {
    if (!settings().showIcons) return;
    const missing = packages.filter((entry) => !iconAsked.has(key(entry))).slice(0, 120);
    if (!missing.length) return;
    for (const entry of missing) iconAsked.add(key(entry));
    void ctx.api.icons(missing).then((result) => {
      for (const [name, image] of Object.entries(result)) icons.set(name, image);
      if (Object.keys(result).length) {
        renderList();
        renderBundles();
      }
    }).catch(() => {});
  }

  async function runSearch(): Promise<void> {
    const text = query.trim();
    if (text.length < 2 || text === searchedFor) return;
    searching = true;
    renderList();
    try {
      if (!inventory) await loadPackages();
      const result = await ctx.api.search(text, inventory?.managers ?? []);
      if (query.trim() !== text) return;
      // Exact names first, then names that start with the search, then the rest.
      const needle = text.toLowerCase();
      const rank = (entry: Package) => { const name = entry.name.toLowerCase(); const id = entry.id.toLowerCase(); return name === needle || id === needle || id.endsWith(`/${needle}`) ? 0 : name.startsWith(needle) || id.startsWith(needle) ? 1 : name.includes(needle) ? 2 : 3; };
      found = result.packages.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
      searchedFor = text;
      status = result.problems.join(' ');
    } catch (error) {
      found = [];
      searchedFor = text;
      status = clean(error);
    } finally {
      searching = false;
      renderList();
    }
  }

  // Installs, updates and removals go into the queue after one question.
  async function enqueue(action: PackageAction, packages: Package[]): Promise<void> {
    if (packages.length === 0) return;
    const names = packages.slice(0, 8).map((entry) => entry.name).join(', ') + (packages.length > 8 ? ', …' : '');
    if (action === 'uninstall' && !(await ctx.ask(t().confirmUninstallTitle, fill(t().confirmUninstallText, { names }), t().uninstallOne))) return;
    if (action === 'install' && !(await ctx.ask(t().confirmInstallTitle, fill(t().confirmInstallText, { names }), t().installOne))) return;
    try {
      const ids = await ctx.api.queueAdd(action, packages);
      status = fill(t().queuedNote, { count: ids.length });
      for (const entry of packages) selected.delete(key(entry));
    } catch (error) {
      status = `${t().actionFailed} ${clean(error)}`;
    }
    renderList();
  }

  ctx.api.onQueue((next) => {
    operations = next;
    renderQueue();
    renderList();
    renderCounts();
  });
  ctx.api.onPackageDone(() => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void Promise.all([loadPackages(), loadHistory()]), 1500);
  });
  ctx.api.onInventory((next) => {
    inventory = next;
    renderList();
    renderBundles();
  });

  function runningFor(entry: Package): Operation | undefined {
    return operations.find((operation) => (operation.state === 'queued' || operation.state === 'running') && key(operation.package) === key(entry));
  }

  function renderCounts(): void {
    const active = operations.filter((operation) => operation.state === 'queued' || operation.state === 'running').length + (ctx.busy() ? 1 : 0);
    const queueCount = document.getElementById('nav-queue-count');
    if (queueCount) {
      queueCount.hidden = active === 0;
      queueCount.textContent = String(active);
    }
    const bundleCount = document.getElementById('nav-bundle-count');
    if (bundleCount) {
      bundleCount.hidden = !bundle?.packages.length;
      bundleCount.textContent = String(bundle?.packages.length ?? 0);
    }
  }

  // ---------- Packages ----------

  function renderPackages(): void {
    const page = document.getElementById('page-packages');
    if (!page) return;
    page.replaceChildren();
    const refresh = button(t().refresh, 'line', () => void loadPackages(), false);
    const toBundle = button(t().navBundles, 'line', () => ctx.showPage('bundles'), false);
    const head = pageHead('packages-title', t().navPackages, t().packagesLead, [refresh, toBundle]);

    const search = element('label', 'search pd-glass');
    search.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>';
    const input = element('input');
    input.type = 'search';
    input.id = 'package-search';
    input.placeholder = t().searchPlaceholder;
    input.setAttribute('aria-label', t().searchPlaceholder);
    input.value = query;
    input.addEventListener('input', () => {
      query = input.value;
      clearTimeout(timer);
      if (query.trim().length < 2) {
        found = [];
        searchedFor = '';
      } else {
        if (tab !== 'discover' && !(inventory?.packages ?? []).some((entry) => `${entry.name} ${entry.id}`.toLowerCase().includes(query.trim().toLowerCase()))) tab = 'discover';
        timer = setTimeout(() => void runSearch(), SEARCH_DELAY_MS);
      }
      renderList();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      clearTimeout(timer);
      tab = 'discover';
      void runSearch();
    });
    const managerLine = element('small');
    managerLine.id = 'search-managers';
    search.append(input, managerLine);

    const controls = element('div', 'toolbar-row');
    const tabs = element('div', 'pd-segmented');
    tabs.id = 'package-tabs';
    tabs.setAttribute('role', 'group');
    const chips = element('div', 'chips-row');
    chips.id = 'manager-chips';
    controls.append(tabs, chips);

    const line = element('p', 'muted progress');
    line.id = 'package-status';
    line.setAttribute('role', 'status');
    const listFrame = element('div', 'list-frame');
    const { frame, panel } = scrollPanel('package-list');
    const bar = element('div', 'selection-bar pd-glass');
    bar.id = 'selection-bar';
    bar.hidden = true;
    listFrame.append(frame, bar);
    page.append(head, search, controls, line, listFrame);
    void panel;
    renderList();
  }

  function visiblePackages(): Package[] {
    const all = inventory?.packages ?? [];
    const needle = query.trim().toLowerCase();
    let list = tab === 'discover' ? found : all.filter((entry) => (tab !== 'updates' || hasUpdate(entry)) && (!needle || `${entry.name} ${entry.id}`.toLowerCase().includes(needle)));
    if (managerFilter !== 'all') list = list.filter((entry) => entry.manager === managerFilter);
    if (sortBy === 'source') list = [...list].sort((a, b) => managerName(a.manager).localeCompare(managerName(b.manager)) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return list;
  }

  function renderList(): void {
    const panel = document.getElementById('package-list');
    const tabs = document.getElementById('package-tabs');
    const chips = document.getElementById('manager-chips');
    const line = document.getElementById('package-status');
    const managerLine = document.getElementById('search-managers');
    const bar = document.getElementById('selection-bar');
    if (!panel || !tabs || !chips || !line || !managerLine || !bar) return;
    const all = inventory?.packages ?? [];
    managerLine.textContent = (inventory?.managers ?? []).map(managerName).join(' · ');

    tabs.replaceChildren();
    const updates = all.filter(hasUpdate).length;
    for (const [label, value] of [[fill(t().tabInstalled, { count: all.length }), 'installed'], [fill(t().tabUpdatesN, { count: updates }), 'updates'], [t().tabDiscover, 'discover']] as const) {
      const option = element('button', '', label);
      option.type = 'button';
      option.setAttribute('aria-pressed', String(tab === value));
      option.addEventListener('click', () => { tab = value; selected.clear(); renderList(); });
      tabs.append(option);
    }
    chips.replaceChildren();
    for (const manager of ['all', ...(inventory?.managers ?? [])] as const) {
      const chip = element('button', 'chip-toggle', manager === 'all' ? t().allChip : managerName(manager));
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(managerFilter === manager));
      chip.addEventListener('click', () => { managerFilter = manager; renderList(); });
      chips.append(chip);
    }
    line.textContent = status;

    panel.replaceChildren();
    if (inventory && inventory.managers.length === 0) {
      panel.append(element('div', 'notes', t().noManager));
      bar.hidden = true;
      return;
    }
    for (const problem of inventory?.problems ?? []) panel.append(element('div', 'notes', problem));

    const list = visiblePackages();
    const byKey = new Map(list.map((entry) => [key(entry), entry]));
    for (const name of [...selected]) if (!byKey.has(name)) selected.delete(name);

    if (tab === 'discover') {
      const needle = query.trim();
      const done = searchedFor === needle && !searching;
      const title = needle.length < 2 ? t().discoverHint : !done ? t().searching : found.length ? fill(t().availableTitle, { count: list.length }) : t().noResults;
      panel.append(element('div', 'pd-list-head', title));
      if ((inventory?.managers ?? []).includes('pip') && needle.length >= 2) panel.append(element('div', 'notes', t().pipHint));
    } else {
      const head = element('div', 'pd-list-head row');
      if (list.length) {
        const all = element('input', 'check');
        all.type = 'checkbox';
        all.setAttribute('aria-label', t().selectAll);
        all.checked = list.length > 0 && list.slice(0, 400).every((entry) => selected.has(key(entry)));
        all.addEventListener('change', () => {
          for (const entry of list.slice(0, 400)) (all.checked ? selected.add(key(entry)) : selected.delete(key(entry)));
          renderList();
        });
        head.append(all);
      }
      head.append(element('span', '', tab === 'updates' ? fill(t().tabUpdatesN, { count: list.length }) : fill(t().installedTitle, { count: list.length })), element('span', 'spacer'));
      const sort = element('select', 'pd-select');
      sort.setAttribute('aria-label', `${t().sortName} / ${t().sortSource}`);
      for (const [value, label] of [['name', t().sortName], ['source', t().sortSource]] as const) {
        const option = element('option', '', label);
        option.value = value;
        option.selected = sortBy === value;
        sort.append(option);
      }
      sort.addEventListener('change', () => { sortBy = sort.value as typeof sortBy; renderList(); });
      head.append(sort);
      panel.append(head);
      if (!inventory) panel.append(element('div', 'notes', t().loading));
      else if (list.length === 0) panel.append(element('div', 'notes', t().noPackages));
    }

    // Long lists stay fast: the first 400 rows are drawn, the search narrows the rest.
    for (const entry of list.slice(0, 400)) panel.append(packageRow(entry));
    requestIcons(list.slice(0, 400));

    // Selection bar
    const chosen = [...selected].map((name) => byKey.get(name)).filter((entry): entry is Package => Boolean(entry));
    bar.hidden = chosen.length === 0;
    bar.parentElement?.classList.toggle('has-selection', chosen.length > 0);
    bar.replaceChildren();
    if (chosen.length) {
      bar.append(element('span', '', fill(t().selectionCount, { count: chosen.length })));
      if (tab === 'discover') {
        bar.append(button(t().installSelected, 'main', () => void enqueue('install', chosen)));
      } else {
        const withUpdates = chosen.filter(hasUpdate);
        if (withUpdates.length) bar.append(button(t().updateSelected, 'main', () => void enqueue('update', withUpdates)));
        bar.append(button(t().uninstallSelected, 'line', () => void enqueue('uninstall', chosen)));
        bar.append(button(t().ignoreSelected, 'line', () => void ignore(chosen, true)));
      }
      bar.append(button(t().addToBundle, 'line', () => addToBundle(chosen)));
      bar.append(button(t().clearSelection, 'line', () => { selected.clear(); renderList(); }));
    }
  }

  function packageRow(entry: Package): HTMLElement {
    const installed = tab === 'discover' ? installedEntry(entry) : entry;
    const update = installed ? hasUpdate(installed) : false;
    const version = tab === 'discover' ? entry.version : update ? `${entry.version} → ${entry.available}` : entry.version;
    const { row: node, acts, title } = row(entry.name, `${managerName(entry.manager)} · ${entry.id}`, version, icons.get(key(entry)), tab === 'discover' && !installed);
    node.classList.add('selectable');
    if (selected.has(key(entry))) node.classList.add('selected');
    const check = element('input', 'check');
    check.type = 'checkbox';
    check.checked = selected.has(key(entry));
    check.setAttribute('aria-label', fill(t().selectRow, { name: entry.name }));
    check.addEventListener('change', () => { (check.checked ? selected.add(key(entry)) : selected.delete(key(entry))); renderList(); });
    node.prepend(check);
    // The name opens the details.
    const nameButton = element('button', 'name-link', entry.name);
    nameButton.type = 'button';
    nameButton.addEventListener('click', () => void openDetails(entry));
    title.firstElementChild?.replaceWith(nameButton);

    const running = runningFor(entry);
    if (running) {
      acts.append(element('span', 'pd-pill pd-pill-wait', running.state === 'running' ? t().qRunning : ctx.busy() ? t().qWaitsRun : t().qQueued));
      return node;
    }
    if (installed && isHeld(installed)) acts.append(element('span', 'pd-pill pd-pill-wait pd-pill-small', t().ignored));
    else if (installed?.available && skippedVersion(installed) === installed.available) acts.append(element('span', 'pd-pill pd-pill-plain pd-pill-small', fill(t().skippedNote, { version: installed.available })));
    if (tab === 'discover') {
      if (installed) acts.append(element('span', 'pd-pill pd-pill-ok pd-pill-small', t().installed));
      else acts.append(button(t().installOne, 'main', () => void enqueue('install', [entry])));
    } else if (update) {
      acts.append(button(t().updateOne, 'main', () => void enqueue('update', [entry])));
    }
    acts.append(button(t().detailsOne, 'line', () => void openDetails(installed ?? entry)));
    return node;
  }

  async function ignore(packages: Package[], on: boolean): Promise<void> {
    const names = new Set(settings().holds);
    for (const entry of packages) (on ? names.add(entry.id) : (names.delete(entry.id), names.delete(entry.name)));
    ctx.setSettings(await ctx.saveSettings({ holds: [...names] }));
    selected.clear();
    renderList();
  }

  // ---------- Sheet ----------

  const sheet = () => document.getElementById('sheet') as HTMLDialogElement;

  function openSheet(head: HTMLElement, body: HTMLElement, foot: HTMLElement): void {
    const dialog = sheet();
    dialog.replaceChildren(head, body, foot);
    if (!dialog.open) dialog.showModal();
  }

  function sheetHead(title: string, subtitle: string, image?: string, name = title): HTMLElement {
    const head = element('div', 'sheet-head');
    const text = element('div');
    const h2 = element('h2', '', title);
    h2.id = 'sheet-title';
    text.append(h2, element('small', '', subtitle));
    head.append(iconNode(name, image, false, 'icon-big'), text);
    return head;
  }

  function closeButton(): HTMLButtonElement {
    return button(t().dClose, 'line', () => sheet().close(), false);
  }

  // ---------- Details and options ----------

  async function openDetails(entry: Package): Promise<void> {
    const installed = installedEntry(entry);
    const subtitle = [managerName(entry.manager), entry.id, installed ? fill(t().dVersion, { version: installed.version }) : '', installed?.available ? fill(t().dAvailable, { version: installed.available }) : ''].filter(Boolean).join(' · ');
    const body = element('div', 'sheet-body');
    body.append(element('p', 'muted', t().dLoading));
    const foot = element('div', 'sheet-foot');
    const fillFoot = () => {
      foot.replaceChildren();
      const target = installed ?? entry;
      if (!installed) foot.append(button(t().installOne, 'main', () => { sheet().close(); void enqueue('install', [entry]); }, false));
      else {
        if (hasUpdate(installed)) foot.append(button(t().updateOne, 'main', () => { sheet().close(); void enqueue('update', [installed]); }, false));
        foot.append(button(isHeld(installed) ? t().dAllow : t().dIgnore, 'line', async () => { await ignore([installed], !isHeld(installed)); fillFoot(); }, false));
        if (installed.available && skippedVersion(installed) !== installed.available) {
          foot.append(button(fill(t().dSkip, { version: installed.available }), 'line', async () => {
            ctx.setSettings(await ctx.api.skip(key(installed), installed.available as string));
            renderList();
            fillFoot();
          }, false));
        }
        foot.append(button(t().uninstallOne, 'line', () => { sheet().close(); void enqueue('uninstall', [installed]); }, false));
      }
      foot.append(button(t().addToBundle, 'line', () => addToBundle([target]), false));
      foot.append(element('span', 'spacer'), closeButton());
    };
    fillFoot();
    openSheet(sheetHead(entry.name, subtitle, icons.get(key(entry))), body, foot);

    const info = await ctx.api.details(entry).catch(() => ({ screenshots: [] } as Details & { screenshots: string[] }));
    if (!sheet().open) return;
    body.replaceChildren();
    const facts = element('dl', 'facts');
    const fact = (label: string, value?: string, url?: string) => {
      if (!value && !url) return;
      facts.append(element('dt', '', label));
      const dd = element('dd');
      if (url) {
        const link = element('button', 'pd-link', value || url);
        link.type = 'button';
        link.addEventListener('click', () => void ctx.api.openUrl(url));
        dd.append(link);
      } else {
        dd.textContent = value ?? '';
      }
      facts.append(dd);
    };
    fact(t().dDescription, info.description);
    fact(t().dPublisher, info.publisher);
    fact(t().dAuthor, info.author);
    fact(t().dHomepage, info.homepage, info.homepage);
    fact(t().dLicense, info.license, info.licenseUrl);
    if (!info.license && info.licenseUrl) fact(t().dLicense, info.licenseUrl, info.licenseUrl);
    fact(t().dReleaseNotes, info.releaseNotes?.slice(0, 1500), info.releaseNotesUrl && !info.releaseNotes ? info.releaseNotesUrl : undefined);
    fact(t().dInstaller, info.installerUrl, info.installerUrl);
    fact(t().dUpdated, info.updated);
    fact(t().dTags, info.tags?.join(', '));
    body.append(facts.childElementCount ? facts : element('p', 'muted', t().dNone));
    if (info.screenshots?.length) {
      body.append(element('h3', '', t().dScreenshots));
      const shots = element('div', 'shots');
      for (const url of info.screenshots) {
        const link = element('button', 'pd-link', `${t().dOpen} ${shots.childElementCount + 1}`);
        link.type = 'button';
        link.addEventListener('click', () => void ctx.api.openUrl(url));
        shots.append(link);
      }
      body.append(shots);
    }
    body.append(optionsForm(entry, info.versions ?? []));
  }

  function optionsForm(entry: Pick<Package, 'manager' | 'id'>, versions: string[], onSave?: (options: InstallOptions) => void, initial?: InstallOptions): HTMLElement {
    const current: InstallOptions = { ...(initial ?? optionsOf(entry)) };
    const s = settings();
    const can = (feature: keyof typeof CAN) => CAN[feature].includes(entry.manager);
    const windows = ctx.platform() === 'win32';
    const box = element('section');
    box.append(element('h3', '', t().oTitle), element('p', 'muted', t().oLead));
    const grid = element('div', 'form-grid');
    const field = (label: string, control: HTMLElement, wide = false, note = '') => {
      const wrap = element('label', `pd-field${wide ? ' wide' : ''}`);
      wrap.append(element('span', '', label), control);
      if (note) wrap.append(element('small', 'field-note', note));
      grid.append(wrap);
    };
    const select = (value: string, options: [string, string][], onChange: (value: string) => void) => {
      const node = element('select');
      for (const [optionValue, label] of options) {
        const option = element('option', '', label);
        option.value = optionValue;
        option.selected = optionValue === value;
        node.append(option);
      }
      node.addEventListener('change', () => onChange(node.value));
      return node;
    };
    const text = (value: string, onChange: (value: string) => void, disabled = false) => {
      const node = element('input');
      node.type = 'text';
      node.value = value;
      node.disabled = disabled;
      node.spellcheck = false;
      node.addEventListener('input', () => onChange(node.value));
      return node;
    };
    const set = <K extends keyof InstallOptions>(name: K, value: InstallOptions[K]) => {
      if (value === '' || value === undefined || value === false || (Array.isArray(value) && value.length === 0)) delete current[name];
      else current[name] = value;
    };
    if (can('version')) field(t().oVersion, select(current.Version ?? '', [['', t().oLatest], ...versions.slice(0, 60).map((version) => [version, version] as [string, string])], (value) => set('Version', value)));
    if (can('scope')) field(t().oScope, select((current.InstallationScope ?? '').toLowerCase(), [['', t().oDefault], ['user', t().oUser], ['machine', t().oMachine]], (value) => set('InstallationScope', value)));
    if (can('arch')) field(t().oArch, select((current.Architecture ?? '').toLowerCase(), [['', t().oDefault], ['x64', 'x64'], ['x86', 'x86'], ['arm64', 'arm64']], (value) => set('Architecture', value)));
    if (can('location')) field(t().oLocation, text(current.CustomInstallLocation ?? '', (value) => set('CustomInstallLocation', value.trim())), true);
    const argsOff = !s.allowParameters;
    const list = (value: string) => value.split(/\s+/).filter(Boolean);
    field(t().oArgsInstall, text((current.CustomParameters_Install ?? []).join(' '), (value) => set('CustomParameters_Install', list(value)), argsOff), false, argsOff ? t().oArgsOff : '');
    field(t().oArgsUpdate, text((current.CustomParameters_Update ?? []).join(' '), (value) => set('CustomParameters_Update', list(value)), argsOff));
    field(t().oArgsUninstall, text((current.CustomParameters_Uninstall ?? []).join(' '), (value) => set('CustomParameters_Uninstall', list(value)), argsOff));
    const cmdOff = !s.allowCommands;
    for (const [name, label] of [['PreInstallCommand', t().oPreInstall], ['PostInstallCommand', t().oPostInstall], ['PreUpdateCommand', t().oPreUpdate], ['PostUpdateCommand', t().oPostUpdate], ['PreUninstallCommand', t().oPreUninstall], ['PostUninstallCommand', t().oPostUninstall]] as const) {
      const input = text(current[name] ?? '', (value) => set(name, value.trim()), cmdOff);
      input.classList.add('code');
      field(label, input, false, cmdOff && name === 'PreInstallCommand' ? t().oCmdOff : '');
    }
    field(t().oKill, text((current.KillBeforeOperation ?? []).join(', '), (value) => set('KillBeforeOperation', value.split(',').map((item) => item.trim()).filter(Boolean))), true);
    const toggles: Array<[keyof InstallOptions, string, boolean, string?]> = [
      ['AutoUpdatePackage', t().oAuto, true],
      ['SkipMajorUpdates', t().oSkipMajor, true],
      ['SkipMinorUpdates', t().oSkipMinor, true],
      ['PreRelease', t().oPre, can('prerelease')],
      ['InteractiveInstallation', t().oInteractive, can('interactive')],
      ['RunAsAdministrator', t().oAdmin, windows],
      ['SkipHashCheck', t().oSkipHash, can('skipHash'), s.allowSkipHash ? '' : t().oSkipHashOff],
      ['RemoveDataOnUninstall', t().oRemoveData, can('removeData')],
      ['UninstallBeforeUpdate', t().oUninstallFirst, true],
    ];
    if (s.allowCommands) toggles.push(['AbortOnPreInstallFail', t().oAbortPre, true]);
    for (const [name, label, shown, note] of toggles) {
      if (!shown) continue;
      const fallback = name === 'AbortOnPreInstallFail';
      const on = (current[name] as boolean | undefined) ?? fallback;
      const wrap = element('div', 'toggle-row');
      const text = element('span', '', label);
      if (note) text.append(element('small', 'field-note', ` ${note}`));
      wrap.append(text, switchButton(on, label, (next) => {
        if (fallback) {
          for (const abort of ['AbortOnPreInstallFail', 'AbortOnPreUpdateFail', 'AbortOnPreUninstallFail'] as const) (next ? delete current[abort] : (current[abort] = false));
        } else set(name, next as never);
      }));
      grid.append(wrap);
    }
    box.append(grid);
    const actions = element('div', 'row');
    const saved = element('span', 'muted');
    saved.setAttribute('role', 'status');
    actions.append(
      button(t().oSave, 'main', async () => {
        const options = cleanOptions(current);
        if (onSave) onSave(options);
        else ctx.setSettings(await ctx.api.setOptions(key(entry), options));
        saved.textContent = t().oSaved;
        renderList();
      }),
      button(t().oReset, 'line', async () => {
        if (onSave) onSave({});
        else ctx.setSettings(await ctx.api.setOptions(key(entry), {}));
        box.replaceWith(optionsForm(entry, versions, onSave, {}));
      }),
      saved,
    );
    box.append(actions);
    return box;
  }

  // ---------- Bundles ----------

  function addToBundle(packages: Package[]): void {
    if (!bundle) bundle = { name: t().bUnsaved, packages: [], incompatible: [], dirty: false };
    let added = 0;
    for (const entry of packages) {
      if (bundle.packages.some((have) => key(have) === key(entry))) continue;
      bundle.packages.push({ manager: entry.manager, id: entry.id, name: entry.name, version: entry.version, ...(entry.kind ? { kind: entry.kind } : {}), options: optionsOf(entry), ...(isHeld(entry) ? { ignored: '*' } : skippedVersion(entry) ? { ignored: skippedVersion(entry) } : {}) });
      added++;
    }
    bundle.dirty = bundle.dirty || added > 0;
    status = fill(t().bAdded, { count: added });
    bundleStatus = status;
    selected.clear();
    renderList();
    renderBundles();
    renderCounts();
  }

  async function replaceBundle(): Promise<boolean> {
    return !bundle?.dirty || ctx.ask(t().bDiscardTitle, t().bDiscardText, t().bReplace);
  }

  function showReport(opened: OpenedBundle): Promise<boolean> {
    return new Promise((resolve) => {
      const body = element('div', 'sheet-body');
      body.append(element('p', '', t().srLead));
      const label = { high: t().srHigh, warning: t().srWarning, info: t().srInfo } as const;
      const tone = { high: 'back', warning: 'wait', info: 'plain' } as const;
      for (const finding of opened.findings) {
        const line = element('div', 'finding');
        line.append(element('span', `pd-pill pd-pill-${tone[finding.severity]} pd-pill-small`, label[finding.severity]));
        const what = element('div');
        what.append(element('strong', '', `${finding.package} · ${finding.field}`), element('br'), element('code', '', finding.value));
        line.append(what, element('span', 'muted', finding.removed ? t().srRemoved : t().srKept));
        body.append(line);
      }
      const foot = element('div', 'sheet-foot');
      const finish = (answer: boolean) => { sheet().onclose = null; sheet().close(); resolve(answer); };
      foot.append(button(t().srImport, 'main', () => finish(true), false), button(t().srDiscard, 'line', () => finish(false), false));
      openSheet(sheetHead(t().srTitle, opened.name, undefined, '!'), body, foot);
      sheet().onclose = () => resolve(false);
    });
  }

  async function takeBundle(opened: OpenedBundle | null): Promise<void> {
    if (!opened) return;
    if (opened.findings.length && !(await showReport(opened))) return;
    bundle = { name: opened.name, packages: opened.bundle.packages, incompatible: opened.bundle.incompatible, dirty: false };
    bundleSelected.clear();
    bundleStatus = '';
    renderBundles();
    renderCounts();
    ctx.showPage('bundles');
  }

  function renderBundles(): void {
    const page = document.getElementById('page-bundles');
    if (!page) return;
    page.replaceChildren();
    const openButton = button(t().bOpen, 'line', async () => {
      if (!(await replaceBundle())) return;
      try {
        await takeBundle(await ctx.api.bundleOpen());
      } catch (error) {
        bundleStatus = `${t().actionFailed} ${clean(error)}`;
        renderBundles();
      }
    }, false);
    const fromInstalled = button(t().bFromInstalled, 'line', async () => {
      try {
        const mine = await ctx.api.bundleInstalled();
        if (!bundle) bundle = { name: t().bUnsaved, packages: [], incompatible: [], dirty: false };
        const before = bundle.packages.length;
        for (const entry of mine.packages) if (!bundle.packages.some((have) => key(have) === key(entry))) bundle.packages.push(entry);
        bundle.dirty = true;
        bundleStatus = fill(t().bAdded, { count: bundle.packages.length - before });
      } catch (error) {
        bundleStatus = `${t().actionFailed} ${clean(error)}`;
      }
      renderBundles();
      renderCounts();
    }, false);
    const saveButton = button(t().bSave, 'line', async () => {
      if (!bundle) return;
      try {
        const name = await ctx.api.bundleSave(bundle.packages, bundle.incompatible);
        if (name) {
          bundle.name = name;
          bundle.dirty = false;
          bundleStatus = fill(t().bSaved, { name });
        }
      } catch (error) {
        bundleStatus = `${t().actionFailed} ${clean(error)}`;
      }
      renderBundles();
    }, false);
    saveButton.disabled = !bundle?.packages.length;
    const tools = [openButton, fromInstalled, saveButton];
    const head = pageHead('bundles-title', t().navBundles, t().bundlesLead, tools);
    const line = element('p', 'muted progress', bundleStatus);
    line.setAttribute('role', 'status');
    const listFrame = element('div', 'list-frame');
    const { frame, panel } = scrollPanel();
    listFrame.append(frame);
    page.append(head, line, listFrame);

    if (!bundle) {
      const empty = element('div', 'empty');
      empty.append(element('h2', '', t().bEmptyTitle), element('p', '', t().bEmptyText));
      panel.append(empty);
      return;
    }
    const current = bundle;
    const listHead = element('div', 'pd-list-head row');
    const all = element('input', 'check');
    all.type = 'checkbox';
    all.setAttribute('aria-label', t().selectAll);
    all.checked = current.packages.length > 0 && current.packages.every((entry) => bundleSelected.has(key(entry)));
    all.addEventListener('change', () => {
      for (const entry of current.packages) (all.checked ? bundleSelected.add(key(entry)) : bundleSelected.delete(key(entry)));
      renderBundles();
    });
    listHead.append(all, element('span', '', fill(t().bTitle, { name: current.name + (current.dirty ? ' •' : ''), count: current.packages.length })));
    listHead.append(element('span', 'spacer'));
    const toInstall = (list: BundlePackage[]) => list.filter((entry) => !installedEntry(entry));
    const chosen = current.packages.filter((entry) => bundleSelected.has(key(entry)));
    const install = async (list: BundlePackage[]) => {
      if (!list.length) return;
      const names = list.slice(0, 8).map((entry) => entry.name).join(', ') + (list.length > 8 ? ', …' : '');
      if (!(await ctx.ask(t().confirmInstallTitle, fill(t().confirmInstallText, { names }), t().installOne))) return;
      try {
        const result = await ctx.api.bundleInstall(list);
        ctx.setSettings(result.settings);
        bundleStatus = fill(t().queuedNote, { count: result.ids.length });
      } catch (error) {
        bundleStatus = `${t().actionFailed} ${clean(error)}`;
      }
      renderBundles();
    };
    if (chosen.length) {
      listHead.append(button(t().bInstallSelected, 'main', () => void install(toInstall(chosen))));
      listHead.append(button(t().bRemove, 'line', () => {
        current.packages = current.packages.filter((entry) => !bundleSelected.has(key(entry)));
        current.dirty = true;
        bundleSelected.clear();
        renderBundles();
        renderCounts();
      }));
    } else if (toInstall(current.packages).length) {
      listHead.append(button(t().bInstallAll, 'main', () => void install(toInstall(current.packages))));
    }
    listHead.append(button(t().bClear, 'line', async () => {
      if (!(await replaceBundle())) return;
      bundle = null;
      bundleSelected.clear();
      renderBundles();
      renderCounts();
    }));
    panel.append(listHead);

    for (const entry of current.packages) {
      const have = installedEntry(entry);
      const { row: node, acts, title } = row(entry.name, `${managerName(entry.manager)} · ${entry.id}`, entry.version, icons.get(key(entry)), !have);
      node.classList.add('selectable');
      const check = element('input', 'check');
      check.type = 'checkbox';
      check.checked = bundleSelected.has(key(entry));
      check.setAttribute('aria-label', fill(t().selectRow, { name: entry.name }));
      check.addEventListener('change', () => { (check.checked ? bundleSelected.add(key(entry)) : bundleSelected.delete(key(entry))); renderBundles(); });
      node.prepend(check);
      const pills = element('div', 'pills-inline');
      pills.append(element('span', `pd-pill pd-pill-small pd-pill-${have ? (have.available ? 'wait' : 'ok') : 'plain'}`, have ? (have.available ? t().bStateUpdate : t().bStateInstalled) : t().bStateNew));
      if (Object.keys(entry.options).length) pills.append(element('span', 'pd-pill pd-pill-plain pd-pill-small', t().bHasOptions));
      if (entry.ignored) pills.append(element('span', 'pd-pill pd-pill-plain pd-pill-small', entry.ignored === '*' ? t().bIgnoredAll : fill(t().bIgnoredVer, { version: entry.ignored })));
      title.append(pills);
      if (!have) acts.append(button(t().installOne, 'main', () => void install([entry])));
      acts.append(button(t().oTitle, 'line', () => {
        const body = element('div', 'sheet-body');
        body.append(optionsForm(entry, entry.version ? [entry.version] : [], (options) => {
          entry.options = options;
          current.dirty = true;
          renderBundles();
        }, entry.options));
        const foot = element('div', 'sheet-foot');
        foot.append(element('span', 'spacer'), closeButton());
        openSheet(sheetHead(entry.name, `${managerName(entry.manager)} · ${entry.id}`, icons.get(key(entry))), body, foot);
      }));
      panel.append(node);
    }
    requestIcons(current.packages);
    if (current.incompatible.length) {
      panel.append(element('div', 'pd-list-head', fill(t().bIncompatible, { count: current.incompatible.length })));
      const why = { 'manager-unknown': t().bWhyManager, 'other-system': t().bWhySystem, 'invalid-id': t().bWhyId } as const;
      for (const entry of current.incompatible) {
        const { row: node } = row(entry.name || entry.id, [entry.manager ?? entry.source, entry.id, why[entry.reason]].filter(Boolean).join(' · '), entry.version, undefined, true);
        panel.append(node);
      }
    }
  }

  // ---------- Queue ----------

  function renderQueue(): void {
    const page = document.getElementById('page-queue');
    if (!page) return;
    const scroll = page.querySelector('.panel-scroll')?.scrollTop ?? 0;
    page.replaceChildren();
    const clear = button(t().qClear, 'line', () => void ctx.api.queueClear(), false);
    clear.disabled = !operations.some((operation) => operation.finishedAt);
    const head = pageHead('queue-title', t().navQueue, t().queueLead, [clear]);
    const { frame, panel } = scrollPanel();
    page.append(head, frame);
    // The update run (containers and scheduled packages) shows here too, so all progress is in one place.
    const run = element('div', 'run-live');
    run.id = 'run-live';
    const running = ctx.renderRun(run);
    if (running) panel.append(run);
    if (!operations.length && !running) panel.append(element('div', 'notes', t().qEmpty));
    const stateLabel = { queued: t().qQueued, running: t().qRunning, done: t().qDone, failed: t().qFailed, cancelled: t().qCancelled } as const;
    const tone = { queued: 'plain', running: 'wait', done: 'ok', failed: 'back', cancelled: 'plain' } as const;
    const actionLabel = { install: t().qInstall, update: t().qUpdate, uninstall: t().qUninstall } as const;
    const phaseLabel: Record<string, string> = { before: t().phaseBefore, after: t().phaseAfter, update: t().phaseUpdate, retry: t().phaseRetry, reinstall: t().phaseReinstall };
    for (const operation of [...operations].reverse()) {
      const entry = operation.package;
      const node = element('div', 'op');
      const title = element('div', 'name');
      title.append(element('span', '', `${actionLabel[operation.action]}: ${entry.name}`), element('small', '', [managerName(entry.manager), entry.id, operation.phase ? phaseLabel[operation.phase] ?? operation.phase : '', operation.finishedAt ? when(operation.finishedAt) : ''].filter(Boolean).join(' · ')));
      const acts = element('div', 'acts');
      const waitsForRun = operation.state === 'queued' && ctx.busy();
      acts.append(element('span', `pd-pill pd-pill-small pd-pill-${tone[operation.state]}`, waitsForRun ? t().qWaitsRun : stateLabel[operation.state]));
      if (operation.state === 'queued' || operation.state === 'running') acts.append(button(t().qCancel, 'line', () => void ctx.api.queueCancel(operation.id)));
      if (operation.state === 'failed' || operation.state === 'cancelled') acts.append(button(t().qRetry, 'line', () => void ctx.api.queueRetry(operation.id)));
      if (operation.log.length) {
        const toggle = button(t().qOutput, 'line', () => { (openLogs.has(operation.id) ? openLogs.delete(operation.id) : openLogs.add(operation.id)); renderQueue(); });
        toggle.setAttribute('aria-expanded', String(openLogs.has(operation.id)));
        acts.append(toggle);
      }
      node.append(iconNode(entry.name, icons.get(key(entry))), title, acts);
      if (operation.state === 'running') node.append(Object.assign(element('div', 'pd-progress pd-progress-busy op-reason'), { innerHTML: '<span></span>' }));
      if (operation.reason && operation.state !== 'done') node.append(element('div', 'op-reason', reason(language(), operation.reason)));
      if (openLogs.has(operation.id)) node.append(element('pre', 'op-log', operation.log.join('\n')));
      panel.append(node);
    }
    panel.scrollTop = scroll;
  }

  // ---------- Settings: managers, security, background, backup ----------

  async function save(patch: Partial<Settings>): Promise<void> {
    try {
      ctx.setSettings(await ctx.saveSettings(patch));
      hubMessage = '';
    } catch (error) {
      hubMessage = `${t().actionFailed} ${clean(error)}`;
    }
    renderSettingsHub();
    renderList();
  }

  function card(title: string, lead = ''): HTMLElement {
    const node = element('section', 'pd-surface settings-card');
    node.append(element('h2', '', title));
    if (lead) node.append(element('p', 'lead', lead));
    return node;
  }

  function setting(label: string, hint: string, control: HTMLElement): HTMLElement {
    const node = element('div', 'set');
    node.append(element('span', '', label), control);
    if (hint) node.append(element('small', '', hint));
    return node;
  }

  async function openSources(manager: ManagerStatus): Promise<void> {
    const body = element('div', 'sheet-body');
    const foot = element('div', 'sheet-foot');
    foot.append(element('span', 'spacer'), closeButton());
    const message = element('p', 'muted');
    message.setAttribute('role', 'status');
    const listBox = element('div');
    const draw = (sources: Source[]) => {
      listBox.replaceChildren();
      for (const source of sources) {
        const line = element('div', 'source-row');
        const name = element('strong', '', source.name);
        line.append(name, element('small', '', source.url + (source.builtIn ? ` · ${t().smBuiltIn}` : '')));
        line.append(button(t().smRemoveSource, 'line', async () => {
          if (source.builtIn && !(await ctx.ask(fill(t().smRemoveBuiltIn, { name: source.name }), t().smRemoveBuiltInText, t().smRemoveSource))) return;
          try {
            draw(await ctx.api.sourceChange(manager.manager, 'remove', source.name, ''));
          } catch (error) {
            message.textContent = `${t().actionFailed} ${clean(error)}`;
          }
        }));
        listBox.append(line);
      }
    };
    const form = element('form', 'form-grid');
    const nameField = element('label', 'pd-field');
    const nameInput = element('input');
    nameInput.required = true;
    nameField.append(element('span', '', t().smSourceName), nameInput);
    const urlField = element('label', 'pd-field');
    const urlInput = element('input');
    urlInput.type = 'url';
    urlInput.placeholder = 'https://';
    urlField.append(element('span', '', t().smSourceUrl), urlInput);
    const submit = element('button', 'pd-btn pd-btn-main pd-btn-small', t().smAddSource);
    submit.type = 'submit';
    form.append(nameField, urlField, submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      message.textContent = t().loading;
      try {
        draw(await ctx.api.sourceChange(manager.manager, 'add', nameInput.value, urlInput.value));
        nameInput.value = '';
        urlInput.value = '';
        message.textContent = '';
      } catch (error) {
        message.textContent = `${t().actionFailed} ${clean(error)}`;
      }
    });
    body.append(listBox, element('h3', '', t().smAddSource), form, message);
    openSheet(sheetHead(fill(t().smSourcesTitle, { name: manager.name }), manager.executable, undefined, manager.name), body, foot);
    listBox.append(element('p', 'muted', t().loading));
    try {
      draw(await ctx.api.sources(manager.manager));
    } catch (error) {
      listBox.replaceChildren(element('p', 'muted', `${t().actionFailed} ${clean(error)}`));
    }
  }

  function renderSettingsHub(): void {
    const left = document.getElementById('settings-hub-left');
    const right = document.getElementById('settings-hub-right');
    if (!left || !right) return;
    const s = settings();
    left.replaceChildren();
    right.replaceChildren();
    const root = left;
    if (hubMessage) {
      const note = card(t().actionFailed);
      note.append(element('p', 'lead', hubMessage));
      root.append(note);
    }

    // Package managers
    const managerCard = card(t().smTitle, t().smLead);
    if (!managers) managerCard.append(element('p', 'lead', t().smLoading));
    for (const manager of managers ?? []) {
      const line = element('div', 'manager-row');
      const label = element('div');
      label.append(element('strong', '', manager.name), element('small', '', manager.found ? fill(t().smFound, { version: manager.version }) : t().smMissing));
      const controls = element('div', 'controls');
      if (['brew', 'winget', 'choco', 'scoop', 'pwsh', 'winps'].includes(manager.manager) && manager.found) controls.append(button(t().smSources, 'line', () => void openSources(manager)));
      controls.append(switchButton(!s.disabledManagers.includes(manager.manager), fill(t().smUse, { name: manager.name }), (on) => {
        const off = new Set(s.disabledManagers);
        (on ? off.delete(manager.manager) : off.add(manager.manager));
        void save({ disabledManagers: [...off] }).then(() => { inventory = null; void loadPackages(); });
      }));
      line.append(label, controls);
      const path = element('form', 'path');
      const input = element('input');
      input.value = s.managerPaths?.[manager.manager] ?? '';
      input.placeholder = manager.executable;
      input.spellcheck = false;
      input.setAttribute('aria-label', fill(t().smPath, { name: manager.name }));
      const submit = element('button', 'pd-btn pd-btn-line pd-btn-small', t().smSave);
      submit.type = 'submit';
      path.append(input, submit);
      path.addEventListener('submit', (event) => {
        event.preventDefault();
        const paths = { ...(s.managerPaths ?? {}) };
        if (input.value.trim()) paths[manager.manager] = input.value.trim();
        else delete paths[manager.manager];
        void save({ managerPaths: paths }).then(() => { managers = null; void loadManagers(); });
      });
      line.append(path);
      managerCard.append(line);
    }
    root.append(managerCard);

    // Security
    const security = card(t().secTitle, t().secLead);
    security.append(
      setting(t().secParams, t().secParamsHint, switchButton(s.allowParameters, t().secParams, (on) => void save({ allowParameters: on }))),
      setting(t().secCommands, t().secCommandsHint, switchButton(s.allowCommands, t().secCommands, (on) => void save({ allowCommands: on }))),
      setting(t().secSkipHash, t().secSkipHashHint, switchButton(s.allowSkipHash, t().secSkipHash, (on) => void save({ allowSkipHash: on }))),
      setting(t().secImportParams, t().secImportHint, switchButton(s.importParameters, t().secImportParams, (on) => void save({ importParameters: on }), !s.allowParameters)),
      setting(t().secImportCommands, '', switchButton(s.importCommands, t().secImportCommands, (on) => void save({ importCommands: on }), !s.allowCommands)),
    );
    root.append(security);

    // Background
    const background = card(t().bgTitle);
    const hours = element('select', 'pd-select');
    hours.setAttribute('aria-label', t().bgCheck);
    for (const value of [0, 1, 3, 6, 12, 24]) {
      const option = element('option', '', value ? fill(t().bgHours, { count: value }) : t().bgOff);
      option.value = String(value);
      option.selected = s.checkEveryHours === value;
      hours.append(option);
    }
    hours.addEventListener('change', () => void save({ checkEveryHours: Number(hours.value) }));
    const parallel = element('div', 'pd-segmented pd-segmented-small');
    parallel.setAttribute('role', 'group');
    parallel.setAttribute('aria-label', t().bgParallel);
    for (const value of [1, 2, 3, 4]) {
      const option = element('button', '', String(value));
      option.type = 'button';
      option.setAttribute('aria-pressed', String(s.parallelOps === value));
      option.addEventListener('click', () => void save({ parallelOps: value }));
      parallel.append(option);
    }
    background.append(
      setting(t().bgTray, t().bgTrayHint, switchButton(s.closeToTray, t().bgTray, (on) => void save({ closeToTray: on }))),
      setting(t().bgLogin, '', switchButton(s.startAtLogin, t().bgLogin, (on) => void save({ startAtLogin: on }))),
      setting(t().bgCheck, '', hours),
      setting(t().bgNotify, '', switchButton(s.notifyUpdates, t().bgNotify, (on) => void save({ notifyUpdates: on }))),
      setting(t().bgAuto, t().bgAutoHint, switchButton(s.autoUpdatePackages, t().bgAuto, (on) => void save({ autoUpdatePackages: on }))),
      setting(t().bgParallel, t().bgParallelHint, parallel),
      setting(t().bgIcons, t().bgIconsHint, switchButton(s.showIcons, t().bgIcons, (on) => void save({ showIcons: on }))),
    );
    right.append(background);

    // Backup
    const backup = card(t().buTitle);
    const backupLine = element('small', '', s.lastBackup ? fill(t().buLast, { when: when(s.lastBackup) }) : t().buNever);
    backupLine.setAttribute('role', 'status');
    const folderRow = element('div', 'row');
    folderRow.append(
      element('small', '', s.backupFolder || '~/Documents/Patchday backups'),
      button(t().buChoose, 'line', async () => { const folder = await ctx.api.backupFolder(); if (folder) void save({ backupFolder: folder }); }),
      button(t().buOpen, 'line', () => void ctx.api.backupOpenFolder()),
    );
    const keep = element('select', 'pd-select');
    keep.setAttribute('aria-label', t().buKeep);
    for (const value of [3, 5, 10, 20, 50]) {
      const option = element('option', '', String(value));
      option.value = String(value);
      option.selected = s.backupKeep === value;
      keep.append(option);
    }
    keep.addEventListener('change', () => void save({ backupKeep: Number(keep.value) }));
    const now = element('div', 'row');
    now.append(button(t().buNow, 'main', async () => {
      backupLine.textContent = t().loading;
      try {
        const path = await ctx.api.backupNow();
        backupLine.textContent = fill(t().buDone, { path });
      } catch (error) {
        backupLine.textContent = `${t().actionFailed} ${clean(error)}`;
      }
    }), backupLine);
    const folderSet = element('div', 'set set-wide');
    folderSet.append(element('span', '', t().buFolder), folderRow);
    const nowSet = element('div', 'set set-wide');
    nowSet.append(now);
    backup.append(
      setting(t().buEnable, t().buEnableHint, switchButton(s.backupEnabled, t().buEnable, (on) => void save({ backupEnabled: on }))),
      folderSet,
      setting(t().buKeep, '', keep),
      nowSet,
    );
    // GitHub Gist
    const gist = element('div', 'set set-wide settings-body');
    gist.append(element('span', '', t().gistTitle), element('small', '', t().gistHint));
    const gistState = element('small', '', hasGistToken ? t().gistSaved : t().gistNone);
    gistState.setAttribute('role', 'status');
    if (!hasGistToken) {
      const form = element('form', 'chip-add');
      const input = element('input');
      input.type = 'password';
      input.autocomplete = 'off';
      input.setAttribute('aria-label', t().gistToken);
      input.placeholder = t().gistToken;
      const submit = element('button', 'pd-btn pd-btn-line pd-btn-small', t().gistSave);
      submit.type = 'submit';
      form.append(input, submit);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          await ctx.api.gistToken(input.value);
          hasGistToken = true;
          renderSettingsHub();
        } catch (error) {
          gistState.textContent = `${t().actionFailed} ${clean(error)}`;
        }
      });
      gist.append(form, gistState);
    } else {
      const toggle = element('div', 'toggle-row');
      toggle.append(element('span', '', t().gistOn), switchButton(s.gistBackup, t().gistOn, (on) => void save({ gistBackup: on })));
      const actions = element('div', 'row');
      actions.append(
        button(t().gistRestore, 'line', async () => {
          try {
            if (await replaceBundle()) await takeBundle(await ctx.api.gistRestore());
          } catch (error) {
            gistState.textContent = `${t().actionFailed} ${clean(error)}`;
          }
        }),
        button(t().gistForget, 'line', async () => { await ctx.api.gistForget(); hasGistToken = false; ctx.setSettings({ ...settings(), gistBackup: false }); renderSettingsHub(); }),
      );
      gist.append(gistState, toggle, actions);
    }
    backup.append(gist);
    right.append(backup);

    // Skipped versions
    const skipped = card(t().igTitle);
    const entries = Object.entries(s.skipped);
    if (!entries.length) skipped.append(element('p', 'lead', t().igNone));
    for (const [name, version] of entries) {
      const line = element('div', 'set');
      const [manager, ...rest] = name.split(':');
      line.append(element('span', '', fill(t().igSkipped, { name: `${managerName(manager)} · ${rest.join(':')}`, version })));
      line.append(button(fill(t().igReset, { version }), 'line', () => {
        const next = { ...s.skipped };
        delete next[name];
        void save({ skipped: next });
      }));
      skipped.append(line);
    }
    right.append(skipped);
  }

  async function loadManagers(): Promise<void> {
    try {
      managers = await ctx.api.managers();
    } catch {
      managers = [];
    }
    renderSettingsHub();
  }

  // ---------- History ----------

  const ACTION_LABEL: Record<HistoryEntry['action'], keyof Strings> = { install: 'hInstall', uninstall: 'hUninstall', update: 'hUpdate', run: 'hRun', 'self-update': 'hSelf' };

  function renderHistory(): void {
    const page = document.getElementById('page-history');
    if (!page) return;
    page.replaceChildren();
    const exportButton = button(t().exportLogs, 'main', async () => {
      try {
        if (await ctx.api.exportLogs()) historyStatus = t().logsExported;
      } catch (error) {
        historyStatus = `${t().actionFailed} ${clean(error)}`;
      }
      renderHistory();
    }, false);
    const runLogsButton = button(t().openRunLogs, 'line', async () => {
      try {
        await ctx.api.openRunLogs();
      } catch (error) {
        historyStatus = `${t().actionFailed} ${clean(error)}`;
        renderHistory();
      }
    }, false);
    const head = pageHead('history-title', t().navHistory, t().historyLead, [runLogsButton, exportButton]);
    const line = element('p', 'muted progress', historyStatus);
    line.setAttribute('role', 'status');
    const { frame, panel } = scrollPanel();
    if (history.length === 0) panel.append(element('div', 'notes', t().historyEmpty));
    for (const entry of history) {
      const meta = [t()[ACTION_LABEL[entry.action]] as string, entry.manager ? managerName(entry.manager) : ''].filter(Boolean).join(' · ');
      const { row: node, acts } = row(entry.name, meta, when(entry.at));
      acts.append(element('span', `pd-pill pd-pill-${entry.ok ? 'ok' : 'back'}`, entry.ok ? t().hOk : t().hFailed));
      if (entry.detail) {
        const more = element('details', 'pd-detail');
        more.append(element('summary', '', t().details), element('pre', '', entry.detail));
        node.append(more);
      }
      panel.append(node);
    }
    page.append(head, line, frame);
  }

  void ctx.api.queue().then((next) => { operations = next; renderQueue(); renderCounts(); }).catch(() => {});
  void ctx.api.gistState().then((state) => { hasGistToken = state.hasToken; renderSettingsHub(); }).catch(() => {});

  return {
    render(): void {
      renderPackages();
      renderBundles();
      renderQueue();
      renderHistory();
      renderSettingsHub();
      renderCounts();
    },
    open(page: string): void {
      if ((page === 'packages' || page === 'bundles') && !inventory && !loading) void loadPackages();
      if (page === 'history') void loadHistory();
      if (page === 'settings' && !managers) void loadManagers();
    },
    takeBundle,
    // Called when the update run starts, moves or ends.
    refreshRun(): void {
      renderQueue();
      renderCounts();
      renderList();
    },
  };
}
