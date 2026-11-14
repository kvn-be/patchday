import { nextRun } from '../core/schedule.ts';
import type { ProgressItem, Report, ReportItem, Settings } from '../engine/types.ts';
import { reason, STRINGS, type Language } from './i18n.ts';
import { createViews, type PackageApi } from './views.ts';

interface Api extends PackageApi {
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
  onSelfReady(listener: (version: string) => void): void;
  onProgress(listener: (items: ProgressItem[]) => void): void;
  onLog(listener: (message: string) => void): void;
}
declare global {
  interface Window {
    patchday: Api;
    Patchday: {
      mountWeekDial(svg: SVGSVGElement, input: HTMLInputElement, options: { hour: number; days: readonly string[]; short: readonly string[]; onChange(hour: number): void }): unknown;
      startParallax(root?: HTMLElement): () => void;
      mountWheel(root: HTMLElement, options: { items: { value: number; label: string }[]; value: number; label?: string; rowHeight?: number; onChange(value: number): void }): { set(value: number, animate?: boolean): void; get(): number };
    };
  }
}

type Page = 'overview' | 'updates' | 'packages' | 'schedule' | 'history';
const PAGES: Page[] = ['overview', 'updates', 'packages', 'schedule', 'history'];

const api = window.patchday;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const all = <T extends HTMLElement>(selector: string) => [...document.querySelectorAll<T>(selector)];
const element = (tag: string, className: string, text = '') => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

let settings: Settings;
let hasToken = false;
let reports: Report[] = [];
let busy = false;
let live: ProgressItem[] | null = null;
let adminReady = false;
let adminMessage = '';
let selfVersion: string | null = null;
let selfMessage = '';
let selfReady = false;
let packaged = false;
let page: Page = 'overview';
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const t = () => STRINGS[settings.language as Language];
const language = () => settings.language as Language;
const report = () => reports[0] ?? null;

const SOURCE: Record<ReportItem['source'], string> = { docker: 'Container', brew: 'Homebrew', winget: 'winget', choco: 'Chocolatey', scoop: 'Scoop' };
const PILL: Record<ReportItem['outcome'], [string, keyof typeof STRINGS.en]> = {
  planned: ['plain', 'bPlanned'],
  applied: ['ok', 'bApplied'],
  waiting: ['wait', 'bWaiting'],
  'rolled-back': ['back', 'bBack'],
  failed: ['back', 'bFailed'],
};
const PHASES = { backup: 'phaseBackup', update: 'phaseUpdate', test: 'phaseTest', rollback: 'phaseRollback', retry: 'phaseRetry', reinstall: 'phaseReinstall' } as const;

const formatWhen = (iso: string) => new Date(iso).toLocaleString(t().locale, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false });
const count = (items: ReportItem[], ...outcomes: ReportItem['outcome'][]) => items.filter((item) => outcomes.includes(item.outcome)).length;

function bar(tone: 'ok' | 'fail' | 'active' | 'busy', percent: number | null, label: string): HTMLElement {
  const track = element('div', `pd-progress pd-progress-${tone}`);
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', label);
  if (percent !== null) track.setAttribute('aria-valuenow', String(percent));
  const inner = element('span', '');
  if (percent !== null) inner.style.width = `${percent}%`;
  track.append(inner);
  return track;
}

// Same anatomy as every other list: icon, name with source, version, status.
function item(name: string, meta: string, version: string, pill: HTMLElement): HTMLElement {
  const row = element('div', 'pd-item');
  const icon = element('span', 'icon', (name.trim()[0] ?? '?').toUpperCase());
  icon.setAttribute('aria-hidden', 'true');
  const title = element('div', 'name');
  title.append(element('span', '', name), element('small', '', meta));
  const ver = element('span', 'ver', version);
  ver.title = version;
  const acts = element('div', 'acts');
  acts.append(pill);
  row.append(icon, title, ver, acts);
  return row;
}

// ---------- Updates ----------

function renderLive(box: HTMLElement, items: ProgressItem[]): void {
  const finished = items.filter((entry) => entry.state === 'done' || entry.state === 'failed').length;
  const total = element('div', 'overall');
  const share = items.length ? Math.round((finished / items.length) * 100) : 0;
  total.append(element('span', 'muted', `${t().updating} ${finished} / ${items.length} ${t().overall}`), bar('active', share, t().overall));
  box.append(total);
  for (const entry of items) {
    const tone = entry.state === 'failed' ? 'fail' : entry.state === 'done' ? 'ok' : entry.percent === null ? 'busy' : 'active';
    const label = entry.state === 'done' ? t().bApplied : entry.state === 'failed' ? t().bFailed : entry.phase ? t()[PHASES[entry.phase]] : t().queued;
    const pill = element('span', `pd-pill pd-pill-${entry.state === 'done' ? 'ok' : entry.state === 'failed' ? 'back' : 'plain'}`, label);
    const row = item(entry.name, SOURCE[entry.source], `${entry.from} → ${entry.to}`, pill);
    row.append(bar(tone, entry.percent, entry.name));
    if (entry.reason) row.append(element('span', 'reason', reason(language(), entry.reason)));
    box.append(row);
  }
}

