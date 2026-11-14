import { nextRun } from '../core/schedule.ts';
import type { ProgressItem, Report, ReportItem, Settings } from '../engine/types.ts';
import { reason, STRINGS, type Language } from './i18n.ts';
import { createViews, type PackageApi } from './views.ts';

interface Api extends PackageApi {
  state(): Promise<{ settings: Settings; reports: Report[]; version: string; platform: string; hasToken: boolean; hasAdminPassword: boolean; adminReady: boolean; packaged: boolean }>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  check(): Promise<Report>;
  update(): Promise<Report>;
  updateNow(keys: string[]): Promise<Report>;
  saveToken(token: string): Promise<void>;
  saveAdminPassword(password: string): Promise<boolean>;
  forgetAdminPassword(): Promise<void>;
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
      mountSteps(root: HTMLElement, options: { steps: number; current?: number; state?: string; label?: string; scale?: number }): { element: SVGSVGElement; set(current: number, state: 'running' | 'done' | 'failed', label?: string): void };
      mountWheel(root: HTMLElement, options: { items: { value: number; label: string }[]; value: number; label?: string; rowHeight?: number; onChange(value: number): void }): { set(value: number, animate?: boolean): void; get(): number };
    };
  }
}

type Page = 'overview' | 'updates' | 'packages' | 'history' | 'settings';
const PAGES: Page[] = ['overview', 'updates', 'packages', 'history', 'settings'];

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
let hasAdminPassword = false;
let sudoMessage = '';
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
// Optional updates (minor, no security fix) wait quietly in their own section and do not ask for attention.
const needsYou = (item: ReportItem) => item.outcome === 'waiting' && !item.optional;

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

let overall: { box: HTMLElement; text: HTMLElement; bar: HTMLElement } | undefined;

function renderLive(box: HTMLElement, items: ProgressItem[]): void {
  const finished = items.filter((entry) => entry.state === 'done' || entry.state === 'failed').length;
  const share = items.length ? Math.round((finished / items.length) * 100) : 0;
  // The overall bar stays the same element between redraws, so it grows from where it was instead of jumping.
  overall ??= { box: element('div', 'overall'), text: element('span', 'muted', ''), bar: bar('active', 0, t().overall) };
  if (!overall.box.childElementCount) overall.box.append(overall.text, overall.bar);
  overall.text.textContent = `${t().updating} ${finished} / ${items.length} ${t().overall}`;
  overall.bar.setAttribute('aria-label', t().overall);
  overall.bar.setAttribute('aria-valuenow', String(share));
  (overall.bar.firstElementChild as HTMLElement).style.width = `${share}%`;
  box.append(overall.box);
  for (const entry of items) {
    const label = entry.state === 'done' ? t().bApplied : entry.state === 'failed' ? t().bFailed : entry.phase ? t()[PHASES[entry.phase]] : t().queued;
    const pill = element('span', `pd-pill pd-pill-${entry.state === 'done' ? 'ok' : entry.state === 'failed' ? 'back' : 'plain'}`, label);
    const row = item(entry.name, SOURCE[entry.source], `${entry.from} → ${entry.to}`, pill);
    const holder = element('div', 'steps');
    holder.append(stepsFor(entry, label).element);
    row.append(holder);
    if (entry.reason) row.append(element('span', 'reason', reason(language(), entry.reason)));
    box.append(row);
  }
}

// Containers: back up, update, test, done. Packages: install, repair, done.
const CONTAINER_STEPS: Partial<Record<ProgressItem['phase'] & string, number>> = { backup: 0, update: 1, test: 2, rollback: 2 };
const PACKAGE_STEPS: Partial<Record<ProgressItem['phase'] & string, number>> = { update: 0, retry: 1, reinstall: 1 };
const stepViews = new Map<string, ReturnType<Window['Patchday']['mountSteps']>>();
// The last phase each item reached, so a failure is marked where it happened.
const reached = new Map<string, number>();

