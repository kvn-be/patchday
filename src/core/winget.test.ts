import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWingetUpgrade } from './winget.ts';

// Output as winget 1.9 prints it into a pipe: a progress spinner made of carriage returns before
// the table, CRLF line endings, names cut with an ellipsis, a summary line and a second table
// of packages that need explicit targeting.
const SPINNER = '   - \r   \\ \r   | \r   / \r                                                                                                                        \r';

const ENGLISH = SPINNER + [
  'Name                                   Id                            Version       Available     Source',
  '-------------------------------------------------------------------------------------------------------',
  'Git                                    Git.Git                       2.46.0        2.47.0        winget',
  'Microsoft Visual C++ 2015-2022 Redist… Microsoft.VCRedist.2015+.x64  14.40.33810.0 14.42.34433.0 winget',
  'PowerToys (Preview) x64                Microsoft.PowerToys           0.85.1        0.86.0        winget',
  'Spotify                                Spotify.Spotify               Unknown       1.2.50.335    winget',
  '4 upgrades available.',
  '',
  'The following packages have an upgrade available, but require explicit targeting for upgrade:',
  'Name    Id              Version  Available Source',
  '-------------------------------------------------',
  'Discord Discord.Discord 1.0.9163 1.0.9168  winget',
  '',
].join('\r\n');

const GERMAN = SPINNER + [
  'Name                     ID                         Version     Verfügbar   Quelle',
  '----------------------------------------------------------------------------------',
  'Mozilla Firefox (x64 de) Mozilla.Firefox.de         131.0.3     132.0       winget',
  'Notepad++ (64-bit x64)   Notepad++.Notepad++        8.7         8.7.1       winget',
  '7-Zip 24.08 (x64)        7zip.7zip                  24.08       24.09       winget',
  '3 Aktualisierungen verfügbar.',
  '',
].join('\r\n');

test('English output with spinner, cut names and a second table', () => {
  assert.deepEqual(parseWingetUpgrade(ENGLISH), [
    { name: 'Git', id: 'Git.Git', installed: '2.46.0', available: '2.47.0' },
    { name: 'Microsoft Visual C++ 2015-2022 Redist…', id: 'Microsoft.VCRedist.2015+.x64', installed: '14.40.33810.0', available: '14.42.34433.0' },
    { name: 'PowerToys (Preview) x64', id: 'Microsoft.PowerToys', installed: '0.85.1', available: '0.86.0' },
    { name: 'Spotify', id: 'Spotify.Spotify', installed: 'Unknown', available: '1.2.50.335' },
  ]);
});

test('German output uses ID, Verfügbar and Quelle', () => {
  assert.deepEqual(parseWingetUpgrade(GERMAN), [
    { name: 'Mozilla Firefox (x64 de)', id: 'Mozilla.Firefox.de', installed: '131.0.3', available: '132.0' },
    { name: 'Notepad++ (64-bit x64)', id: 'Notepad++.Notepad++', installed: '8.7', available: '8.7.1' },
    { name: '7-Zip 24.08 (x64)', id: '7zip.7zip', installed: '24.08', available: '24.09' },
  ]);
});

test('no updates and errors give an empty list', () => {
  assert.deepEqual(parseWingetUpgrade(SPINNER + 'No installed package found matching input criteria.\r\n'), []);
  assert.deepEqual(parseWingetUpgrade(SPINNER + 'Es wurde kein installiertes Paket gefunden, das den Eingabekriterien entspricht.\r\n'), []);
  assert.deepEqual(parseWingetUpgrade(''), []);
});
