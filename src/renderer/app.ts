import { nextRun } from '../core/schedule.ts';
import type { ProgressItem, Report, ReportItem, Settings } from '../engine/types.ts';
import { reason, STRINGS, type Language } from './i18n.ts';
import { createViews, type PackageApi } from './views.ts';

interface Api extends PackageApi {
  onSelfReady(listener: (version: string) => void): void;
  state(): Promise<{ settings: Settings; reports: Report[]; version: string; platform: string; hasToken: boolean; adminReady: boolean; packaged: boolean }>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  check(): Promise<Report>;
  update(): Promise<Report>;
  saveToken(token: string): Promise<void>;
  coffee(): Promise<void>;
  setupAdmin(): Promise<boolean>;
  checkSelf(): Promise<string | null>;
  manualCheckSelf(): Promise<string | null>;
  installSelf(): Promise<void>;
  onSelfProgress(listener: (percent: number) => void): void;
  onSelfAvailable(listener: (version: string) => void): void;
  onProgress(listener: (items: ProgressItem[]) => void): void;
  onLog(listener: (message: string) => void): void;
}
declare global {
  interface Window {
    patchday: Api;
    Patchday: { mountWeekDial(svg: SVGSVGElement, input: HTMLInputElement, options: { hour: number; days: readonly string[]; short: readonly string[]; onChange(hour: number): void }): unknown };
  }
}

const api = window.patchday;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const element = (tag: string, className: string, text = '') => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};

let settings: Settings;
let hasToken = false;
let report: Report | null = null;
let busy = false;
let live: ProgressItem[] | null = null;
let adminReady = false;
let adminMessage = '';
let selfVersion: string | null = null;
let selfMessage = '';
let selfReady = false;
type Tab = 'updates' | 'packages' | 'discover' | 'history';
let tab: Tab = 'updates';
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const t = () => STRINGS[settings.language as Language];

const BADGE: Record<ReportItem['outcome'], [string, keyof typeof STRINGS.en]> = {
  planned: ['plain', 'bPlanned'],
  applied: ['ok', 'bApplied'],
  waiting: ['wait', 'bWaiting'],
  'rolled-back': ['back', 'bBack'],
  failed: ['back', 'bFailed'],
};
const ORDER: ReportItem['outcome'][] = ['failed', 'rolled-back', 'waiting', 'planned', 'applied'];

function bar(tone: 'ok' | 'fail' | 'active' | 'busy', percent: number | null, label: string): HTMLElement {
  const track = element('div', `pd-progress pd-progress-${tone}`);
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', label);
  if (percent !== null) track.setAttribute('aria-valuenow', String(percent));
  const fill = element('span', '');
  if (percent !== null) fill.style.width = `${percent}%`;
  track.append(fill);
  return track;
}

const PHASES = { backup: 'phaseBackup', update: 'phaseUpdate', test: 'phaseTest', rollback: 'phaseRollback', retry: 'phaseRetry' } as const;

function renderLive(box: HTMLElement, items: ProgressItem[]): void {
  const language = settings.language as Language;
  const finished = items.filter((item) => item.state === 'done' || item.state === 'failed').length;
  const head = element('div', 'pd-window-bar');
  head.append(element('b', '', t().updating), element('span', 'pd-badge pd-badge-plain', `${finished} / ${items.length}`));
  const total = element('div', 'overall');
  const share = items.length ? Math.round((finished / items.length) * 100) : 0;
  total.append(bar('active', share, t().overall), element('span', 'pd-reason', `${finished} / ${items.length} ${t().overall}`));
  box.append(head, total);
  for (const item of items) {
    const row = element('div', 'pd-report-row');
    const tone = item.state === 'failed' ? 'fail' : item.state === 'done' ? 'ok' : item.percent === null ? 'busy' : 'active';
    const label = item.state === 'done' ? t().bApplied : item.state === 'failed' ? t().bFailed : item.phase ? t()[PHASES[item.phase]] : t().queued;
    const badge = item.state === 'done' ? 'ok' : item.state === 'failed' ? 'back' : 'plain';
    row.append(element('span', '', item.name), element('span', 'pd-ver', `${item.from} → ${item.to}`), element('span', `pd-badge pd-badge-${badge}`, label), bar(tone, item.percent, item.name));
    if (item.reason) row.append(element('span', 'pd-reason', reason(language, item.reason)));
    box.append(row);
  }
}

