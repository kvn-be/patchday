import assert from 'node:assert/strict';
import test from 'node:test';
import {
  latestCrateVersion, latestNugetVersion, parseCargoList, parseCargoSearch, parseDotnetList, parseDotnetSearch, parseNpmList,
  parseNpmSearch, parsePipList, parsePsModules, parsePypiProject, parseVcpkgList, parseVcpkgUpdate,
} from './extra.ts';
import { actionCommand, isSafeId } from './packages.ts';
import { cleanOptions, optionArgs, skipsUpdate } from './options.ts';
import { bundleFromPackages, parseBundle, reviewBundle, serializeBundle, xmlToJson } from './bundle.ts';

const allow = { allowParameters: true, allowSkipHash: true };
const deny = { allowParameters: false, allowSkipHash: false };

test('pip list merges outdated versions', () => {
  const list = JSON.stringify([{ name: 'requests', version: '2.31.0' }, { name: 'six', version: '1.16.0' }]);
  const outdated = JSON.stringify([{ name: 'Requests', version: '2.31.0', latest_version: '2.32.3' }]);
  assert.deepEqual(parsePipList(list, outdated).map((entry) => `${entry.id}:${entry.version}>${entry.available ?? ''}`), ['requests:2.31.0>2.32.3', 'six:1.16.0>']);
  assert.equal(parsePypiProject(JSON.stringify({ info: { name: 'black', version: '24.10.0', summary: 'The formatter' } }))?.description, 'The formatter');
});

test('npm list, outdated and search', () => {
  const list = JSON.stringify({ dependencies: { npm: { version: '10.2.0' }, '@angular/cli': { version: '17.0.0' } } });
  const outdated = JSON.stringify({ npm: { current: '10.2.0', latest: '10.8.0' } });
  assert.deepEqual(parseNpmList(list, outdated).map((entry) => `${entry.id}>${entry.available ?? ''}`), ['npm>10.8.0', '@angular/cli>']);
  assert.deepEqual(parseNpmSearch(JSON.stringify([{ name: 'typescript', version: '5.6.3', description: 'TS' }])).map((entry) => entry.id), ['typescript']);
});

test('.NET tools, NuGet versions and crates', () => {
  const list = ['Package Id      Version      Commands', '-------------------------------------------', 'dotnet-ef       8.0.0        dotnet-ef', ''].join('\n');
  assert.deepEqual(parseDotnetList(list).map((entry) => `${entry.id}:${entry.version}`), ['dotnet-ef:8.0.0']);
  const search = ['Package ID         Latest Version      Authors      Downloads      Verified', '---------------------------------------------------------------------------', 'dotnetsay          2.1.7               dotnet       1000           x'].join('\n');
  assert.deepEqual(parseDotnetSearch(search).map((entry) => `${entry.id}:${entry.version}`), ['dotnetsay:2.1.7']);
  assert.equal(latestNugetVersion(JSON.stringify({ versions: ['8.0.0', '9.0.0', '10.0.0-preview.1'] })), '9.0.0');
  assert.equal(latestCrateVersion(JSON.stringify({ crate: { max_stable_version: '14.1.1', max_version: '15.0.0-beta' } })), '14.1.1');
});

test('PowerShell modules accept one object or a list', () => {
  assert.deepEqual(parsePsModules('{"Name":"Pester","Version":"5.5.0","Latest":"5.6.1"}', 'pwsh').map((entry) => `${entry.id}>${entry.available}`), ['Pester>5.6.1']);
  assert.equal(parsePsModules('[{"Name":"A","Version":"1.0"},{"Name":"B; rm","Version":"1.0"}]', 'winps').length, 1);
  assert.deepEqual(parsePsModules('', 'pwsh'), []);
});

test('Cargo and vcpkg output', () => {
  assert.deepEqual(parseCargoList('ripgrep v14.1.0:\n    rg\nbat v0.24.0 (/src/bat):\n    bat\n').map((entry) => `${entry.id}:${entry.version}`), ['ripgrep:14.1.0', 'bat:0.24.0']);
  assert.deepEqual(parseCargoSearch('ripgrep = "14.1.1"    # fast grep\n... and 3 crates more').map((entry) => `${entry.id}:${entry.description}`), ['ripgrep:fast grep']);
  assert.deepEqual(parseVcpkgList('zlib:x64-windows      1.3.1     A compression library\n').map((entry) => `${entry.id}:${entry.version}`), ['zlib:x64-windows:1.3.1']);
  assert.equal(parseVcpkgUpdate('The following packages differ:\n    zlib:x64-windows      1.2.13 -> 1.3.1\n').get('zlib:x64-windows'), '1.3.1');
});

