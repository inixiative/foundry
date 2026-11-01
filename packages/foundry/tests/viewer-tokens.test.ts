import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The viewer's colours and type come from one place, ui/tokens.css (Kingdom's tokens plus the
// viewer's working names). These checks keep it that way: every variable used is defined, no
// stylesheet or component hard-codes a colour, and the vendored fonts match their manifest.

const ui = join(import.meta.dir, '../src/viewer/ui');
const read = (f: string) => readFileSync(join(ui, f), 'utf8');
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const tokens = read('tokens.css');
const sheets = ['tokens.css', 'styles.css', 'gloss.css'].map(
  (f) => [f, withoutComments(read(f))] as const,
);
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

test('the categorical layer palette is defined in tokens.css', () => {
  for (let i = 0; i < 12; i++) expect(defined.has(`--layer-${i}`)).toBe(true);
});

test('no stylesheet or component outside tokens.css hard-codes a hex colour', () => {
  const offenders: string[] = [];
  for (const [file, text] of [...sheets, ...scripts]) {
    if (file === 'tokens.css') continue;
    const withoutUrls = text.replace(/https?:\/\/\S+/g, '');
    for (const m of withoutUrls.matchAll(/['"\s:(,]#[0-9a-fA-F]{3,8}\b/g))
      offenders.push(`${file}: ${m[0].trim()}`);
  }
  expect(offenders).toEqual([]);
});

test('tokens.css carries Kingdom’s tokens and the status layer', () => {
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

test('vendored fonts match the manifest hashes', () => {
  const manifest = JSON.parse(read('vendor/manifest.json')) as {
    fonts: Record<string, { sha256: string }>;
  };
  const entries = Object.entries(manifest.fonts);
  expect(entries.length).toBe(3);
  for (const [file, { sha256 }] of entries) {
    const bytes = readFileSync(join(ui, 'vendor', file));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
    expect(tokens).toContain(`/ui/vendor/${file}`);
  }
});