function renderReport(): void {
  const box = $('report');
  box.replaceChildren();
  if (live) {
    renderLive(box, live);
    return;
  }
  if (!report) {
    const empty = element('div', 'empty');
    empty.append(element('h2', '', t().emptyTitle), element('p', '', t().emptyText));
    box.append(empty);
    return;
  }
  const started = new Date(report.startedAt);
  const titleBar = element('div', 'pd-window-bar');
  titleBar.append(
    element('b', '', started.toLocaleString(t().locale, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false })),
    element('span', 'pd-badge pd-badge-plain', report.mode === 'preview' ? t().preview : t().run),
  );
  const count = (...outcomes: ReportItem['outcome'][]) => report!.items.filter((item) => outcomes.includes(item.outcome)).length;
  const tally = element('div', 'pd-tally');
  const first: [number, string] = report.mode === 'preview' ? [count('planned'), t().planned] : [count('applied'), t().applied];
  for (const [value, label] of [first, [count('waiting'), t().waiting], [count('failed', 'rolled-back'), t().problems]] as [number, string][]) {
    const cell = element('div', '');
    cell.append(element('b', '', String(value)), element('span', '', label));
    tally.append(cell);
  }
  box.append(titleBar, tally);
  if (report.items.length === 0) box.append(element('div', 'notes', t().upToDate));
  const language = settings.language as Language;
  const sorted = [...report.items].sort((a, b) => ORDER.indexOf(a.outcome) - ORDER.indexOf(b.outcome));
  for (const item of sorted) {
    const [tone, label] = BADGE[item.outcome];
    const row = element('div', 'pd-report-row');
    row.append(
      element('span', '', item.name),
      element('span', 'pd-ver', `${item.from} → ${item.to}`),
      element('span', `pd-badge pd-badge-${tone}`, t()[label] as string),
    );
    if (report.mode === 'apply' && item.outcome !== 'waiting') row.append(bar(item.outcome === 'applied' ? 'ok' : 'fail', 100, item.name));
    row.append(element('span', 'pd-reason', reason(language, item.reason)));
    if (item.detail) {
      const more = element('details', 'pd-detail');
      more.append(element('summary', '', t().details), element('pre', '', item.detail));
      row.append(more);
    }
    box.append(row);
  }
  for (const note of report.notes) box.append(element('div', 'notes', note));
}

function renderHint(): void {
  const hour = settings.hourOfWeek;
  $('hint').textContent = hour % 24 < 6 ? t().noteNight : t().noteDay;
  const day = (Math.floor(hour / 24) + 1) % 7;
  const next = nextRun({ enabled: settings.scheduleEnabled, days: [day], hour: hour % 24, minute: 0 }, new Date());
  $('next').textContent = next
    ? `${t().next} ${next.toLocaleDateString(t().locale, { weekday: 'long', day: 'numeric', month: 'long' })} ${t().at} ${String(hour % 24).padStart(2, '0')}:00`
    : t().off;
}

function mountDial(): void {
  const slot = $('dial-slot');
  slot.replaceChildren();
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'pd-dial');
  svg.setAttribute('viewBox', '0 0 600 600');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-hidden', 'true');
  const label = element('label', 'dial-label', t().pick);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = '0';
  input.max = '167';
  input.value = String(settings.hourOfWeek);
  label.append(input);
  slot.append(svg, label);
  window.Patchday.mountWeekDial(svg, input, {
    hour: settings.hourOfWeek,
    days: t().days,
    short: t().short,
    onChange(hour) {
      settings.hourOfWeek = hour;
      renderHint();
      // The system scheduler is only rewritten once the hand rests.
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void api.saveSettings({ hourOfWeek: hour }), 500);
    },
  });
}

