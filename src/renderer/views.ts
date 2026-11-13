import type { HistoryEntry } from '../core/history.ts';
import type { Manager, Package, PackageAction } from '../core/packages.ts';
import type { Settings } from '../engine/types.ts';
import { reason, STRINGS, type Language } from './i18n.ts';

type Strings = { readonly [K in keyof (typeof STRINGS)['en']]: (typeof STRINGS)['en'][K] extends string ? string : readonly string[] };

export interface PackageApi {
  packages(): Promise<{ packages: Package[]; managers: Manager[]; problems: string[] }>;
  search(query: string, managers: Manager[]): Promise<{ packages: Package[]; problems: string[] }>;
  packageAction(action: PackageAction, packages: Package[]): Promise<Array<{ key: string; ok: boolean; reason: string }>>;
  onPackageProgress(listener: (result: { index: number; total: number }) => void): void;
  skip(key: string, version: string): Promise<Settings>;
  history(): Promise<HistoryEntry[]>;
  exportPackages(packages: Package[]): Promise<number | null>;
  importPackages(): Promise<{ packages: Package[]; skipped: number } | null>;
}

export interface ViewContext {
  api: PackageApi;
  t(): Strings;
  settings(): Settings;
  patch(values: Partial<Settings>): Promise<void>;
  setSettings(settings: Settings): void;
  busy(): boolean;
  setBusy(label: string): void;
  ask(title: string, text: string, yes: string): Promise<boolean>;
  showTab(tab: 'updates' | 'packages' | 'discover' | 'history'): void;
}

const MANAGER_NAMES: Record<Manager, string> = { brew: 'Homebrew', winget: 'winget', choco: 'Chocolatey', scoop: 'Scoop' };
const key = (entry: Pick<Package, 'manager' | 'id'>) => `${entry.manager}:${entry.id}`;
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

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