function renderReport(): void {
  const box = $('report');
  box.replaceChildren();
  const current = report();
  $('updates-lead').textContent = current
    ? fill(t().updatesLead, { count: count(current.items, 'planned', 'waiting'), when: formatWhen(current.startedAt) })
    : t().updatesLeadNone;
  if (live) {
    renderLive(box, live);
    return;
  }
  if (!current) {
    const empty = element('div', 'empty');
    empty.append(element('h2', '', t().emptyTitle), element('p', '', t().emptyText));
    box.append(empty);
    return;
  }
  if (current.items.length === 0) box.append(element('div', 'notes', t().upToDate));
  const groups: [ReportItem['outcome'][], keyof typeof STRINGS.en][] = [
    [['waiting'], 'groupWaiting'],
    [['failed', 'rolled-back'], 'groupProblems'],
    [['planned'], 'groupPlanned'],
    [['applied'], 'groupApplied'],
  ];
  for (const [outcomes, label] of groups) {
    const members = current.items.filter((entry) => outcomes.includes(entry.outcome));
    if (members.length === 0) continue;
    box.append(element('div', 'pd-list-head', fill(t()[label] as string, { count: members.length })));
    for (const entry of members) {
      const [tone, text] = PILL[entry.outcome];
      const row = item(entry.name, SOURCE[entry.source], `${entry.from} → ${entry.to}`, element('span', `pd-pill pd-pill-${tone}`, t()[text] as string));
      if (entry.reason) row.append(element('span', 'reason', reason(language(), entry.reason)));
      if (entry.detail) {
        const more = element('details', 'pd-detail');
        more.append(element('summary', '', t().details), element('pre', '', entry.detail));
        row.append(more);
      }
      box.append(row);
    }
  }
  for (const note of current.notes) box.append(element('div', 'notes', note));
}

// ---------- Overview ----------

function scheduleDay(hour: number): number {
  return (Math.floor(hour / 24) + 1) % 7;
}

function nextRunText(): string {
  const hour = settings.hourOfWeek;
  const next = nextRun({ enabled: settings.scheduleEnabled, days: [scheduleDay(hour)], hour: hour % 24, minute: 0 }, new Date());
  return next ? `${next.toLocaleDateString(t().locale, { weekday: 'long', day: 'numeric', month: 'long' })} ${t().at} ${String(hour % 24).padStart(2, '0')}:00` : t().off;
}

function renderOverview(): void {
  const current = report();
  const planned = current?.mode === 'preview' ? count(current.items, 'planned') : 0;
  const waiting = current ? count(current.items, 'waiting') : 0;
  const ready = planned + waiting;
  $('hero-when').textContent = current ? fill(t().checkedAt, { when: formatWhen(current.startedAt) }) : t().notChecked;
  const title = planned === 0 && waiting > 0 ? (waiting === 1 ? t().heroWaitOne : fill(t().heroWaiting, { count: waiting })) : ready === 1 ? t().heroOne : fill(t().heroCount, { count: ready });
  $('hero-title').textContent = !current ? t().heroNoCheck : ready === 0 ? t().heroClear : title;
  const autoText = planned === 1 ? t().heroAutoOne : fill(t().heroAutoMany, { count: planned });
  const waitText = waiting === 1 ? t().heroWaitSingle : fill(t().heroWaitMany, { count: waiting });
  const text = waiting === 0 ? t().heroTextAuto : planned === 0 ? t().heroTextWait : `${autoText} ${waitText}`;
  $('hero-text').textContent = !current ? t().heroTextNoCheck : ready === 0 ? t().heroTextClear : text;
  $<HTMLButtonElement>('hero-update').disabled = busy || planned === 0;
  const nav = $('nav-count');
  nav.hidden = ready === 0;
  nav.textContent = String(ready);

  wheels?.day.set(Math.floor(settings.hourOfWeek / 24), true);
  wheels?.hour.set(settings.hourOfWeek % 24, true);

  $('card-next').textContent = nextRunText();
  const lastRun = reports.find((entry) => entry.mode === 'apply');
  $('card-last').textContent = lastRun ? new Date(lastRun.startedAt).toLocaleDateString(t().locale, { weekday: 'long', day: 'numeric', month: 'long' }) : t().lastNone;
  const pills = $('card-last-pills');
  pills.replaceChildren();
  if (lastRun) {
    const applied = count(lastRun.items, 'applied');
    const problems = count(lastRun.items, 'failed', 'rolled-back');
    pills.append(element('span', 'pd-pill pd-pill-ok', `${applied} ${t().applied}`));
    if (problems) pills.append(element('span', 'pd-pill pd-pill-back', problems === 1 ? t().problemOne : fill(t().problemMany, { count: problems })));
  }
  const first = current?.items.find((entry) => entry.outcome === 'waiting');
  $('card-wait').textContent = first ? first.name : t().waitNone;
  $('card-wait-text').textContent = first
    ? [`${first.from} → ${first.to}: ${reason(language(), first.reason)}.`, waiting === 2 ? t().waitMoreOne : waiting > 2 ? fill(t().waitMore, { count: waiting - 1 }) : ''].filter(Boolean).join(' ')
    : t().waitNoneText;
}