function renderText(): void {
  document.documentElement.lang = settings.language;
  document.documentElement.dataset.theme = settings.theme;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((node) => {
    node.textContent = t()[node.dataset.i18n as keyof typeof STRINGS.en] as string;
  });
  document.querySelectorAll<HTMLElement>('[data-lang]').forEach((node) => {
    node.setAttribute('aria-pressed', String(node.dataset.lang === settings.language));
  });
  $('theme').setAttribute('aria-label', settings.theme === 'light' ? t().toDark : t().toLight);
  $('coffee').setAttribute('aria-label', t().coffee);
  $('token-state').textContent = hasToken ? t().tokenSaved : t().tokenNone;
  $('admin-state').textContent = adminMessage || (adminReady ? t().adminOn : t().adminOff);
  $('admin-setup').hidden = adminReady;
  $('self-update').hidden = !selfVersion && !selfMessage;
  $('self-text').textContent = selfMessage || (t()[selfReady ? 'selfReady' : 'selfAvailable'] as string).replace('{version}', selfVersion ?? '');
  $('self-restart').hidden = !selfReady || Boolean(selfMessage);
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach((node) => {
    const active = node.dataset.tab === tab;
    node.setAttribute('aria-selected', String(active));
    node.tabIndex = active ? 0 : -1;
  });
  for (const name of ['updates', 'packages', 'discover', 'history'] as Tab[]) $(`view-${name}`).hidden = name !== tab;
  $('self-update-button').className = `pd-btn ${selfVersion ? 'pd-btn-main' : 'pd-btn-line'}`;
}

const ask = (title: string, text: string, yes: string): Promise<boolean> =>
  new Promise((resolve) => {
    const dialog = $<HTMLDialogElement>('ask');
    $('ask-title').textContent = title;
    $('ask-text').textContent = text;
    $('ask-yes').textContent = yes;
    const finish = (answer: boolean) => {
      $('ask-yes').onclick = null;
      $('ask-no').onclick = null;
      dialog.onclose = null;
      if (dialog.open) dialog.close();
      resolve(answer);
    };
    $('ask-yes').onclick = () => finish(true);
    $('ask-no').onclick = () => finish(false);
    dialog.onclose = () => finish(false);
    dialog.showModal();
  });

function showTab(next: Tab): void {
  tab = next;
  renderText();
  views.open(next);
}

const views = createViews({
  api,
  t,
  settings: () => settings,
  patch: (values) => patch(values),
  setSettings: (next) => { settings = next; },
  busy: () => busy,
  setBusy: (label) => setBusy(label),
  ask,
  showTab,
});

function renderAll(): void {
  renderText();
  mountDial();
  renderHint();
  renderReport();
  views.render();
}

function setBusy(label: string): void {
  busy = Boolean(label);
  $('progress').textContent = label;
  $<HTMLButtonElement>('check').disabled = busy;
  $<HTMLButtonElement>('update').disabled = busy;
}

async function perform(action: () => Promise<Report>, label: string): Promise<void> {
  if (busy) return;
  setBusy(label);
  try {
    report = await action();
    live = null;
    renderReport();
    setBusy('');
  } catch (error) {
    live = null;
    renderReport();
    setBusy('');
    $('progress').textContent = `${t().failedRun} ${(error as Error).message}`;
  }
}

async function patch(values: Partial<Settings>): Promise<void> {
  settings = await api.saveSettings(values);
}

