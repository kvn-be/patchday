import assert from 'node:assert/strict';
import test from 'node:test';
import { addHistory, HISTORY_LIMIT, type HistoryEntry } from './history.ts';
import {
  actionCommand, exportList, importList, isSafeId, isSafeQuery, isSkipped, parseBrewInstalled, parseBrewSearch,
  parseChocoPairs, parseScoopExport, parseScoopSearch, parseScoopStatus, parseWingetList, parseWingetSearch, scoopCommand,
} from './packages.ts';
import { selfCheckDue } from './selfupdate.ts';

const decode = (args: string[]) => Buffer.from(args.at(-1) as string, 'base64').toString('utf16le');
const SPINNER = '   - \r   \\ \r                                                  \r';

test('Homebrew installed list with formulae, casks and known updates', () => {
  const json = JSON.stringify({
    formulae: [
      { name: 'git', desc: 'Distributed revision control system', versions: { stable: '2.52.0' }, installed: [{ version: '2.51.0' }], outdated: true },
      { name: 'jq', versions: { stable: '1.8.1' }, installed: [{ version: '1.8.1' }], outdated: false },
    ],
    casks: [{ token: 'orbstack', name: ['OrbStack'], desc: 'Docker desktop alternative', version: '2.0.5', installed: '2.0.4', outdated: true }],
  });
  assert.deepEqual(parseBrewInstalled(json), [
    { manager: 'brew', kind: 'formula', id: 'git', name: 'git', version: '2.51.0', available: '2.52.0', description: 'Distributed revision control system' },
    { manager: 'brew', kind: 'formula', id: 'jq', name: 'jq', version: '1.8.1' },
    { manager: 'brew', kind: 'cask', id: 'orbstack', name: 'OrbStack', version: '2.0.4', available: '2.0.5', description: 'Docker desktop alternative' },
  ]);
});

test('Homebrew search keeps only names', () => {
  assert.deepEqual(parseBrewSearch('==> Formulae\nwget\nwget2\n\n', 'formula').map((entry) => entry.id), ['wget', 'wget2']);
  assert.deepEqual(parseBrewSearch('python@3.12\n', 'formula')[0].id, 'python@3.12');
});

test('winget list with apps from other sources and German headers', () => {
  const english = SPINNER + [
    'Name               Id                                Version       Available Source',
    '-----------------------------------------------------------------------------------',
    'Git                Git.Git                           2.46.0        2.47.0    winget',
    'Microsoft Edge     Microsoft.Edge                    131.0.2903.51           winget',
    'Old Tool           ARP\\Machine\\X64\\{1A2B-3C4D}       1.0',
    '',
  ].join('\r\n');
  assert.deepEqual(parseWingetList(english), [
    { manager: 'winget', id: 'Git.Git', name: 'Git', version: '2.46.0', available: '2.47.0' },
    { manager: 'winget', id: 'Microsoft.Edge', name: 'Microsoft Edge', version: '131.0.2903.51' },
    { manager: 'winget', id: 'ARP\\Machine\\X64\\{1A2B-3C4D}', name: 'Old Tool', version: '1.0' },
  ]);
  const german = [
    'Name    ID          Version Verfügbar Quelle',
    '--------------------------------------------',
    'Firefox Mozilla.Fx  131.0   132.0     winget',
  ].join('\r\n');
  assert.deepEqual(parseWingetList(german), [{ manager: 'winget', id: 'Mozilla.Fx', name: 'Firefox', version: '131.0', available: '132.0' }]);
});

