import { nextRun } from '../core/schedule.ts';
import type { Report, ReportItem, Settings } from '../engine/types.ts';
import { reason, STRINGS, type Language } from './i18n.ts';

interface Api {
  state(): Promise<{ settings: Settings; reports: Report[]; version: string; platform: string; hasToken: boolean }>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  check(): Promise<Report>;
  update(): Promise<Report>;
  saveToken(token: string): Promise<void>;
  coffee(): Promise<void>;
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

function renderReport(): void {
  const box = $('report');
  box.replaceChildren();
  if (!report) {
    const empty = element('div', 'empty');
    empty.append(element('h2', '', t().emptyTitle), element('p', '', t().emptyText));
    box.append(empty);
    return;
  }
  const started = new Date(report.startedAt);
  const bar = element('div', 'pd-window-bar');
  bar.append(
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
  box.append(bar, tally);
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
      element('span', 'pd-reason', reason(language, item.reason)),
    );
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
}

function renderAll(): void {
  renderText();
  mountDial();
  renderHint();
  renderReport();
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
    renderReport();
    setBusy('');
  } catch (error) {
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
  report = state.reports[0] ?? null;
  if (state.platform === 'darwin') document.body.classList.add('mac');
  $('version').textContent = state.version;
  $<HTMLInputElement>('enabled').checked = settings.scheduleEnabled;
  $<HTMLInputElement>('apply').checked = settings.applyUpdates;
  $<HTMLInputElement>('minor').checked = settings.autoMinor;
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
  $('check').addEventListener('click', () => void perform(api.check, t().checking));
  const dialog = $<HTMLDialogElement>('confirm');
  $('update').addEventListener('click', () => dialog.showModal());
  $('confirm-no').addEventListener('click', () => dialog.close());
  $('confirm-yes').addEventListener('click', () => {
    dialog.close();
    void perform(api.update, t().updating);
  });
  api.onLog((message) => { $('progress').textContent = message; });
}

void start();