// ---------- Schedule ----------

function setSwitch(id: string, on: boolean): void {
  $(id).setAttribute('aria-checked', String(on));
}

function renderSchedule(): void {
  const hour = settings.hourOfWeek;
  const night = hour % 24 < 6;
  const hint = $('hint');
  hint.textContent = night ? t().noteNight : t().noteDay;
  hint.className = `note ${night ? 'night' : 'day'}`;
  $('next').textContent = settings.scheduleEnabled ? `${t().next} ${nextRunText()}` : t().off;
  setSwitch('enabled', settings.scheduleEnabled);
  setSwitch('enabled-quick', settings.scheduleEnabled);
  setSwitch('apply', settings.applyUpdates);
  setSwitch('minor', settings.autoMinor);
  setSwitch('auto-self', settings.autoSelfUpdate);
  const chips = $('holds');
  chips.replaceChildren();
  for (const name of settings.holds) {
    const chip = element('span', 'pd-chip', name);
    const remove = element('button', '', '×');
    (remove as HTMLButtonElement).type = 'button';
    remove.setAttribute('aria-label', fill(t().removeHold, { name }));
    remove.addEventListener('click', () => void patch({ holds: settings.holds.filter((entry) => entry !== name) }).then(renderAll));
    chip.append(remove);
    chips.append(chip);
  }
}

// Day and time on Overview: the same setting as the dial on Schedule, saved once the wheel rests.
let wheels: { day: ReturnType<Window['Patchday']['mountWheel']>; hour: ReturnType<Window['Patchday']['mountWheel']> } | null = null;

function setHour(hour: number): void {
  if (hour === settings.hourOfWeek) return;
  settings.hourOfWeek = hour;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void api.saveSettings({ hourOfWeek: hour }), 500);
}

function mountWheels(): void {
  const dayBox = $('wheel-day');
  const hourBox = $('wheel-hour');
  dayBox.replaceChildren();
  hourBox.replaceChildren();
  const day = window.Patchday.mountWheel(dayBox, {
    items: t().days.map((label, value) => ({ value, label })),
    value: Math.floor(settings.hourOfWeek / 24),
    label: t().wheelDay,
    rowHeight: 36,
    onChange(value) {
      setHour(value * 24 + (settings.hourOfWeek % 24));
      renderSchedule();
      mountDial();
      renderOverview();
    },
  });
  const hour = window.Patchday.mountWheel(hourBox, {
    items: Array.from({ length: 24 }, (_, value) => ({ value, label: `${String(value).padStart(2, '0')}:00` })),
    value: settings.hourOfWeek % 24,
    label: t().wheelTime,
    rowHeight: 36,
    onChange(value) {
      setHour(Math.floor(settings.hourOfWeek / 24) * 24 + value);
      renderSchedule();
      mountDial();
      renderOverview();
    },
  });
  wheels = { day, hour };
}

function mountDial(): void {
  const slot = $('dial-slot');
  slot.replaceChildren();
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'pd-dial');
  svg.setAttribute('viewBox', '0 0 600 600');
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
      // The system scheduler is only rewritten once the hand rests.
      setHour(hour);
      renderSchedule();
      renderOverview();
    },
  });
}

// ---------- Shell ----------