test('winget search with and without the match column', () => {
  const output = SPINNER + [
    'Name               Id                         Version Match           Source',
    '----------------------------------------------------------------------------',
    'Visual Studio Code Microsoft.VisualStudioCode 1.95.3  Moniker: vscode winget',
    'VSCodium           VSCodium.VSCodium          1.95.3  Tag: vscode     winget',
  ].join('\r\n');
  assert.deepEqual(parseWingetSearch(output), [
    { manager: 'winget', id: 'Microsoft.VisualStudioCode', name: 'Visual Studio Code', version: '1.95.3' },
    { manager: 'winget', id: 'VSCodium.VSCodium', name: 'VSCodium', version: '1.95.3' },
  ]);
  const aligned = [
    'Name    Id          Version Source',
    '----------------------------------',
    'VLC     VideoLAN.VLC 3.0.21 winget',
  ].join('\n');
  assert.deepEqual(parseWingetSearch(aligned), [{ manager: 'winget', id: 'VideoLAN.VLC', name: 'VLC', version: '3.0.21' }]);
  assert.deepEqual(parseWingetSearch('No package found matching input criteria.'), []);
});

test('Chocolatey name|version pairs', () => {
  assert.deepEqual(parseChocoPairs('Chocolatey v2.3.0\r\ngit|2.47.0\r\n7zip|24.08\r\n2 packages installed.\r\n'), [
    { manager: 'choco', id: 'git', name: 'git', version: '2.47.0' },
    { manager: 'choco', id: '7zip', name: '7zip', version: '24.08' },
  ]);
});

test('Scoop export in JSON and in the older text form', () => {
  const json = JSON.stringify({ buckets: [], apps: [{ Name: 'git', Version: '2.47.0', Source: 'main' }, { Name: '7zip', Version: '24.08', Source: 'main' }] });
  assert.deepEqual(parseScoopExport(json).map((entry) => `${entry.id}@${entry.version}`), ['git@2.47.0', '7zip@24.08']);
  assert.deepEqual(parseScoopExport('git (v:2.47.0) [main]\r\nnodejs-lts (v:22.11.0) [main]\r\n').map((entry) => entry.id), ['git', 'nodejs-lts']);
});

test('Scoop status and search tables', () => {
  const status = [
    'WARN  Scoop out of date. Run \'scoop update\' to get the latest changes.',
    '',
    'Name   Installed Version Latest Version Missing Dependencies Info',
    '----   ----------------- -------------- -------------------- ----',
    'git    2.46.0            2.47.0',
    'nodejs 22.10.0           22.11.0',
    '',
  ].join('\r\n');
  assert.deepEqual(parseScoopStatus(status), [
    { id: 'git', installed: '2.46.0', available: '2.47.0' },
    { id: 'nodejs', installed: '22.10.0', available: '22.11.0' },
  ]);
  const search = [
    'Results from local buckets...',
    '',
    'Name   Version Source Binaries',
    '----   ------- ------ --------',
    'ripgrep 14.1.1 main   rg.exe',
    '',
  ].join('\r\n');
  assert.deepEqual(parseScoopSearch(search), [{ manager: 'scoop', id: 'main/ripgrep', name: 'ripgrep', version: '14.1.1' }]);
});

test('ids and queries that could act as options or code are refused', () => {
  assert.equal(isSafeId('winget', 'Git.Git'), true);
  assert.equal(isSafeId('winget', 'ARP\\Machine\\X64\\{1A2B}'), true);
  assert.equal(isSafeId('winget', '--force'), false);
  assert.equal(isSafeId('brew', 'python@3.12'), true);
  assert.equal(isSafeId('brew', '../etc'), false);
  assert.equal(isSafeId('choco', 'git; rm'), false);
  assert.equal(isSafeId('scoop', "git'; Remove-Item"), false);
  assert.equal(isSafeId('scoop', 'extras/vscode'), true);
  assert.equal(isSafeQuery('visual studio'), true);
  assert.equal(isSafeQuery('-h'), false);
  assert.equal(isSafeQuery('a$(x)'), false);
  assert.throws(() => actionCommand('install', { manager: 'choco', id: '-force' }), /not a valid package name/);
});

