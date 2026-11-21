import './helpers/isolate-archive';
import { expect, test } from 'bun:test';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextStack,
  EventStream,
  Harness,
  InterventionLog,
  Thread,
  TokenTracker,
} from '@inixiative/foundry-core';
import {
  ConfigStore,
  defaultAgents,
  starterConfig,
  validateRepositoryProject,
} from '../src/viewer/config';
import { createViewer } from '../src/viewer/server';
import {
  customThemeCss,
  customUiFile,
  discoverCustomUi,
  themeFile,
} from '../src/viewer/theme-files';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('customUiFile enforces strict containment, allowlist, no symlinks, no hardlinks, no dotfiles', async () => {
  const dir = makeTempDir('foundry-custom-ui-');
  const outside = makeTempDir('foundry-outside-');
  try {
    const uiDir = join(dir, 'ui');
    mkdirSync(join(uiDir, 'themes'), { recursive: true });
    mkdirSync(join(uiDir, 'extensions', 'pkg-ext'), { recursive: true });
    mkdirSync(join(uiDir, 'extensions', '.hidden-dir'), { recursive: true });

    writeFileSync(join(dir, 'settings.json'), '{"secret":true}');
    writeFileSync(join(outside, 'secret.css'), 'body { color: red; }');
    writeFileSync(join(uiDir, 'theme.css'), ':root { --accent: #ff00aa; }');
    writeFileSync(join(uiDir, 'themes', 'midnight.css'), ':root { --bg: #000; }');
    writeFileSync(join(uiDir, 'extensions', 'hello.js'), 'export default function() {}');
    writeFileSync(join(uiDir, 'extensions', 'pkg-ext', 'index.js'), 'export default function() {}');
    writeFileSync(join(uiDir, 'extensions', '.hidden-dir', 'index.js'), 'export default () => {}');
    writeFileSync(join(uiDir, '.secret.css'), 'body {}');
    writeFileSync(join(uiDir, 'icon.svg'), '<svg onload="alert(1)"></svg>');
    writeFileSync(join(uiDir, 'sessions.sqlite'), 'SQLite format 3');
    symlinkSync(join(outside, 'secret.css'), join(uiDir, 'escape-link.css'));
    symlinkSync(outside, join(uiDir, 'escape-dir'));
    linkSync(join(outside, 'secret.css'), join(uiDir, 'hardlink.css'));

    // Valid allowlisted files serve with strict headers.
    const okCss = await customUiFile(dir, '/ui/custom/theme.css');
    expect(okCss?.status).toBe(200);
    expect(okCss?.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(okCss?.headers.get('x-content-type-options')).toBe('nosniff');
    expect(okCss?.headers.get('cache-control')).toBe('no-store');
    expect(await okCss?.text()).toContain('--accent: #ff00aa');

    const okJs = await customUiFile(dir, '/ui/custom/extensions/hello.js');
    expect(okJs?.status).toBe(200);
    expect(okJs?.headers.get('content-type')).toBe('application/javascript; charset=utf-8');

    // Path traversal (raw and encoded), dotfiles, symlinks, hardlinks, disallowed extensions rejected.
    expect(await customUiFile(dir, '/ui/custom/../settings.json')).toBeUndefined();
    expect(
      await customUiFile(
        dir,
        '/ui/custom/settings.json',
        'http://127.0.0.1:4500/ui/custom/%2e%2e/settings.json',
      ),
    ).toBeUndefined();
    expect(
      await customUiFile(
        dir,
        '/ui/custom/themes/midnight.css',
        'http://127.0.0.1:4500/ui/custom/themes/..%2fsettings.json',
      ),
    ).toBeUndefined();
    expect(await customUiFile(dir, '/ui/custom/.secret.css')).toBeUndefined();
    expect(await customUiFile(dir, '/ui/custom/extensions/.hidden-dir/index.js')).toBeUndefined();
    expect(await customUiFile(dir, '/ui/custom/escape-link.css')).toBeUndefined();
    expect(await customUiFile(dir, '/ui/custom/escape-dir/secret.css')).toBeUndefined();
    expect(await customUiFile(dir, '/ui/custom/hardlink.css')).toBeUndefined();
    expect(await customUiFile(dir, '/ui/custom/icon.svg')).toBeUndefined();
    expect(await customUiFile(dir, '/ui/custom/sessions.sqlite')).toBeUndefined();

    // Discovery only lists valid regular non-symlink, single-link themes and extensions.
    const manifest = await discoverCustomUi(dir);
    expect(manifest).toEqual({
      themes: ['midnight'],
      extensions: ['hello', 'pkg-ext'],
      extensionEntries: {
        hello: '/ui/custom/extensions/hello.js',
        'pkg-ext': '/ui/custom/extensions/pkg-ext/index.js',
      },
      hasDefaultTheme: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('customThemeCss returns 200 placeholder CSS when missing and resolves named themes', async () => {
  const dir = makeTempDir('foundry-theme-css-');
  try {
    const empty = await customThemeCss(dir, null);
    expect(empty.status).toBe(200);
    expect(empty.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(empty.headers.get('cache-control')).toBe('no-store');
    expect(empty.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await empty.text()).toBe('/* no custom theme */\n');

    mkdirSync(join(dir, 'ui', 'themes'), { recursive: true });
    writeFileSync(join(dir, 'ui', 'theme.css'), ':root { --default-theme: 1; }');
    writeFileSync(join(dir, 'ui', 'themes', 'ocean.css'), ':root { --ocean-theme: 1; }');

    expect(await (await customThemeCss(dir, null)).text()).toContain('--default-theme: 1');
    expect(await (await customThemeCss(dir, 'ocean')).text()).toContain('--ocean-theme: 1');
    // Missing named theme falls back to theme.css.
    expect(await (await customThemeCss(dir, 'deleted-theme')).text()).toContain(
      '--default-theme: 1',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('themeFile still allows symlinks for package-managed /ui/theme/* assets', async () => {
  const dir = makeTempDir('foundry-theme-symlink-');
  const pkgTarget = makeTempDir('foundry-theme-pkg-');
  try {
    writeFileSync(join(pkgTarget, 'public.css'), ':root { --pkg: 1; }');
    symlinkSync(join(pkgTarget, 'public.css'), join(dir, 'public.css'));
    const res = await themeFile(dir, '/ui/theme/public.css');
    expect(res?.status).toBe(200);
    expect(await res?.text()).toContain('--pkg: 1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(pkgTarget, { recursive: true, force: true });
  }
});

test('viewer routes block /ui/custom/* when Kingdom authorization is unavailable', async () => {
  const dir = makeTempDir('foundry-custom-kingdom-');
  try {
    mkdirSync(join(dir, 'ui'), { recursive: true });
    writeFileSync(join(dir, 'ui', 'theme.css'), ':root { --x: 1; }');
    const configStore = new ConfigStore(dir);
    const config = starterConfig('controlled', 'controlled');
    config.agents = defaultAgents();
    await configStore.save(config);

    // Pair an unreachable Kingdom so kingdom.size > 0 and kingdom.check() fails.
    const viewer = createViewer({
      harness: new Harness(new Thread('main', new ContextStack())),
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      tokenTracker: new TokenTracker(),
      configStore,
      configDir: dir,
      localStore: null,
      kingdomIntegrations: [
        {
          url: 'http://127.0.0.1:1',
          integrationId: '00000000-0000-7000-8000-000000000001',
          signetId: '00000000-0000-7000-8000-000000000002',
          owner: 'User:00000000-0000-7000-8000-000000000003::',
        },
      ],
    });

    const req = (path: string) =>
      viewer.app.request(`http://127.0.0.1:4500${path}`, {
        headers: { Host: '127.0.0.1:4500' },
      });

    // /ui/custom/* and /api/ui/custom are gated by kingdom.check() -> 503 when unavailable.
    expect((await req('/ui/custom/theme.css')).status).toBe(503);
    expect((await req('/ui/custom/extensions/foo.js')).status).toBe(503);
    expect((await req('/api/ui/custom')).status).toBe(503);
    // Built-in /ui/styles.css remains exempted for recovery pages (/kingdom, /status).
    expect((await req('/ui/styles.css')).status).toBe(200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ConfigStore.patch("ui", ...) validates slugs, rejects prototype keys, merges nested maps, and deletes on null', async () => {
  const dir = makeTempDir('foundry-ui-config-');
  try {
    const store = new ConfigStore(dir);
    await store.load();

    // Valid nested patch.
    await store.patch('ui', {
      theme: 'midnight_2',
      extensions: ['ext-a', 'ext_b'],
      slots: {
        'rightPanel.tabs': { order: ['work', 'plan'], hidden: ['heralds'] },
      },
      flags: {
        rightPanel: { showComingSoon: false, showUsageBar: true },
      },
    });
    expect(store.config.ui).toEqual({
      theme: 'midnight_2',
      extensions: ['ext-a', 'ext_b'],
      slots: {
        'rightPanel.tabs': { order: ['work', 'plan'], hidden: ['heralds'] },
      },
      flags: {
        rightPanel: { showComingSoon: false, showUsageBar: true },
      },
    });

    // Nested merge keeps existing siblings and deletes keys set to null.
    await store.patch('ui', {
      slots: {
        'rightPanel.tabs': { hidden: null, pinned: ['plan'] },
        'header.right': { hidden: ['help'] },
      },
      flags: {
        rightPanel: { showUsageBar: null },
        conversation: { compactMessages: true },
      },
    });
    expect(store.config.ui).toEqual({
      theme: 'midnight_2',
      extensions: ['ext-a', 'ext_b'],
      slots: {
        'rightPanel.tabs': { order: ['work', 'plan'], pinned: ['plan'] },
        'header.right': { hidden: ['help'] },
      },
      flags: {
        rightPanel: { showComingSoon: false },
        conversation: { compactMessages: true },
      },
    });

    // Null deletes entire sub-trees and removes `ui` when empty.
    await store.patch('ui', {
      theme: null,
      extensions: null,
      slots: null,
      flags: null,
    });
    expect(store.config.ui).toBeUndefined();

    // Invalid theme slug, extension slug, and non-object patch rejected.
    await expect(store.patch('ui', { theme: '../evil' })).rejects.toThrow();
    await expect(store.patch('ui', { theme: 'BadUpper' })).rejects.toThrow();
    await expect(store.patch('ui', { extensions: ['ok', '../bad'] })).rejects.toThrow();
    await expect(
      store.patch('ui', ['not-an-object'] as unknown as Record<string, unknown>),
    ).rejects.toThrow(/must be an object/i);

    // Unsafe prototype keys rejected in slots and flags.
    const protoSlot = JSON.parse('{"slots":{"__proto__":{"hidden":["a"]}}}');
    await expect(store.patch('ui', protoSlot)).rejects.toThrow(/unsafe/i);
    const ctorFlag = JSON.parse('{"flags":{"constructor":{"x":true}}}');
    await expect(store.patch('ui', ctorFlag)).rejects.toThrow(/unsafe/i);
    const protoFlagKey = JSON.parse('{"flags":{"rightPanel":{"prototype":true}}}');
    await expect(store.patch('ui', protoFlagKey)).rejects.toThrow(/unsafe/i);

    // Repository `.foundry/project.json` rejects `ui`.
    expect(() => validateRepositoryProject({ ui: { theme: 'dark' } })).toThrow(
      /not a repository setting/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
