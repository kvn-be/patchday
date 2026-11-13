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
  setSettings(settings: Settings): void;
  busy(): boolean;
  setBusy(label: string): void;
  ask(title: string, text: string, yes: string): Promise<boolean>;
}

const MANAGER_NAMES: Record<Manager, string> = { brew: 'Homebrew', winget: 'winget', choco: 'Chocolatey', scoop: 'Scoop' };
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
  const node = element('button', `btn btn-${tone}${small ? ' btn-small' : ''}`, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

// Every list row has the same anatomy: icon, name with source, version, then actions.
function row(name: string, meta: string, version: string, fresh = false): { row: HTMLElement; acts: HTMLElement } {
  const node = element('div', 'item');
  const icon = element('span', `icon${fresh ? ' new' : ''}`, (name.trim()[0] ?? '?').toUpperCase());
  icon.setAttribute('aria-hidden', 'true');
  const title = element('div', 'name');
  title.append(element('span', '', name), element('small', '', meta));
  const ver = element('span', 'ver', version);
  ver.title = version;
  const acts = element('div', 'acts');
  node.append(icon, title, ver, acts);
  return { row: node, acts };
}

export function createViews(ctx: ViewContext) {
  let inventory: Awaited<ReturnType<PackageApi['packages']>> | null = null;
  let loading = false;
  let query = '';
  let onlyUpdates = false;
  let found: Package[] = [];
  let searching = false;
  let searchedFor = '';
  let imported: Package[] = [];
  let importSkipped = 0;
  let history: HistoryEntry[] = [];
  let status = '';
  let timer: ReturnType<typeof setTimeout> | undefined;

  const t = ctx.t;
  const language = () => ctx.settings().language as Language;
  const holds = () => new Set(ctx.settings().holds);
  const skippedVersion = (entry: Package) => ctx.settings().skipped[key(entry)];
  const hasUpdate = (entry: Package) => Boolean(entry.available) && skippedVersion(entry) !== entry.available && !holds().has(entry.id) && !holds().has(entry.name);
  const isInstalled = (entry: Package) => {
    const short = (id: string) => id.split('/').pop();
    return (inventory?.packages ?? []).some((have) => have.manager === entry.manager && (have.id === entry.id || short(have.id) === short(entry.id)));
  };
  const clean = (error: unknown) => reason(language(), (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));

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
    }
  }

  async function loadHistory(): Promise<void> {
    history = await ctx.api.history().catch(() => []);
    renderHistory();
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
      found = result.packages.filter((entry) => !isInstalled(entry)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
      searchedFor = text;
      if (result.problems.length) status = result.problems.join(' ');
    } catch (error) {
      found = [];
      searchedFor = text;
      status = clean(error);
    } finally {
      searching = false;
      renderList();
    }
  }

  async function perform(action: PackageAction, packages: Package[]): Promise<void> {
    if (packages.length === 0) return;
    if (ctx.busy()) {
      status = t().busyNote;
      renderList();
      return;
    }
    const names = packages.slice(0, 8).map((entry) => entry.name).join(', ') + (packages.length > 8 ? ', …' : '');
    if (action === 'uninstall' && !(await ctx.ask(t().confirmUninstallTitle, fill(t().confirmUninstallText, { names }), t().uninstallOne))) return;
    if (action === 'install' && !(await ctx.ask(t().confirmInstallTitle, fill(t().confirmInstallText, { names }), t().installOne))) return;
    status = fill(t().working, { done: 0, total: packages.length });
    ctx.setBusy(status);
    renderList();
    try {
      const outcome = await ctx.api.packageAction(action, packages);
      const ok = outcome.filter((result) => result.ok).length;
      status = fill(t().actionDone, { ok, failed: outcome.length - ok });
      const done = new Set(outcome.filter((result) => result.ok).map((result) => result.key));
      found = found.filter((entry) => !done.has(key(entry)));
      imported = imported.filter((entry) => !done.has(key(entry)));
    } catch (error) {
      status = `${t().actionFailed} ${clean(error)}`;
    } finally {
      ctx.setBusy('');
    }
    await Promise.all([loadPackages(), loadHistory()]);
  }

  ctx.api.onPackageProgress((result) => {
    status = fill(t().working, { done: result.index + 1, total: result.total });
    ctx.setBusy(status);
    renderList();
  });

  // ---------- Packages ----------

  function renderPackages(): void {
    const page = document.getElementById('page-packages');
    if (!page) return;
    page.replaceChildren();

    const head = element('header', 'page-head');
    const titles = element('div');
    const h1 = element('h1', '', t().navPackages);
    h1.id = 'packages-title';
    titles.append(h1, element('p', '', t().packagesLead));
    const importButton = button(t().importList, 'line', async () => {
      try {
        const list = await ctx.api.importPackages();
        if (!list) return;
        if (!inventory) await loadPackages();
        imported = list.packages.filter((entry) => !isInstalled(entry));
        importSkipped = list.skipped;
      } catch (error) {
        status = `${t().actionFailed} ${clean(error)}`;
      }
      renderList();
    }, false);
    const exportButton = button(t().exportList, 'line', async () => {
      try {
        const count = await ctx.api.exportPackages(inventory?.packages ?? []);
        if (count !== null) status = fill(t().exported, { count });
      } catch (error) {
        status = `${t().actionFailed} ${clean(error)}`;
      }
      renderList();
    }, false);
    exportButton.id = 'export-button';
    head.append(titles, importButton, exportButton);

    const search = element('label', 'search glass');
    search.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>';
    const input = element('input');
    input.type = 'search';
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
        timer = setTimeout(() => void runSearch(), SEARCH_DELAY_MS);
      }
      renderList();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      clearTimeout(timer);
      void runSearch();
    });
    const managers = element('small');
    managers.id = 'search-managers';
    search.append(input, managers);

    const filter = element('div', 'segmented');
    filter.id = 'package-filter';
    filter.setAttribute('role', 'group');

    const line = element('p', 'muted progress');
    line.id = 'package-status';
    line.setAttribute('role', 'status');
    const panel = element('div', 'panel glass');
    panel.id = 'package-list';
    page.append(head, search, filter, line, panel);
    renderList();
  }

  function renderList(): void {
    const panel = document.getElementById('package-list');
    const filter = document.getElementById('package-filter');
    const line = document.getElementById('package-status');
    const managers = document.getElementById('search-managers');
    if (!panel || !filter || !line || !managers) return;
    const all = inventory?.packages ?? [];
    managers.textContent = (inventory?.managers ?? []).map((manager) => MANAGER_NAMES[manager]).join(' · ');
    document.getElementById('export-button')?.toggleAttribute('disabled', all.length === 0);

    filter.replaceChildren();
    const updates = all.filter(hasUpdate).length;
    for (const [label, value] of [[fill(t().allCount, { count: all.length }), false], [fill(t().withUpdates, { count: updates }), true]] as [string, boolean][]) {
      const option = element('button', '', label);
      option.type = 'button';
      option.setAttribute('aria-pressed', String(onlyUpdates === value));
      option.addEventListener('click', () => { onlyUpdates = value; renderList(); });
      filter.append(option);
    }
    line.textContent = status;

    panel.replaceChildren();
    if (inventory && inventory.managers.length === 0) {
      panel.append(element('div', 'notes', t().noManager));
      return;
    }
    for (const problem of inventory?.problems ?? []) panel.append(element('div', 'notes', problem));

    if (imported.length > 0 || importSkipped > 0) {
      const head = element('div', 'list-head row');
      head.append(element('span', '', fill(t().fromList, { count: imported.length })));
      if (imported.length > 1) head.append(button(t().installAll, 'main', () => void perform('install', imported)));
      panel.append(head);
      if (importSkipped) panel.append(element('div', 'notes', fill(t().importNote, { count: importSkipped })));
      for (const entry of imported) {
        const { row: node, acts } = row(entry.name, `${MANAGER_NAMES[entry.manager]} · ${entry.id}`, '', true);
        acts.append(button(t().installOne, 'main', () => void perform('install', [entry])));
        panel.append(node);
      }
    }

    const needle = query.trim().toLowerCase();
    const mine = all.filter((entry) => (!onlyUpdates || hasUpdate(entry)) && (!needle || `${entry.name} ${entry.id}`.toLowerCase().includes(needle)));
    panel.append(element('div', 'list-head', fill(t().installedTitle, { count: mine.length })));
    if (!inventory) panel.append(element('div', 'notes', t().loading));
    else if (mine.length === 0) panel.append(element('div', 'notes', t().noPackages));
    // Long lists stay fast: the first 400 rows are drawn, the search narrows the rest.
    for (const entry of mine.slice(0, 400)) {
      const update = hasUpdate(entry);
      const { row: node, acts } = row(entry.name, `${MANAGER_NAMES[entry.manager]} · ${entry.id}`, update ? `${entry.version} → ${entry.available}` : entry.version);
      if (holds().has(entry.id) || holds().has(entry.name)) acts.append(element('span', 'pill pill-wait', t().ignored));
      else if (entry.available && skippedVersion(entry) === entry.available) acts.append(element('span', 'pill pill-plain', fill(t().skippedNote, { version: entry.available })));
      if (update) {
        acts.append(button(t().updateOne, 'main', () => void perform('update', [entry])));
        acts.append(button(t().skipShort, 'line', async () => {
          ctx.setSettings(await ctx.api.skip(key(entry), entry.available as string));
          renderList();
        }));
      }
      acts.append(button(t().uninstallOne, 'line', () => void perform('uninstall', [entry])));
      panel.append(node);
    }

    if (needle.length >= 2) {
      const done = searchedFor === query.trim() && !searching;
      const title = !done ? t().searching : found.length ? fill(t().availableTitle, { count: found.length }) : t().noResults;
      panel.append(element('div', 'list-head', title));
      if (done) {
        for (const entry of found) {
          const { row: node, acts } = row(entry.name, `${MANAGER_NAMES[entry.manager]} · ${entry.id}`, entry.version, true);
          acts.append(button(t().installOne, 'main', () => void perform('install', [entry])));
          panel.append(node);
        }
      }
    }
  }

  // ---------- History ----------

  const ACTION_LABEL: Record<HistoryEntry['action'], keyof Strings> = { install: 'hInstall', uninstall: 'hUninstall', update: 'hUpdate', run: 'hRun', 'self-update': 'hSelf' };

  function renderHistory(): void {
    const page = document.getElementById('page-history');
    if (!page) return;
    page.replaceChildren();
    const head = element('header', 'page-head');
    const titles = element('div');
    const h1 = element('h1', '', t().navHistory);
    h1.id = 'history-title';
    titles.append(h1, element('p', '', t().historyLead));
    head.append(titles);
    const panel = element('div', 'panel glass');
    if (history.length === 0) panel.append(element('div', 'notes', t().historyEmpty));
    for (const entry of history) {
      const when = new Date(entry.at).toLocaleString(t().locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
      const managerName = entry.manager && entry.manager in MANAGER_NAMES ? MANAGER_NAMES[entry.manager as Manager] : '';
      const meta = [t()[ACTION_LABEL[entry.action]] as string, managerName].filter(Boolean).join(' · ');
      const { row: node, acts } = row(entry.name, meta, when);
      acts.append(element('span', `pill pill-${entry.ok ? 'ok' : 'back'}`, entry.ok ? t().hOk : t().hFailed));
      if (entry.detail) {
        const more = element('details', 'pd-detail');
        more.append(element('summary', '', t().details), element('pre', '', entry.detail));
        node.append(more);
      }
      panel.append(node);
    }
    page.append(head, panel);
  }

  return {
    render(): void {
      renderPackages();
      renderHistory();
    },
    open(page: string): void {
      if (page === 'packages' && !inventory && !loading) void loadPackages();
      if (page === 'history') void loadHistory();
    },
  };
}