function stepsFor(entry: ProgressItem, label: string): ReturnType<Window['Patchday']['mountSteps']> {
  const container = entry.source === 'docker';
  const count = container ? 4 : 3;
  let view = stepViews.get(entry.id);
  if (!view) {
    view = window.Patchday.mountSteps(document.createElement('div'), { steps: count });
    stepViews.set(entry.id, view);
  }
  const map = container ? CONTAINER_STEPS : PACKAGE_STEPS;
  const known = entry.phase ? map[entry.phase] : undefined;
  const current = entry.state === 'done' ? count - 1 : entry.state === 'queued' ? -1 : known ?? reached.get(entry.id) ?? 0;
  if (current >= 0) reached.set(entry.id, current);
  const state = entry.state === 'done' ? 'done' : entry.state === 'failed' ? 'failed' : 'running';
  view.set(current, state, fill(t().stepsLabel, { name: entry.name, phase: label }));
  return view;
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
  // Applied updates need nothing more; they stay in the history and the run logs.
  if (current.items.every((entry) => entry.outcome === 'applied')) box.append(element('div', 'notes', t().upToDate));
  const groups: [(entry: ReportItem) => boolean, keyof typeof STRINGS.en][] = [
    [needsYou, 'groupWaiting'],
    [(entry) => entry.outcome === 'failed' || entry.outcome === 'rolled-back', 'groupProblems'],
    [(entry) => entry.outcome === 'planned', 'groupPlanned'],
    [(entry) => entry.outcome === 'waiting' && Boolean(entry.optional), 'groupOptional'],
  ];
  for (const [belongs, label] of groups) {
    const members = current.items.filter(belongs);
    if (members.length === 0) continue;
    box.append(element('div', 'pd-list-head', fill(t()[label] as string, { count: members.length })));
    if (label === 'groupOptional') box.append(element('div', 'notes', t().optionalLead));
    for (const entry of members) {
      const [tone, text] = PILL[entry.outcome];
      const approved = entry.optional ? settings.approved.includes(entry.optional) : false;
      const pill = entry.optional ? approveButton(entry.optional, approved) : element('span', `pd-pill pd-pill-${tone}`, t()[text] as string);
      const row = item(entry.name, SOURCE[entry.source], `${entry.from} → ${entry.to}`, pill);
      if (entry.outcome === 'waiting' && entry.key) row.querySelector('.acts')?.append(updateNowButton(entry));
      if (entry.reason) row.append(element('span', 'reason', approved ? t().optionalApproved : reason(language(), entry.reason)));
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

// An optional update installs at the next run once approved; approving again takes it back.
function approveButton(key: string, approved: boolean): HTMLButtonElement {
  const node = element('button', `pd-btn pd-btn-${approved ? 'main' : 'line'} pd-btn-small`, approved ? t().optionalUndo : t().optionalApprove) as HTMLButtonElement;
  node.type = 'button';
  node.setAttribute('aria-pressed', String(approved));
  node.addEventListener('click', async () => {
    const offered = new Set((report()?.items ?? []).map((entry) => entry.optional).filter(Boolean));
    // Approvals for versions no longer offered are dropped on the way.
    const kept = settings.approved.filter((entry) => entry !== key && offered.has(entry));
    await patch({ approved: settings.approved.includes(key) ? kept : [...kept, key] });
    renderReport();
  });
  return node;
}

// Updates one waiting container right away, with the usual backup, health test and rollback.
function updateNowButton(entry: ReportItem): HTMLButtonElement {
  const node = element('button', 'pd-btn pd-btn-main pd-btn-small', t().updateNow) as HTMLButtonElement;
  node.type = 'button';
  node.disabled = busy;
  node.addEventListener('click', async () => {
    const text = fill(t().updateNowText, { name: entry.name, from: entry.from, to: entry.to, reason: reason(language(), entry.reason) });
    if (!(await ask(fill(t().updateNowTitle, { name: entry.name }), text, t().updateNow))) return;
    showPage('updates');
    await perform(() => api.updateNow([entry.key as string]), t().updating);
  });
  return node;
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
  const planned = current ? count(current.items, 'planned') : 0;
  const waiting = current ? current.items.filter(needsYou).length : 0;
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
  const first = current?.items.find(needsYou);
  $('card-wait').textContent = first ? first.name : t().waitNone;
  $('card-wait-text').textContent = first
    ? [`${first.from} → ${first.to}: ${reason(language(), first.reason)}.`, waiting === 2 ? t().waitMoreOne : waiting > 2 ? fill(t().waitMore, { count: waiting - 1 }) : ''].filter(Boolean).join(' ')
    : t().waitNoneText;
}

// ---------- Settings ----------

function setSwitch(id: string, on: boolean): void {
  $(id).setAttribute('aria-checked', String(on));
}

function renderSettings(): void {
  // The wheel box carries the whole schedule: on or off, day and time, the date it lands on,
  // and a warning only when the time falls in the day.
  const night = settings.hourOfWeek % 24 < 6;
  $('when').classList.toggle('off', !settings.scheduleEnabled);
  $('when-next').textContent = nextRunText();
  const note = $('when-note');
  note.hidden = night || !settings.scheduleEnabled;
  note.textContent = t().noteDay;
  all('[data-appearance]').forEach((node) => node.setAttribute('aria-pressed', String(node.dataset.appearance === settings.appearance)));
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

// Day and time on Overview, saved once the wheel rests.
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
      renderSettings();
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
      renderSettings();
      renderOverview();
    },
  });
  wheels = { day, hour };
}

// ---------- Shell ----------

function renderText(): void {
  document.documentElement.lang = settings.language;
  document.documentElement.dataset.theme = settings.appearance ?? 'system';
  all('[data-i18n]').forEach((node) => {
    node.textContent = t()[node.dataset.i18n as keyof typeof STRINGS.en] as string;
  });
  all('[data-lang]').forEach((node) => node.setAttribute('aria-pressed', String(node.dataset.lang === settings.language)));
  $('coffee').setAttribute('aria-label', t().coffee);
  $('token-state').textContent = hasToken ? t().tokenSaved : t().tokenNone;
  $('sudo-state').textContent = sudoMessage || (hasAdminPassword ? t().sudoSaved : t().sudoNone);
  $('sudo-forget').hidden = !hasAdminPassword;
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
  mountWheels();
  renderSettings();
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
  // A new run starts with fresh bars and steps.
  overall = undefined;
  stepViews.clear();
  reached.clear();
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
  hasAdminPassword = state.hasAdminPassword;
  $('sudo-card').hidden = state.platform === 'win32';
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
      renderSettings();
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
  $('sudo-save').addEventListener('click', async () => {
    const field = $<HTMLInputElement>('sudo-password');
    if (!field.value) return;
    const button = $<HTMLButtonElement>('sudo-save');
    button.disabled = true;
    try {
      const ok = await api.saveAdminPassword(field.value);
      sudoMessage = ok ? '' : t().sudoWrong;
      if (ok) hasAdminPassword = true;
    } catch (error) {
      sudoMessage = String((error as Error).message ?? error);
    } finally {
      field.value = '';
      button.disabled = false;
      renderText();
    }
  });
  $('sudo-forget').addEventListener('click', async () => {
    await api.forgetAdminPassword();
    hasAdminPassword = false;
    sudoMessage = '';
    renderText();
  });
  all('[data-appearance]').forEach((node) => {
    node.addEventListener('click', async () => {
      await patch({ appearance: node.dataset.appearance as Settings['appearance'] });
      renderText();
      renderSettings();
    });
  });

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
