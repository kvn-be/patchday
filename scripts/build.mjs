import { build } from 'esbuild';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const tokens = JSON.parse(await readFile('design/system/project/tokens.json', 'utf8'));
const block = (selector, lines) => `${selector} {\n${lines.map((line) => `  ${line}`).join('\n')}\n}\n`;
const pick = (value, theme) => (typeof value === 'string' ? value : value[theme] ?? Object.values(value)[0]);
const themed = (theme) => [
  ...tokens.color.tokens.map((token) => `--${token.name}: ${pick(token.value, theme)};`),
  ...tokens.shadow.tokens.map((token) => `--${token.name}: ${pick(token.value, theme)};`),
];
const shared = [
  ...['spacing', 'radius', 'fluid'].flatMap((family) => tokens[family].tokens.map((token) => `--${token.name}: ${token.value};`)),
  ...Object.entries(tokens.type.families).map(([key, stack]) => `--font-${key}: ${stack};`),
];
// Two themes: light first, dark second. data-theme on the root picks one; "system" follows the system.
const [light, dark] = tokens.color.themes.map((theme) => theme.id);
const css = [
  '/* Generated from design/system/project/tokens.json */',
  block(':root', ['color-scheme: light;', ...themed(light), ...shared]),
  dark ? block(':root[data-theme="dark"]', ['color-scheme: dark;', ...themed(dark)]) : '',
  dark ? `@media (prefers-color-scheme: dark) {\n${block(':root[data-theme="system"]', ['color-scheme: dark;', ...themed(dark)])}}\n` : '',
].join('\n');
await writeFile('src/renderer/tokens.css', css);

await rm('dist', { recursive: true, force: true });
await mkdir('dist/renderer', { recursive: true });
const node = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] };
await Promise.all([
  build({ ...node, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.cjs' }),
  build({ ...node, entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.cjs' }),
  build({ bundle: true, platform: 'browser', target: 'chrome130', entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js' }),
  build({ bundle: true, entryPoints: ['src/renderer/app.css'], outfile: 'dist/renderer/app.css', loader: { '.woff2': 'file' }, assetNames: 'fonts/[name]', external: [] }),
]);
await copyFile('src/renderer/index.html', 'dist/renderer/index.html');
await copyFile('design/system/project/components/bundle.js', 'dist/renderer/bundle.js');