test('ids that look like options or carry shell characters are refused', () => {
  assert.equal(isSafeId('npm', '--global'), false);
  assert.equal(isSafeId('pip', 'requests; rm -rf /'), false);
  assert.equal(isSafeId('npm', '@scope/pkg'), true);
  assert.equal(isSafeId('vcpkg', 'zlib[core]:x64-windows'), true);
  assert.throws(() => actionCommand('install', { manager: 'cargo', id: '-x' }), /not a valid package name/);
});

test('install options become each manager\'s own arguments', () => {
  const options = cleanOptions({ Version: '1.2.3', InstallationScope: 'user', Architecture: 'x64', SkipHashCheck: true, CustomParameters_Install: ['--foo'], Junk: 'x' });
  assert.deepEqual(optionArgs('winget', 'install', options, allow), ['--version', '1.2.3', '--scope', 'user', '--architecture', 'x64', '--ignore-security-hash', '--foo']);
  assert.deepEqual(optionArgs('winget', 'install', options, deny), ['--version', '1.2.3', '--scope', 'user', '--architecture', 'x64']);
  assert.deepEqual(actionCommand('install', { manager: 'pip', id: 'black' }, { platform: 'darwin', options, policy: deny }).args, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--user', 'black==1.2.3']);
  assert.deepEqual(actionCommand('install', { manager: 'npm', id: 'typescript' }, { platform: 'darwin', options }).args, ['install', '-g', 'typescript@1.2.3']);
  assert.equal(cleanOptions({ Version: '1.0; rm -rf' }).Version, undefined);
  assert.equal(cleanOptions({ InstallationScope: 'everyone' }).InstallationScope, undefined);
});

test('updates can be skipped by size', () => {
  assert.equal(skipsUpdate({ SkipMajorUpdates: true }, '1.4.0', '2.0.0'), true);
  assert.equal(skipsUpdate({ SkipMajorUpdates: true }, '1.4.0', '1.5.0'), false);
  assert.equal(skipsUpdate({ SkipMinorUpdates: true }, '1.4.0', '1.4.1'), true);
  assert.equal(skipsUpdate({ SkipMinorUpdates: true, SkipMinorUpdatesLevel: '2' }, '1.4.0', '1.5.0'), true);
  assert.equal(skipsUpdate({ SkipMinorUpdates: true }, '1.4.0', '1.5.0'), false);
});

// A bundle as UniGetUI 3 writes it.
const UGUI = JSON.stringify({
  export_version: 3,
  packages: [
    { Id: 'Git.Git', Name: 'Git', Version: '2.47.0', Source: 'winget', ManagerName: 'winget', InstallationOptions: { InstallationScope: 'machine', PreInstallCommand: 'echo hi', CustomParameters_Install: ['/SILENT'] }, Updates: { UpdatesIgnored: true, IgnoredVersion: '*' } },
    { Id: 'extras/firefox', Name: 'Firefox', Version: '', Source: 'extras', ManagerName: 'Scoop' },
    { Id: 'vlc', Name: 'VLC', Version: '3.0', Source: 'Scoop: extras', ManagerName: 'scoop', Updates: { UpdatesIgnored: true, IgnoredVersion: '3.0.21' } },
    { Id: 'requests', Name: 'requests', Version: '2.31', Source: 'pip', ManagerName: 'Pip' },
    { Id: 'Thing', Name: 'Thing', Version: '1', Source: 'x', ManagerName: 'Flatpak' },
    { Id: 'evil;rm', Name: 'Evil', Version: '1', Source: 'npm', ManagerName: 'npm' },
  ],
  incompatible_packages_info: 'info',
  incompatible_packages: [{ Id: 'Local.App', Name: 'Local App', Version: '1.0', Source: 'Local PC' }],
});

test('UniGetUI bundles open, unknown or unsafe entries are listed as incompatible', () => {
  const bundle = parseBundle(UGUI, 'ubundle', 'win32');
  assert.deepEqual(bundle.packages.map((entry) => `${entry.manager}:${entry.id}:${entry.ignored ?? ''}`), ['winget:Git.Git:*', 'scoop:extras/firefox:', 'scoop:extras/vlc:3.0.21', 'pip:requests:']);
  assert.deepEqual(bundle.incompatible.map((entry) => `${entry.id}:${entry.reason}`), ['Thing:manager-unknown', 'evil;rm:invalid-id', 'Local.App:manager-unknown']);
  // On a Mac, winget and Scoop are not available.
  assert.deepEqual(parseBundle(UGUI, 'ubundle', 'darwin').packages.map((entry) => entry.id), ['requests']);
});

test('the security report removes commands and arguments unless Settings allow them', () => {
  const bundle = parseBundle(UGUI, 'ubundle', 'win32');
  const strict = reviewBundle(bundle, { allowParameters: false, allowCommands: false });
  assert.deepEqual(strict.findings.map((finding) => `${finding.field}:${finding.severity}:${finding.removed}`), ['CustomParameters_Install:warning:true', 'PreInstallCommand:high:true', 'Source:info:false', 'Source:info:false']);
  assert.equal(strict.bundle.packages[0].options.PreInstallCommand, undefined);
  assert.equal(strict.bundle.packages[0].options.InstallationScope, 'machine');
  const open = reviewBundle(bundle, { allowParameters: true, allowCommands: true });
  assert.equal(open.bundle.packages[0].options.PreInstallCommand, 'echo hi');
});

test('bundles written by Patchday read back the same and use UniGetUI ids', () => {
  const bundle = bundleFromPackages(
    [{ manager: 'brew', id: 'firefox', name: 'Firefox', version: '133.0', kind: 'cask' }, { manager: 'dotnet', id: 'dotnet-ef', name: 'dotnet-ef', version: '8.0.0' }],
    { 'dotnet:dotnet-ef': { Version: '8.0.0' } }, ['firefox'], {},
  );
  const text = serializeBundle(bundle);
  const data = JSON.parse(text);
  assert.equal(data.export_version, 3);
  assert.deepEqual(data.packages.map((entry: { ManagerName: string; Source: string }) => `${entry.ManagerName}:${entry.Source}`), ['homebrew:Homebrew Cask', 'dotnet-tool:nuget.org']);
  assert.deepEqual(data.packages[1].InstallationOptions, { OverridesNextLevelOpts: true, Version: '8.0.0' });
  const back = parseBundle(text, 'ubundle', 'darwin');
  assert.deepEqual(back.packages.map((entry) => `${entry.manager}:${entry.id}:${entry.kind ?? ''}:${entry.ignored ?? ''}`), ['brew:firefox:cask:*', 'dotnet:dotnet-ef::']);
});

test('old YAML and XML bundles are read', () => {
  const yaml = 'export_version: 2\npackages:\n  - Id: Git.Git\n    Name: Git\n    Version: "2.47.0"\n    Source: winget\n    ManagerName: Winget\n    InstallationOptions:\n      SkipHashCheck: true\n';
  const fromYaml = parseBundle(yaml, 'yaml', 'win32');
  assert.deepEqual(fromYaml.packages.map((entry) => `${entry.id}:${entry.options.SkipHashCheck}`), ['Git.Git:true']);
  const xml = '<?xml version="1.0"?><SerializableBundle><export_version>2</export_version><packages><SerializablePackage><Id>Git.Git</Id><Name>Git &amp; Co</Name><Version>2.47.0</Version><Source>winget</Source><ManagerName>Winget</ManagerName></SerializablePackage><SerializablePackage><Id>7zip.7zip</Id><Name>7-Zip</Name><Version>24</Version><Source>winget</Source><ManagerName>Winget</ManagerName></SerializablePackage></packages></SerializableBundle>';
  const fromXml = parseBundle(xml, 'xml', 'win32');
  assert.deepEqual(fromXml.packages.map((entry) => `${entry.id}:${entry.name}`), ['Git.Git:Git & Co', '7zip.7zip:7-Zip']);
  assert.throws(() => xmlToJson('<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><x>&a;</x>'), /DOCTYPE/);
  assert.throws(() => parseBundle('not json', 'ubundle', 'win32'), /not a package bundle/);
});