function checkbox(checked: boolean, label: string, onChange: (checked: boolean) => void): HTMLInputElement {
  const box = element('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.setAttribute('aria-label', label);
  box.addEventListener('change', () => onChange(box.checked));
  return box;
}

export function createViews(ctx: ViewContext) {
  let inventory: Awaited<ReturnType<PackageApi['packages']>> | null = null;
  let loading = false;
  let filter = '';
  let managerFilter: Manager | '' = '';
  let onlyUpdates = false;
  const picked = new Set<string>();
  let results: Package[] = [];
  let resultMode: 'search' | 'import' = 'search';
  let importSkipped = 0;
  const found = new Set<string>();
  let query = '';
  let searched = false;
  let history: HistoryEntry[] = [];
  let packageStatus = '';
  let discoverStatus = '';
  let progress: { done: number; total: number } | null = null;

  const t = ctx.t;
  const language = () => ctx.settings().language as Language;
  const holds = () => new Set(ctx.settings().holds);
  const skippedVersion = (entry: Package) => ctx.settings().skipped[key(entry)];
  const hasUpdate = (entry: Package) => Boolean(entry.available) && skippedVersion(entry) !== entry.available && !holds().has(entry.id);
  const installedKeys = () => new Set((inventory?.packages ?? []).map(key));

  async function loadPackages(): Promise<void> {
    if (loading) return;
    loading = true;
    packageStatus = t().loading;
    render();
    try {
      inventory = await ctx.api.packages();
      packageStatus = '';
      for (const entry of [...picked]) if (!inventory.packages.some((item) => key(item) === entry)) picked.delete(entry);
    } catch (error) {
      packageStatus = `${t().actionFailed} ${clean(error)}`;
    } finally {
      loading = false;
      render();
    }
  }

  async function loadHistory(): Promise<void> {
    history = await ctx.api.history().catch(() => []);
    renderHistory();
  }

  function clean(error: unknown): string {
    return reason(language(), (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  }

  async function perform(action: PackageAction, packages: Package[], where: 'packages' | 'discover'): Promise<void> {
    if (packages.length === 0) return;
    if (ctx.busy()) {
      setStatus(where, t().busyNote);
      return;
    }
    const names = packages.slice(0, 8).map((entry) => entry.name).join(', ') + (packages.length > 8 ? ', …' : '');
    if (action === 'uninstall' && !(await ctx.ask(t().confirmUninstallTitle, fill(t().confirmUninstallText, { names }), t().uninstallOne))) return;
    if (action === 'install' && !(await ctx.ask(t().confirmInstallTitle, fill(t().confirmInstallText, { names }), t().installOne))) return;
    progress = { done: 0, total: packages.length };
    ctx.setBusy(fill(t().working, progress));
    setStatus(where, fill(t().working, progress));
    try {
      const outcome = await ctx.api.packageAction(action, packages);
      const ok = outcome.filter((result) => result.ok).length;
      setStatus(where, fill(t().actionDone, { ok, failed: outcome.length - ok }));
      for (const result of outcome) if (result.ok) (where === 'packages' ? picked : found).delete(result.key);
    } catch (error) {
      setStatus(where, `${t().actionFailed} ${clean(error)}`);
    } finally {
      progress = null;
      ctx.setBusy('');
    }
    await Promise.all([loadPackages(), loadHistory()]);
  }

  function setStatus(where: 'packages' | 'discover', text: string): void {
    if (where === 'packages') packageStatus = text;
    else discoverStatus = text;
    render();
  }

  ctx.api.onPackageProgress((result) => {
    progress = { done: result.index + 1, total: result.total };
    const text = fill(t().working, progress);
    ctx.setBusy(text);
    if (packageStatus.length && progress) packageStatus = text;
    if (discoverStatus.length && progress) discoverStatus = text;
    render();
  });

  // ---------- Packages ----------

  function visiblePackages(): Package[] {
    const needle = filter.trim().toLowerCase();
    return (inventory?.packages ?? []).filter((entry) =>
      (!managerFilter || entry.manager === managerFilter)
      && (!onlyUpdates || hasUpdate(entry))
      && (!needle || `${entry.name} ${entry.id}`.toLowerCase().includes(needle)));
  }

  function packageRow(entry: Package): HTMLElement {
    const row = element('div', 'pkg-row');
    const id = key(entry);
    row.append(checkbox(picked.has(id), entry.name, (checked) => {
      if (checked) picked.add(id);
      else picked.delete(id);
      renderPackages();
    }));
    const title = element('div', 'pkg-name');
    title.append(element('span', '', entry.name), element('small', '', `${MANAGER_NAMES[entry.manager]} · ${entry.id}`));
    row.append(title);

    const held = holds().has(entry.id);
    const skipped = skippedVersion(entry);
    const version = element('span', 'pd-ver', hasUpdate(entry) ? `${entry.version} → ${entry.available}` : entry.version);
    version.title = version.textContent ?? '';
    row.append(version);

    const actions = element('div', 'pkg-actions');
    if (held) actions.append(element('span', 'pd-badge pd-badge-wait', t().ignored));
    else if (entry.available && skipped === entry.available) actions.append(element('span', 'pd-badge pd-badge-plain', fill(t().skippedNote, { version: entry.available })));
    if (hasUpdate(entry)) actions.append(button(t().updateOne, 'main', () => void perform('update', [entry], 'packages')));
    const more = element('details', 'pkg-more');
    const summary = element('summary', 'pd-btn pd-btn-line pd-btn-small', '⋯');
    summary.setAttribute('aria-label', fill(t().moreActions, { name: entry.name }));
    const menu = element('div', 'pkg-menu');
    if (hasUpdate(entry) && entry.available) {
      menu.append(button(fill(t().skipVersion, { version: entry.available }), 'line', async () => {
        ctx.setSettings(await ctx.api.skip(id, entry.available as string));
        render();
      }));
    }
    menu.append(button(held ? t().unignore : t().ignore, 'line', async () => {
      const next = held ? ctx.settings().holds.filter((name) => name !== entry.id) : [...ctx.settings().holds, entry.id];
      await ctx.patch({ holds: next });
      render();
    }));
    menu.append(button(t().uninstallOne, 'line', () => void perform('uninstall', [entry], 'packages')));
    more.append(summary, menu);
    actions.append(more);
    row.append(actions);
    return row;
  }

  function renderPackages(): void {
    const box = document.getElementById('view-packages');
    if (!box) return;
    box.replaceChildren();

    const tools = element('div', 'pkg-tools');
    const search = element('input', 'pkg-filter');
    search.type = 'search';
    search.placeholder = t().filter;
    search.setAttribute('aria-label', t().filter);
    search.value = filter;
    search.addEventListener('input', () => {
      filter = search.value;
      renderPackageList();
    });
    const select = element('select', 'pkg-select');
    select.setAttribute('aria-label', t().allManagers);
    select.append(new Option(t().allManagers, ''));
    for (const manager of inventory?.managers ?? []) select.append(new Option(MANAGER_NAMES[manager], manager));
    select.value = managerFilter;
    select.addEventListener('change', () => {
      managerFilter = select.value as Manager | '';
      renderPackageList();
    });
    const only = element('label', 'toggle');
    only.append(checkbox(onlyUpdates, t().onlyUpdates, (checked) => {
      onlyUpdates = checked;
      renderPackageList();
    }), element('span', '', t().onlyUpdates));
    tools.append(search, select, only);

    const buttons = element('div', 'actions');
    const refresh = button(t().refresh, 'line', () => void loadPackages());
    refresh.disabled = loading;
    const exportButton = button(t().exportList, 'line', async () => {
      const chosen = picked.size ? (inventory?.packages ?? []).filter((entry) => picked.has(key(entry))) : visiblePackages();
      try {
        const count = await ctx.api.exportPackages(chosen);
        if (count !== null) setStatus('packages', fill(t().exported, { count }));
      } catch (error) {
        setStatus('packages', `${t().actionFailed} ${clean(error)}`);
      }
    });
    exportButton.disabled = !inventory || inventory.packages.length === 0;
    const importButton = button(t().importList, 'line', async () => {
      try {
        const list = await ctx.api.importPackages();
        if (!list) return;
        results = list.packages;
        importSkipped = list.skipped;
        resultMode = 'import';
        found.clear();
        const have = installedKeys();
        for (const entry of results) if (!have.has(key(entry))) found.add(key(entry));
        if (!inventory) void loadPackages();
        ctx.showTab('discover');
        render();
      } catch (error) {
        setStatus('packages', `${t().actionFailed} ${clean(error)}`);
      }
    });
    buttons.append(refresh, exportButton, importButton);
    if (picked.size > 0) {
      const chosen = (inventory?.packages ?? []).filter((entry) => picked.has(key(entry)));
      const bulk = element('div', 'pkg-bulk');
      const update = button(t().updateSelected, 'main', () => void perform('update', chosen.filter(hasUpdate), 'packages'));
      update.disabled = ctx.busy() || !chosen.some(hasUpdate);
      const remove = button(t().uninstallSelected, 'line', () => void perform('uninstall', chosen, 'packages'));
      remove.disabled = ctx.busy();
      bulk.append(element('span', 'hint', fill(t().selected, { count: picked.size })), update, remove);
      buttons.append(bulk);
    }

    const status = element('p', 'hint pkg-status');
    status.setAttribute('role', 'status');
    status.id = 'pkg-status';
    const list = element('div', 'pd-window pkg-list');
    list.id = 'pkg-list';
    box.append(tools, buttons, status, list);
    renderPackageList();
  }

  function renderPackageList(): void {
    const list = document.getElementById('pkg-list');
    const status = document.getElementById('pkg-status');
    if (!list || !status) return;
    list.replaceChildren();
    const all = inventory?.packages ?? [];
    const counts = inventory ? `${fill(t().packageCount, { count: all.length })} · ${fill(t().updateCount, { count: all.filter(hasUpdate).length })}` : '';
    status.textContent = packageStatus || counts;
    if (inventory && inventory.managers.length === 0) {
      list.append(element('div', 'notes', t().noManager));
      return;
    }
    for (const problem of inventory?.problems ?? []) list.append(element('div', 'notes', problem));
    const visible = visiblePackages();
    if (inventory && visible.length === 0) list.append(element('div', 'notes', t().noPackages));
    // Long lists stay fast: the first 400 rows are drawn, the filter narrows the rest.
    for (const entry of visible.slice(0, 400)) list.append(packageRow(entry));
  }

  // ---------- Find ----------

  async function runSearch(): Promise<void> {
    if (!query.trim()) return;
    resultMode = 'search';
    discoverStatus = t().searching;
    render();
    try {
      if (!inventory) await loadPackages();
      const result = await ctx.api.search(query, inventory?.managers ?? []);
      results = result.packages;
      found.clear();
      searched = true;
      discoverStatus = result.problems.join(' ');
    } catch (error) {
      discoverStatus = `${t().actionFailed} ${clean(error)}`;
    }
    render();
  }

  function renderDiscover(): void {
    const box = document.getElementById('view-discover');
    if (!box) return;
    box.replaceChildren();
    const form = element('form', 'pkg-tools');
    const input = element('input', 'pkg-filter');
    input.type = 'search';
    input.placeholder = t().searchLabel;
    input.setAttribute('aria-label', t().searchLabel);
    input.value = query;
    input.addEventListener('input', () => { query = input.value; });
    const go = element('button', 'pd-btn pd-btn-main pd-btn-small', t().searchButton);
    go.type = 'submit';
    form.append(input, go);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void runSearch();
    });

    const status = element('p', 'hint pkg-status', discoverStatus || (resultMode === 'import' ? '' : t().searchHint));
    status.setAttribute('role', 'status');
    const list = element('div', 'pd-window pkg-list');
    const have = installedKeys();
    if (resultMode === 'import') {
      const bar = element('div', 'pd-window-bar');
      bar.append(element('b', '', t().importTitle), element('span', 'pd-badge pd-badge-plain', String(results.length)));
      list.append(bar);
      if (importSkipped) list.append(element('div', 'notes', fill(t().importNote, { count: importSkipped })));
    }
    if (searched && resultMode === 'search' && results.length === 0) list.append(element('div', 'notes', t().noResults));
    for (const entry of results) {
      const row = element('div', 'pkg-row');
      const id = key(entry);
      const isInstalled = have.has(id) || (entry.manager === 'scoop' && have.has(`scoop:${entry.id.split('/').pop()}`));
      const box = checkbox(found.has(id), entry.name, (checked) => {
        if (checked) found.add(id);
        else found.delete(id);
        render();
      });
      box.disabled = isInstalled;
      const title = element('div', 'pkg-name');
      title.append(element('span', '', entry.name), element('small', '', `${MANAGER_NAMES[entry.manager]} · ${entry.id}`));
      const actions = element('div', 'pkg-actions');
      if (isInstalled) actions.append(element('span', 'pd-badge pd-badge-ok', t().installed));
      else actions.append(button(t().installOne, 'line', () => void perform('install', [entry], 'discover')));
      row.append(box, title, element('span', 'pd-ver', entry.version), actions);
      list.append(row);
    }
    const buttons = element('div', 'actions');
    if (found.size > 0) {
      const chosen = results.filter((entry) => found.has(key(entry)));
      const install = button(t().installSelected, 'main', () => void perform('install', chosen, 'discover'));
      install.disabled = ctx.busy();
      buttons.append(element('span', 'hint', fill(t().selected, { count: found.size })), install);
    }
    box.append(form, buttons, status, list);
  }

  // ---------- History ----------

  const ACTION_LABEL: Record<HistoryEntry['action'], keyof Strings> = { install: 'hInstall', uninstall: 'hUninstall', update: 'hUpdate', run: 'hRun', 'self-update': 'hSelf' };

  function renderHistory(): void {
    const box = document.getElementById('view-history');
    if (!box) return;
    box.replaceChildren();
    const list = element('div', 'pd-window pkg-list');
    if (history.length === 0) list.append(element('div', 'notes', t().historyEmpty));
    for (const entry of history) {
      const row = element('div', 'pkg-row pkg-history');
      const when = new Date(entry.at).toLocaleString(t().locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
      const title = element('div', 'pkg-name');
      const managerName = entry.manager && entry.manager in MANAGER_NAMES ? MANAGER_NAMES[entry.manager as Manager] : '';
      title.append(element('span', '', entry.name), element('small', '', [t()[ACTION_LABEL[entry.action]] as string, managerName].filter(Boolean).join(' · ')));
      row.append(element('span', 'pd-ver', when), title, element('span', `pd-badge pd-badge-${entry.ok ? 'ok' : 'back'}`, entry.ok ? t().hOk : t().hFailed));
      if (entry.detail) {
        const more = element('details', 'pd-detail');
        more.append(element('summary', '', t().details), element('pre', '', entry.detail));
        row.append(more);
      }
      list.append(row);
    }
    box.append(list, element('p', 'hint', t().historyLimit));
  }

  function render(): void {
    renderPackages();
    renderDiscover();
    renderHistory();
  }

  return {
    render,
    open(tab: string): void {
      if (tab === 'packages' && !inventory && !loading) void loadPackages();
      if (tab === 'discover' && !inventory && !loading) void loadPackages();
      if (tab === 'history') void loadHistory();
      render();
    },
  };
}