async function start(): Promise<void> {
  const state = await api.state();
  settings = state.settings;
  hasToken = state.hasToken;
  adminReady = state.adminReady;
  report = state.reports[0] ?? null;
  $('version').textContent = state.version;
  $<HTMLInputElement>('enabled').checked = settings.scheduleEnabled;
  $<HTMLInputElement>('apply').checked = settings.applyUpdates;
  $<HTMLInputElement>('minor').checked = settings.autoMinor;
  $<HTMLInputElement>('auto-self').checked = settings.autoSelfUpdate;
  $<HTMLInputElement>('holds').value = settings.holds.join(', ');
  $<HTMLInputElement>('portainer-url').value = settings.portainerUrl;
  renderAll();

  document.querySelectorAll<HTMLElement>('[data-lang]').forEach((node) => {
    node.addEventListener('click', async () => { await patch({ language: node.dataset.lang as Language }); renderAll(); });
  });
  $('theme').addEventListener('click', async () => { await patch({ theme: settings.theme === 'light' ? 'dark' : 'light' }); renderText(); });
  $('coffee').addEventListener('click', () => void api.coffee());
  $('enabled').addEventListener('change', async (event) => {
    await patch({ scheduleEnabled: (event.target as HTMLInputElement).checked });
    renderHint();
  });
  $('apply').addEventListener('change', (event) => void patch({ applyUpdates: (event.target as HTMLInputElement).checked }));
  $('minor').addEventListener('change', (event) => void patch({ autoMinor: (event.target as HTMLInputElement).checked }));
  $('auto-self').addEventListener('change', (event) => void patch({ autoSelfUpdate: (event.target as HTMLInputElement).checked }));
  const tabs = [...document.querySelectorAll<HTMLElement>('[data-tab]')];
  tabs.forEach((node, index) => {
    node.addEventListener('click', () => showTab(node.dataset.tab as Tab));
    node.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      const next = tabs[(index + step + tabs.length) % tabs.length];
      showTab(next.dataset.tab as Tab);
      next.focus();
    });
  });
  $('holds').addEventListener('change', (event) => {
    void patch({ holds: (event.target as HTMLInputElement).value.split(',').map((name) => name.trim()).filter(Boolean) });
  });
  $('portainer-url').addEventListener('change', (event) => void patch({ portainerUrl: (event.target as HTMLInputElement).value.trim() }));
  $('save-token').addEventListener('click', async () => {
    const field = $<HTMLInputElement>('portainer-token');
    if (!field.value) return;
    await api.saveToken(field.value);
    field.value = '';
    hasToken = true;
    renderText();
  });
  const settingsDialog = $<HTMLDialogElement>('settings');
  $('settings-open').addEventListener('click', () => settingsDialog.showModal());
  $('settings-close').addEventListener('click', () => settingsDialog.close());
  $('check').addEventListener('click', () => void perform(api.check, t().checking));
  const dialog = $<HTMLDialogElement>('confirm');
  $('update').addEventListener('click', () => dialog.showModal());
  $('confirm-no').addEventListener('click', () => dialog.close());
  $('confirm-yes').addEventListener('click', () => {
    dialog.close();
    void perform(api.update, t().updating);
  });
  api.onLog((message) => { $('progress').textContent = message; });
  api.onProgress((items) => {
    live = items;
    renderReport();
  });

  const showSelf = (version: string | null) => {
    selfVersion = version;
    renderText();
  };
  api.onSelfAvailable(showSelf);
  api.onSelfReady((version) => {
    selfReady = true;
    showSelf(version);
  });
  $('self-restart').addEventListener('click', async () => {
    selfMessage = t().selfRunning;
    renderText();
    try {
      await api.installSelf();
    } catch (error) {
      const text = (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      selfMessage = `${t().selfFailed} ${reason(settings.language as Language, text)}`;
      renderText();
    }
  });
  api.onSelfProgress((percent) => {
    const track = $('self-bar');
    track.hidden = false;
    track.setAttribute('aria-valuenow', String(percent));
    (track.firstElementChild as HTMLElement).style.width = `${percent}%`;
  });
  $('self-update-button').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('self-update-button');
    button.disabled = true;
    selfMessage = t().selfChecking;
    renderText();
    try {
      const version = await api.manualCheckSelf();
      if (!version) {
        selfVersion = null;
        selfMessage = state.packaged ? (t().selfCurrent as string).replace('{version}', state.version) : t().selfDev;
        button.disabled = false;
        renderText();
        return;
      }
      selfVersion = version;
      selfMessage = t().selfRunning;
      renderText();
      await api.installSelf();
    } catch (error) {
      button.disabled = false;
      $('self-bar').hidden = true;
      const text = (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      selfMessage = `${t().selfFailed} ${reason(settings.language as Language, text)}`;
      renderText();
    }
  });
  void api.checkSelf().then(showSelf).catch(() => {});

  const allowAdmin = async () => {
    adminReady = await api.setupAdmin();
    settings.adminAsked = true;
    adminMessage = adminReady ? '' : t().adminDenied;
    renderText();
  };
  const windows = state.platform === 'win32' && state.packaged;
  $('admin-row').hidden = !windows;
  $('admin-setup').addEventListener('click', () => void allowAdmin());
  const admin = $<HTMLDialogElement>('admin');
  $('admin-yes').addEventListener('click', () => { admin.close(); void allowAdmin(); });
  $('admin-no').addEventListener('click', () => { admin.close(); void patch({ adminAsked: true }); });
  if (windows && !adminReady && !settings.adminAsked) admin.showModal();
}

void start();