test('commands for every manager and action', () => {
  assert.deepEqual(actionCommand('install', { manager: 'brew', id: 'wget', kind: 'formula' }), { command: 'brew', args: ['install', '--formula', 'wget'] });
  assert.deepEqual(actionCommand('update', { manager: 'brew', id: 'orbstack', kind: 'cask' }), { command: 'brew', args: ['upgrade', '--cask', '--greedy', 'orbstack'] });
  assert.deepEqual(actionCommand('uninstall', { manager: 'winget', id: 'Git.Git' }).args, ['uninstall', '--id', 'Git.Git', '--exact', '--silent', '--accept-source-agreements', '--disable-interactivity']);
  assert.deepEqual(actionCommand('update', { manager: 'winget', id: 'Microsoft.VCRedist.2015+…' }).args.slice(0, 3), ['upgrade', '--id', 'Microsoft.VCRedist.2015+']);
  const choco = actionCommand('install', { manager: 'choco', id: 'git' });
  assert.equal(choco.command, 'powershell');
  assert.match(decode(choco.args), /Start-Process -FilePath choco\.exe -ArgumentList 'install','git','-y','--no-progress' -Verb RunAs/);
  assert.equal(decode(actionCommand('uninstall', { manager: 'scoop', id: 'extras/vscode' }).args), "& scoop 'uninstall' 'extras/vscode'; exit $LASTEXITCODE");
  assert.equal(decode(scoopCommand(['search', "it's"]).args), "& scoop 'search' 'it''s'; exit $LASTEXITCODE");
});

test('export and import keep valid packages and count the rest', () => {
  const list = exportList([{ manager: 'brew', id: 'git', name: 'git', version: '2.51.0', kind: 'formula' }, { manager: 'winget', id: 'Git.Git', name: 'Git', version: '2.46.0' }], new Date('2026-11-13T10:00:00Z'));
  assert.deepEqual(list.packages, [{ manager: 'brew', id: 'git', name: 'git', kind: 'formula' }, { manager: 'winget', id: 'Git.Git', name: 'Git' }]);
  const text = JSON.stringify({ ...list, packages: [...list.packages, { manager: 'apt', id: 'curl' }, { manager: 'choco', id: '--x' }, { manager: 'brew', id: 'git' }] });
  const result = importList(text);
  assert.deepEqual(result.packages.map((entry) => `${entry.manager}:${entry.id}`), ['brew:git', 'winget:Git.Git']);
  assert.equal(result.skipped, 3);
  assert.throws(() => importList('{"apps":[]}'), /not a Patchday package list/);
  assert.throws(() => importList('not json'), /not a Patchday package list/);
});

test('a skipped version hides only that version', () => {
  const skipped = { 'winget:Git.Git': '2.47.0' };
  assert.equal(isSkipped(skipped, { manager: 'winget', id: 'Git.Git' }, '2.47.0'), true);
  assert.equal(isSkipped(skipped, { manager: 'winget', id: 'Git.Git' }, '2.48.0'), false);
  assert.equal(isSkipped(skipped, { manager: 'choco', id: 'Git.Git' }, '2.47.0'), false);
});

test('history keeps the newest entries up to the limit', () => {
  const entry = (minute: number): HistoryEntry => ({ at: new Date(Date.UTC(2026, 10, 13, 0, minute)).toISOString(), action: 'install', name: `p${minute}`, ok: true });
  const old = Array.from({ length: HISTORY_LIMIT }, (_, i) => entry(i));
  const next = addHistory([...old, { broken: true }], [entry(5000)]);
  assert.equal(next.length, HISTORY_LIMIT);
  assert.equal(next[0].name, 'p5000');
  assert.equal(next.at(-1)?.name, 'p1');
  assert.deepEqual(addHistory('nonsense', [entry(1)]).map((item) => item.name), ['p1']);
});

test('the automatic self-update check runs once a day', () => {
  const now = new Date('2026-11-13T12:00:00Z');
  assert.equal(selfCheckDue(undefined, now), true);
  assert.equal(selfCheckDue('2026-11-13T00:00:00Z', now), false);
  assert.equal(selfCheckDue('2026-11-12T11:59:00Z', now), true);
  assert.equal(selfCheckDue('2026-11-14T00:00:00Z', now), true);
  assert.equal(selfCheckDue('garbage', now), true);
});
