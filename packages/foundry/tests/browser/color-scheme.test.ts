import '../helpers/isolate-archive';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
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
import { ProjectRegistry } from '../../src/agents/project';
import { ConfigStore, defaultAgents, starterConfig } from '../../src/viewer/config';
import { createViewer } from '../../src/viewer/server';
import { type ReleaseStep, releaseAll } from '../helpers/release-all';

const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

test('Dark / Light / System color scheme toggles tokens, persists without reload flash, reacts to OS media, and meets light-mode WCAG AA contrast', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-color-scheme-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const projects = new ProjectRegistry();
    const project = projects.register({
      id: 'shop',
      label: 'acme-shop',
      path: join(dir, 'shop'),
      tags: [],
      runtime: 'claude-code',
    });
    project.addThread(
      new Thread('shop-1', new ContextStack(), {
        description: 'Color scheme thread',
        projectId: 'shop',
      }),
    );

    const configStore = new ConfigStore(dir);
    const config = starterConfig('controlled', 'controlled');
    config.agents = defaultAgents();
    config.setupComplete = true;
    config.projects.shop = { id: 'shop', path: join(dir, 'shop'), label: 'acme-shop' };
    await configStore.save(config);

    const viewer = createViewer({
      harness: new Harness(new Thread('main', new ContextStack(), { description: 'Global' })),
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      tokenTracker: new TokenTracker(),
      configStore,
      configDir: dir,
      projectRegistry: projects,
      localStore: null,
    });
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: viewer.fetch,
      websocket: viewer.websocket,
    });
    cleanup.unshift(['server', () => server.stop(true)]);
    const origin = `http://127.0.0.1:${server.port}`;

    const browser = await chromium.launch({ headless: true });
    cleanup.unshift(['browser', () => browser.close()]);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: 'dark',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));

    const readThemeSnapshot = () =>
      page.evaluate(() => {
        const root = document.documentElement;
        const cs = getComputedStyle(root);
        const bodyCs = getComputedStyle(document.body);
        const meta = document.querySelector('meta[name="color-scheme"]');
        return {
          hasDark: root.classList.contains('dark'),
          colorScheme: cs.colorScheme,
          metaContent: meta?.getAttribute('content') ?? null,
          background: cs.getPropertyValue('--background').trim(),
          bgDeeper: cs.getPropertyValue('--bg-deeper').trim(),
          toneWarn: cs.getPropertyValue('--tone-warn').trim(),
          toneError: cs.getPropertyValue('--tone-error').trim(),
          toneInfoBright: cs.getPropertyValue('--tone-info-bright').trim(),
          layer0: cs.getPropertyValue('--layer-0').trim(),
          bodyBg: bodyCs.backgroundColor,
          bodyColor: bodyCs.color,
          stored: localStorage.getItem('foundry.ui.colorScheme'),
        };
      });

    // 1. Default state is Dark and preserves exact pre-existing dark token values.
    await page.goto(`${origin}/settings/appearance`);
    const colorSchemeCard = page.locator('[data-setting="ui.colorScheme"]');
    await colorSchemeCard.waitFor();

    const darkRadio = colorSchemeCard.locator('button[data-color-scheme="dark"]');
    const lightRadio = colorSchemeCard.locator('button[data-color-scheme="light"]');
    const systemRadio = colorSchemeCard.locator('button[data-color-scheme="system"]');

    expect(await darkRadio.getAttribute('aria-checked')).toBe('true');
    const darkSnap = await readThemeSnapshot();
    expect(darkSnap.hasDark).toBe(true);
    expect(darkSnap.colorScheme).toBe('dark');
    expect(darkSnap.metaContent).toBe('dark');
    expect(darkSnap.background).toBe('206 29% 6%');
    expect(darkSnap.bgDeeper).toBe('hsl(206 30% 4%)');
    expect(darkSnap.toneWarn).toBe('hsl(38 87% 69%)');
    expect(darkSnap.toneError).toBe('hsl(7 100% 74%)');
    expect(darkSnap.toneInfoBright).toBe('hsl(205 70% 78%)');
    expect(darkSnap.layer0).toBe('hsl(211 100% 79%)');

    // 2. Switch Dark -> Light.
    await lightRadio.click();
    await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
    expect(await lightRadio.getAttribute('aria-checked')).toBe('true');
    expect(configStore.config.ui?.colorScheme).toBe('light');

    const lightSnap = await readThemeSnapshot();
    expect(lightSnap.hasDark).toBe(false);
    expect(lightSnap.colorScheme).toBe('light');
    expect(lightSnap.metaContent).toBe('light');
    expect(lightSnap.background).toBe('70 25% 96%');
    expect(lightSnap.bgDeeper).toBe('hsl(76 16% 92%)');
    expect(lightSnap.stored).toBe('light');
    expect(lightSnap.bodyBg).not.toBe(darkSnap.bodyBg);

    // 3. Verify WCAG AA contrast (>= 4.5:1) in Light Mode for body text, active control, and semantic/layer tokens.
    const contrastReport = await page.evaluate(() => {
      const parseRgb = (cssColor: string): [number, number, number] => {
        const probe = document.createElement('span');
        probe.style.color = cssColor;
        document.body.append(probe);
        const resolved = getComputedStyle(probe).color;
        probe.remove();
        const match = resolved.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!match) throw new Error(`Could not parse color: ${cssColor} -> ${resolved}`);
        return [Number(match[1]) / 255, Number(match[2]) / 255, Number(match[3]) / 255];
      };
      const lum = ([r, g, b]: [number, number, number]) => {
        const ch = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
      };
      const ratio = (c1: string, c2: string) => {
        const l1 = lum(parseRgb(c1));
        const l2 = lum(parseRgb(c2));
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };

      const cs = getComputedStyle(document.documentElement);
      const bg = getComputedStyle(document.body).backgroundColor;
      const fg = getComputedStyle(document.body).color;
      const activeBtn = document.querySelector(
        '[data-setting="ui.colorScheme"] button.is-active',
      ) as HTMLElement;
      const activeBtnCs = getComputedStyle(activeBtn);

      const results: Record<string, number> = {
        bodyTextOnBg: ratio(fg, bg),
        activeSegmentedBtn: ratio(activeBtnCs.color, activeBtnCs.backgroundColor),
        toneWarn: ratio(cs.getPropertyValue('--tone-warn').trim(), bg),
        toneError: ratio(cs.getPropertyValue('--tone-error').trim(), bg),
        toneInfo: ratio(cs.getPropertyValue('--tone-info').trim(), bg),
        toneInfoBright: ratio(cs.getPropertyValue('--tone-info-bright').trim(), bg),
        toneQueued: ratio(cs.getPropertyValue('--tone-queued').trim(), bg),
      };
      for (let i = 0; i <= 11; i++) {
        results[`layer${i}`] = ratio(cs.getPropertyValue(`--layer-${i}`).trim(), bg);
      }
      return results;
    });
    for (const [label, value] of Object.entries(contrastReport)) {
      expect(value, `${label} light-mode contrast should be >= 4.5`).toBeGreaterThanOrEqual(4.5);
    }

    // 4. Reload persists Light Mode BEFORE first paint (zero flash).
    // Capture `<html>.classList.contains('dark')` immediately at DOMContentLoaded before module scripts fetch settings.
    await page.addInitScript(() => {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          (window as unknown as { __darkAtDcl?: boolean }).__darkAtDcl =
            document.documentElement.classList.contains('dark');
        },
        { once: true },
      );
    });
    await page.reload();
    await colorSchemeCard.waitFor();
    const darkAtDcl = await page.evaluate(
      () => (window as unknown as { __darkAtDcl?: boolean }).__darkAtDcl,
    );
    expect(darkAtDcl).toBe(false);
    expect((await readThemeSnapshot()).hasDark).toBe(false);
    expect(await lightRadio.getAttribute('aria-checked')).toBe('true');

    // 5. Switch Light -> System, and react live to OS prefers-color-scheme changes.
    await page.emulateMedia({ colorScheme: 'light' });
    await systemRadio.click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-setting="ui.colorScheme"] button[data-color-scheme="system"]')
          ?.getAttribute('aria-checked') === 'true',
    );
    expect(configStore.config.ui?.colorScheme).toBe('system');
    expect((await readThemeSnapshot()).hasDark).toBe(false);
    expect(await colorSchemeCard.locator('.color-scheme-hint').innerText()).toContain('Light');

    // Flip OS preference to dark live -> updates without reload!
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
    expect((await readThemeSnapshot()).colorScheme).toBe('dark');
    expect(await colorSchemeCard.locator('.color-scheme-hint').innerText()).toContain('Dark');

    // Flip OS preference back to light live -> updates without reload!
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
    expect((await readThemeSnapshot()).colorScheme).toBe('light');

    // Reload under System + OS light -> zero flash (already light at DOMContentLoaded).
    await page.reload();
    await colorSchemeCard.waitFor();
    const systemDarkAtDcl = await page.evaluate(
      () => (window as unknown as { __darkAtDcl?: boolean }).__darkAtDcl,
    );
    expect(systemDarkAtDcl).toBe(false);
    expect((await readThemeSnapshot()).hasDark).toBe(false);

    // 6. Verify workspace surfaces (kbd chips, header, conversation) in light mode have legible contrast.
    await page.goto(`${origin}/#thread=shop-1&detail=1`);
    await page.locator('.conversation').waitFor();
    const workspaceLightSnap = await page.evaluate(() => {
      const parseRgba = (cssColor: string): [number, number, number, number] => {
        const probe = document.createElement('span');
        probe.style.color = cssColor;
        document.body.append(probe);
        const resolved = getComputedStyle(probe).color;
        probe.remove();
        const match = resolved.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (!match) throw new Error(`Could not parse color: ${cssColor} -> ${resolved}`);
        return [
          Number(match[1]) / 255,
          Number(match[2]) / 255,
          Number(match[3]) / 255,
          match[4] !== undefined ? Number(match[4]) : 1,
        ];
      };
      const blendOver = (
        fg: [number, number, number, number],
        bg: readonly [number, number, number, ...number[]],
      ): [number, number, number] => [
        fg[0] * fg[3] + bg[0] * (1 - fg[3]),
        fg[1] * fg[3] + bg[1] * (1 - fg[3]),
        fg[2] * fg[3] + bg[2] * (1 - fg[3]),
      ];
      const lum = ([r, g, b]: [number, number, number]) => {
        const ch = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
      };
      const ratio = (c1: [number, number, number], c2: [number, number, number]) => {
        const l1 = lum(c1);
        const l2 = lum(c2);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      const bodyBg = parseRgba(getComputedStyle(document.body).backgroundColor);
      const kbd = document.querySelector('kbd');
      let kbdContrast: number | null = null;
      if (kbd) {
        const kbdCs = getComputedStyle(kbd);
        const kbdBg = blendOver(parseRgba(kbdCs.backgroundColor), bodyBg);
        const kbdFg = blendOver(parseRgba(kbdCs.color), kbdBg);
        kbdContrast = ratio(kbdFg, kbdBg);
      }
      return {
        hasDark: document.documentElement.classList.contains('dark'),
        kbdContrast,
      };
    });
    expect(workspaceLightSnap.hasDark).toBe(false);
    if (workspaceLightSnap.kbdContrast !== null) {
      expect(workspaceLightSnap.kbdContrast).toBeGreaterThanOrEqual(4.5);
    }

    // 7. Standalone /kingdom and /status pages also respect stored colorScheme without flash.
    for (const standalonePath of ['/kingdom', '/status']) {
      await page.goto(`${origin}${standalonePath}`);
      await page.waitForLoadState('domcontentloaded');
      const standaloneSnap = await page.evaluate(() => ({
        hasDark: document.documentElement.classList.contains('dark'),
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
      }));
      expect(standaloneSnap.hasDark, `${standalonePath} should not have .dark`).toBe(false);
      expect(standaloneSnap.colorScheme, `${standalonePath} colorScheme should be light`).toBe(
        'light',
      );
    }

    // 8. Switch System -> Dark while OS is still light -> stays dark regardless of OS preference.
    await page.goto(`${origin}/settings/appearance`);
    await colorSchemeCard.waitFor();
    await darkRadio.click();
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
    expect(configStore.config.ui?.colorScheme).toBe('dark');
    expect((await readThemeSnapshot()).colorScheme).toBe('dark');

    // 9. WAI-ARIA radiogroup keyboard navigation: roving tabIndex, ArrowRight/ArrowLeft/Home/End + focus preserved through PATCH.
    expect(await darkRadio.getAttribute('tabindex')).toBe('0');
    expect(await lightRadio.getAttribute('tabindex')).toBe('-1');
    expect(await systemRadio.getAttribute('tabindex')).toBe('-1');

    await darkRadio.focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
    expect(await lightRadio.getAttribute('aria-checked')).toBe('true');
    expect(await lightRadio.getAttribute('tabindex')).toBe('0');
    expect(await darkRadio.getAttribute('tabindex')).toBe('-1');
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-color-scheme')),
    ).toBe('light');

    // ArrowRight moves light -> system; End/Home jump directly; ArrowLeft wraps dark -> system.
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-setting="ui.colorScheme"] button[data-color-scheme="system"]')
          ?.getAttribute('aria-checked') === 'true',
    );
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-color-scheme')),
    ).toBe('system');

    await page.keyboard.press('Home');
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
    expect(await darkRadio.getAttribute('aria-checked')).toBe('true');
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-color-scheme')),
    ).toBe('dark');

    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-setting="ui.colorScheme"] button[data-color-scheme="system"]')
          ?.getAttribute('aria-checked') === 'true',
    );
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-color-scheme')),
    ).toBe('system');

    await page.keyboard.press('Home');
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
    await page.keyboard.press('End');
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-setting="ui.colorScheme"] button[data-color-scheme="system"]')
          ?.getAttribute('aria-checked') === 'true',
    );

    // 10. Cross-tab storage sync updates both DOM and AppearanceSection state (active button + System hint).
    await darkRadio.click();
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
    expect(await colorSchemeCard.locator('.color-scheme-hint').count()).toBe(0);

    await page.evaluate(() => {
      localStorage.setItem('foundry.ui.colorScheme', 'system');
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'foundry.ui.colorScheme',
          oldValue: 'dark',
          newValue: 'system',
        }),
      );
    });
    await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
    expect(await systemRadio.getAttribute('aria-checked')).toBe('true');
    expect(await colorSchemeCard.locator('.color-scheme-hint').innerText()).toContain('Light');

    // 11. Stale localStorage='light' reconciles back to 'dark' when ui.colorScheme is unset in settings.json.
    await configStore.patch('ui', { colorScheme: null });
    expect(configStore.config.ui?.colorScheme).toBeUndefined();
    await page.evaluate(() => {
      localStorage.setItem('foundry.ui.colorScheme', 'light');
    });
    await page.reload();
    await colorSchemeCard.waitFor();
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
    const reconciledSnap = await readThemeSnapshot();
    expect(reconciledSnap.hasDark).toBe(true);
    expect(reconciledSnap.colorScheme).toBe('dark');
    expect(reconciledSnap.stored).toBe('dark');
    expect(await darkRadio.getAttribute('aria-checked')).toBe('true');

    // 12. Safe UI mode (?safe-ui=1) still respects saved colorScheme without breaking.
    await page.goto(`${origin}/settings/appearance?safe-ui=1`);
    await colorSchemeCard.waitFor();
    await lightRadio.click();
    await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
    expect((await readThemeSnapshot()).colorScheme).toBe('light');

    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
});
