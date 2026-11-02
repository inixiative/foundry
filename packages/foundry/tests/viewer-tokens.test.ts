import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The viewer's colours and type come from @inixiative/config's shared theme (public.css and
// status.css, served at /ui/theme/) plus the viewer's working names in styles.css. These checks
// keep it that way: every variable used is defined, no stylesheet or component hard-codes a colour,
// and every font the theme loads ships with it.

const ui = join(import.meta.dir, '../src/viewer/ui');
const read = (f: string) => readFileSync(join(ui, f), 'utf8');
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const themeDir = dirname(fileURLToPath(import.meta.resolve('@inixiative/config/theme/public.css')));
const theme = (f: string) => readFileSync(join(themeDir, f), 'utf8');
const tokens = withoutComments(theme('public.css') + theme('status.css'));
const sheets = [
  ['theme', tokens] as const,
  ...['styles.css', 'gloss.css'].map((f) => [f, withoutComments(read(f))] as const),
];
const scripts = readdirSync(ui)
  .filter((f) => f.endsWith('.js'))
  .map((f) => [f, read(f)] as const);

const defined = new Set(
  sheets.flatMap(([, css]) => [...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1])),
);

test('every CSS variable the viewer uses is defined', () => {
  const used = new Set<string>();
  for (const [, text] of [...sheets, ...scripts])
    for (const m of text.matchAll(/var\((--[a-z0-9-]+)/g)) used.add(m[1] as string);
  // `--layer-${i}` is built in store.js; its definitions are checked below.
  used.delete('--layer-');
  const missing = [...used].filter((v) => !defined.has(v));
  expect(missing).toEqual([]);
});

test('the categorical layer palette is defined in styles.css', () => {
  for (let i = 0; i < 12; i++) expect(defined.has(`--layer-${i}`)).toBe(true);
});

test('no stylesheet or component outside the theme hard-codes a hex colour', () => {
  const offenders: string[] = [];
  for (const [file, text] of [...sheets, ...scripts]) {
    if (file === 'theme') continue;
    const withoutUrls = text.replace(/https?:\/\/\S+/g, '');
    for (const m of withoutUrls.matchAll(/['"\s:(,]#[0-9a-fA-F]{3,8}\b/g))
      offenders.push(`${file}: ${m[0].trim()}`);
  }
  expect(offenders).toEqual([]);
});

test('the theme carries Kingdom’s tokens and the status layer', () => {
  for (const name of [
    '--background',
    '--foreground',
    '--app-primary',
    '--app-tertiary',
    '--app-quaternary',
    '--border',
    '--font-sans',
    '--font-display',
    '--font-mono',
    '--status-problem',
    '--status-attention',
    '--status-working',
    '--status-queued',
    '--status-done',
    '--status-idle',
    '--status-archived',
  ])
    expect(tokens).toContain(`${name}:`);
});

test('every font the theme loads ships beside it', () => {
  const fonts = [...theme('public.css').matchAll(/url\("\.\/(fonts\/[^"]+)"\)/g)].map(
    (m) => m[1] as string,
  );
  expect(fonts.length).toBe(3);
  for (const font of fonts) expect(existsSync(join(themeDir, font))).toBe(true);
});

test('the viewer loads the theme before its own styles', () => {
  for (const page of ['index.html', 'kingdom.html']) {
    const html = read(page);
    const at = (href: string) => html.indexOf(`href="${href}"`);
    expect(at('/ui/theme/public.css')).toBeGreaterThan(-1);
    expect(at('/ui/theme/public.css')).toBeLessThan(at('/ui/theme/status.css'));
    expect(at('/ui/theme/status.css')).toBeLessThan(at('/ui/styles.css'));
    expect(html).toContain('class="dark"');
  }
});