function renderText(): void {
  document.documentElement.lang = settings.language;
  all('[data-i18n]').forEach((node) => {
    node.textContent = t()[node.dataset.i18n as keyof typeof STRINGS.en] as string;
  });
  all('[data-lang]').forEach((node) => node.setAttribute('aria-pressed', String(node.dataset.lang === settings.language)));
  $('coffee').setAttribute('aria-label', t().coffee);
  $('token-state').textContent = hasToken ? t().tokenSaved : t().tokenNone;
  $('admin-state').textContent = adminMessage || (adminReady ? t().adminOn : t().adminOff);
  $('admin-setup').hidden = adminReady;
  $('self-update').hidden = !selfVersion && !selfMessage;
  $('self-text').textContent = selfMessage || (t()[selfReady ? 'selfReady' : 'selfAvailable'] as string).replace('{version}', selfVersion ?? '');
  $('self-restart').hidden = !selfReady || Boolean(selfMessage);
  all<HTMLButtonElement>('[data-page]').forEach((node) => {
    if (node.dataset.page === page) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
  for (const name of PAGES) $(`page-${name}`).hidden = name !== page;
}

function renderAll(): void {
  renderText();
  mountDial();
  mountWheels();
  renderSchedule();
  renderOverview();
  renderReport();
  views.render();
}

function showPage(next: Page): void {
  page = next;
  renderText();
  views.open(next);
}

function setBusy(label: string): void {
  busy = Boolean(label);
  $('progress').textContent = label;
  all<HTMLButtonElement>('[data-action]').forEach((node) => { node.disabled = busy; });
  if (!busy) renderOverview();
}

async function perform(action: () => Promise<Report>, label: string): Promise<void> {
  if (busy) return;
  setBusy(label);
  try {
    reports = [await action(), ...reports];
    live = null;
    setBusy('');
  } catch (error) {
    live = null;
    setBusy('');
    $('progress').textContent = `${t().failedRun} ${(error as Error).message}`;
  }
  renderReport();
  renderOverview();
}

async function patch(values: Partial<Settings>): Promise<void> {
  settings = await api.saveSettings(values);
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

const views = createViews({
  api,
  t,
  settings: () => settings,
  setSettings: (next) => { settings = next; renderOverview(); },
  busy: () => busy,
  setBusy: (label) => setBusy(label),
  ask,
});

async function start(): Promise<void> {
  const state = await api.state();
  settings = state.settings;
  hasToken = state.hasToken;
  adminReady = state.adminReady;
  packaged = state.packaged;
  reports = state.reports;
  $<HTMLInputElement>('portainer-url').value = settings.portainerUrl;
  renderAll();
  $('version').textContent = `${state.version}`;
  window.Patchday.startParallax();

  all('[data-page]').forEach((node) => node.addEventListener('click', () => showPage(node.dataset.page as Page)));
  all('[data-goto]').forEach((node) => node.addEventListener('click', () => showPage(node.dataset.goto as Page)));
  all('[data-lang]').forEach((node) => {
    node.addEventListener('click', async () => { await patch({ language: node.dataset.lang as Language }); renderAll(); });
  });
  $('coffee').addEventListener('click', () => void api.coffee());

  const toggle = (id: string, read: () => boolean, write: (on: boolean) => Partial<Settings>) => {
    $(id).addEventListener('click', async () => {
      await patch(write(!read()));
      renderSchedule();
      renderOverview();
    });
  };
  toggle('enabled', () => settings.scheduleEnabled, (on) => ({ scheduleEnabled: on }));
  toggle('enabled-quick', () => settings.scheduleEnabled, (on) => ({ scheduleEnabled: on }));
  toggle('apply', () => settings.applyUpdates, (on) => ({ applyUpdates: on }));
  toggle('minor', () => settings.autoMinor, (on) => ({ autoMinor: on }));
  toggle('auto-self', () => settings.autoSelfUpdate, (on) => ({ autoSelfUpdate: on }));
  $('hold-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const field = $<HTMLInputElement>('hold-input');
    const name = field.value.trim();
    if (!name || settings.holds.includes(name)) return;
    await patch({ holds: [...settings.holds, name] });
    field.value = '';
    renderAll();
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

  const confirm = $<HTMLDialogElement>('confirm');
  all('[data-action]').forEach((node) => {
    node.addEventListener('click', () => {
      if (node.dataset.action === 'check') {
        showPage('updates');
        void perform(api.check, t().checking);
      } else {
        confirm.showModal();
      }
    });
  });
  $('confirm-no').addEventListener('click', () => confirm.close());
  $('confirm-yes').addEventListener('click', () => {
    confirm.close();
    showPage('updates');
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
  api.onSelfProgress((percent) => {
    const track = $('self-bar');
    track.hidden = false;
    track.setAttribute('aria-valuenow', String(percent));
    (track.firstElementChild as HTMLElement).style.width = `${percent}%`;
  });
  const failed = (error: unknown) => {
    const text = (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    selfMessage = `${t().selfFailed} ${reason(language(), text)}`;
    $('self-bar').hidden = true;
    renderText();
  };
  $('self-restart').addEventListener('click', async () => {
    selfMessage = t().selfRunning;
    renderText();
    await api.installSelf().catch(failed);
  });
  $('self-update-button').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('self-update-button');
    button.disabled = true;
    showPage('overview');
    selfMessage = t().selfChecking;
    renderText();
    try {
      const version = await api.manualCheckSelf();
      if (!version) {
        selfVersion = null;
        selfMessage = packaged ? (t().selfCurrent as string).replace('{version}', state.version) : t().selfDev;
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
      failed(error);
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
