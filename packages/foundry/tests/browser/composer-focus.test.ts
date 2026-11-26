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
import { startViewer } from '../../src/viewer/server';
import { type ReleaseStep, releaseAll } from '../helpers/release-all';

// Aron 11-02: "If there's a thread message box on the screen, it should always be in focus, unless
// something else is actually holding the focus: a place to type." Clicking a row, a tab, the right
// panel or a Board card leaves focus in the message box; plain letters are typed, never commands
// (those are ⌥ chords); a real place to type (Search) holds focus and hands it back when it closes.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

test('typing always lands in the message box after clicking around', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-composer-focus-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const viewer = await startViewer({
      port: 0,
      configDir: dir,
      localStore: null,
      harness: new Harness(new Thread('main', new ContextStack())),
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      tokenTracker: new TokenTracker(),
      projectRegistry: new ProjectRegistry(),
    });
    cleanup.unshift(['viewer', () => viewer.server.stop(true)]);
    const origin = `http://127.0.0.1:${viewer.server.port}`;
    await fetch(`${origin}/api/setup/complete`, { method: 'POST' });
    // A second thread, so the Board has a card to click.
    const made = await fetch(`${origin}/api/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'Cap checkout retries' }),
    });
    expect(made.status).toBe(201);
    const browser = await chromium.launch({ headless: true });
    cleanup.unshift(['browser', () => browser.close()]);
    const page = await (
      await browser.newContext({ viewport: { width: 1600, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));

    await page.goto(`${origin}/#thread=main&detail=1`);
    const box = page.locator('.panel-center textarea.chat-input');
    await box.waitFor();
    let typed = '';
    const typeAfter = async (what: string, click: () => Promise<unknown>) => {
      await click();
      await page.keyboard.type(what);
      typed += what;
      await page.waitForFunction(
        (want: string) =>
          (document.querySelector('.panel-center textarea.chat-input') as HTMLTextAreaElement)
            ?.value === want,
        typed,
      );
      expect({
        after: what,
        focused: await box.evaluate((el: Element) => el === document.activeElement),
      }).toEqual({
        after: what,
        focused: true,
      });
    };

    // A thread row in the left list.
    await typeAfter('row ', () => page.locator('.tree-node').first().click());
    // A right-panel tab, and the panel's body.
    await typeAfter('tab ', () =>
      page.locator('.rp-strip-tab, .rp-tab', { hasText: 'Context' }).first().click(),
    );
    await typeAfter('panel ', () => page.locator('.right-panel .rp-section-title').first().click());
    // Plain letters are typed, never commands: b would open the Board.
    await typeAfter('b ', async () => {});
    expect(await page.locator('.board').count()).toBe(0);

    // A Board card: ⌥B opens the Board, its card opens the thread, and typing lands in its box.
    await page.keyboard.press('Alt+KeyB');
    // An idle thread is quiet: show the quiet ones.
    await page.getByRole('button', { name: /Show quiet/ }).click();
    const card = page.locator('.board-card', { hasText: 'Cap checkout retries' });
    await card.waitFor();
    await card.locator('.board-card-title').click();
    await page.locator('.context-bar-title', { hasText: 'Cap checkout retries' }).waitFor();
    // Each thread keeps its own draft: this one starts empty.
    typed = '';
    await typeAfter('card', async () => {});

    // A real place to type holds focus while in use, and hands it back when it closes.
    await page.keyboard.press('Alt+Shift+KeyF');
    const search = page.locator('.search-page input.search-input');
    await search.waitFor();
    await page.waitForFunction(() => document.activeElement?.matches('input.search-input'));
    await page.keyboard.type('xyz');
    expect(await search.inputValue()).toBe('xyz');
    await page.keyboard.press('Escape');
    await box.waitFor();
    await page.waitForFunction(() =>
      document.activeElement?.matches('.panel-center textarea.chat-input'),
    );
    // The draft comes back with it.
    for (let i = 0; i < 50 && (await box.inputValue()) !== typed; i++)
      await page.waitForTimeout(100);
    expect(await box.inputValue()).toBe(typed);
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 120_000);

// Aron 11-14: "it frequently doesn't paste my Wispr chats." Wispr Flow pastes its dictation with ⌘V
// into whatever holds focus; with the page itself focused (just opened, back from another app, after
// selecting transcript text) the paste was dropped. Every paste outside a text field lands in the box.
test('a paste anywhere but a text field lands in the message box', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-composer-paste-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const viewer = await startViewer({
      port: 0,
      configDir: dir,
      localStore: null,
      harness: new Harness(new Thread('main', new ContextStack())),
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      tokenTracker: new TokenTracker(),
      projectRegistry: new ProjectRegistry(),
    });
    cleanup.unshift(['viewer', () => viewer.server.stop(true)]);
    const origin = `http://127.0.0.1:${viewer.server.port}`;
    await fetch(`${origin}/api/setup/complete`, { method: 'POST' });
    const browser = await chromium.launch({ headless: true });
    cleanup.unshift(['browser', () => browser.close()]);
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));

    await page.goto(`${origin}/#thread=main&detail=1`);
    const box = page.locator('.panel-center textarea.chat-input');
    await box.waitFor();
    const focused = () =>
      page.evaluate(() => document.activeElement?.matches('.panel-center textarea.chat-input'));
    // The app opens with focus in the message box.
    await page.waitForFunction(() =>
      document.activeElement?.matches('.panel-center textarea.chat-input'),
    );

    const clip = (text: string) =>
      page.evaluate((t: string) => navigator.clipboard.writeText(t), text);
    const blurAll = () => page.evaluate(() => (document.activeElement as HTMLElement)?.blur());

    // ⌘V with the page itself focused (what Wispr sends) lands in the box.
    await clip('one ');
    await blurAll();
    await page.keyboard.press('ControlOrMeta+v');
    await page.waitForFunction(
      () =>
        (document.querySelector('.panel-center textarea.chat-input') as HTMLTextAreaElement)
          .value === 'one ',
    );
    expect(await focused()).toBe(true);

    // With transcript text selected too.
    await page.evaluate(() => {
      const target = document.querySelector('.context-bar-title') ?? document.body;
      getSelection()?.selectAllChildren(target);
    });
    await blurAll();
    await clip('two ');
    await page.keyboard.press('ControlOrMeta+v');
    await page.waitForFunction(
      () =>
        (document.querySelector('.panel-center textarea.chat-input') as HTMLTextAreaElement)
          .value === 'one two ',
    );

    // A paste that arrives without its key (the Edit menu) is put in the box as well.
    await blurAll();
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData('text/plain', 'three');
      document.body.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    });
    expect(await box.inputValue()).toBe('one two three');
    expect(await focused()).toBe(true);

    // An image pasted that way goes to the box's own image handling.
    await blurAll();
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(
        new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' }),
      );
      document.body.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    });
    await page.locator('.composer-images').waitFor();
    expect(await box.inputValue()).toBe('one two three');

    // A select, once set, hands focus back instead of taking the next letters.
    await page.evaluate(() => {
      getSelection()?.removeAllRanges();
      const select = document.createElement('select');
      select.id = 'probe-select';
      select.innerHTML = '<option>a</option><option>b</option>';
      document.querySelector('.panel-center')?.append(select);
    });
    await page.selectOption('#probe-select', 'b');
    await page.waitForFunction(() =>
      document.activeElement?.matches('.panel-center textarea.chat-input'),
    );

    // A field inside an artifact's page keeps focus when the tab comes back.
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.id = 'probe-frame';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.srcdoc = '<input id="inner">';
      document.querySelector('.panel-center')?.append(frame);
    });
    await page.frameLocator('#probe-frame').locator('#inner').click();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('probe-frame');
    await page.evaluate(() => {
      document.getElementById('probe-frame')?.remove();
      document.getElementById('probe-select')?.remove();
    });

    // Coming back to the window puts focus back in the box.
    // Removing the focused frame leaves the window unfocused; take it back as a person would.
    await page.locator('.context-bar-title').click();
    await blurAll();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() =>
      document.activeElement?.matches('.panel-center textarea.chat-input'),
    );

    // A real text field keeps its own paste: Search takes it, the box is untouched.
    await page.keyboard.press('Alt+Shift+KeyF');
    const search = page.locator('.search-page input.search-input');
    await search.waitFor();
    await page.waitForFunction(() => document.activeElement?.matches('input.search-input'));
    await clip('query');
    await page.keyboard.press('ControlOrMeta+v');
    await page.waitForFunction(
      () => (document.querySelector('input.search-input') as HTMLInputElement)?.value === 'query',
    );
    await page.keyboard.press('Escape');
    await box.waitFor();
    await page.waitForFunction(() =>
      document.activeElement?.matches('.panel-center textarea.chat-input'),
    );
    expect(await box.inputValue()).toBe('one two three');
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 120_000);

// Aron 11-26: "pasting is still hit or miss." Wispr Flow only inserts into a focused text field; with
// none it offers Copy and never sends ⌘V, so rerouting the paste can't save it. Focus has to rest in
// the box after anything that took it without being a place to type.
test('focus comes back to the message box after a press, a blur, a copy or an artifact click', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-composer-rest-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const viewer = await startViewer({
      port: 0,
      configDir: dir,
      localStore: null,
      harness: new Harness(new Thread('main', new ContextStack())),
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      tokenTracker: new TokenTracker(),
      projectRegistry: new ProjectRegistry(),
    });
    cleanup.unshift(['viewer', () => viewer.server.stop(true)]);
    const origin = `http://127.0.0.1:${viewer.server.port}`;
    await fetch(`${origin}/api/setup/complete`, { method: 'POST' });
    const browser = await chromium.launch({ headless: true });
    cleanup.unshift(['browser', () => browser.close()]);
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));

    await page.goto(`${origin}/#thread=main&detail=1`);
    await page.locator('.panel-center textarea.chat-input').waitFor();
    const inBox = () =>
      page.waitForFunction(() =>
        document.activeElement?.matches('.panel-center textarea.chat-input'),
      );
    await inBox();

    // The box losing focus to nothing takes it back.
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await inBox();

    // A press that ends without a click (a drag across the transcript) hands focus back.
    const title = await page.locator('.context-bar-title').boundingBox();
    if (!title) throw new Error('no context bar title');
    await page.mouse.move(title.x + title.width + 40, title.y + 4);
    await page.mouse.down();
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.mouse.move(title.x + title.width + 80, title.y + 40);
    await page.waitForTimeout(150);
    // Focus waits while the button is down: a selection may be starting.
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await page.mouse.up();
    await inBox();

    // Transcript text selected and copied: once on the clipboard, focus goes back to the box.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      getSelection()?.selectAllChildren(
        document.querySelector('.context-bar-title') ?? document.body,
      );
    });
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await page.keyboard.press('ControlOrMeta+c');
    await inBox();

    // An artifact's page: one of its fields keeps focus; a click elsewhere in it hands focus back.
    await page.evaluate(async () => {
      getSelection()?.removeAllRanges();
      // The viewer's own module, so the page is built exactly as an artifact's is.
      const viewerModule = '/ui/artifacts.js';
      const { artifactDocument }: { artifactDocument: (content: string) => string } = await import(
        viewerModule
      );
      const frame = document.createElement('iframe');
      frame.id = 'probe-artifact';
      frame.className = 'artifact-frame';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.style.cssText = 'width:400px;height:200px';
      frame.srcdoc = artifactDocument(
        '<input id="inner"><p id="text" style="height:120px">A page to click.</p>',
      );
      document.querySelector('.panel-center')?.append(frame);
    });
    const inner = page.frameLocator('#probe-artifact');
    await inner.locator('#inner').click();
    await page.keyboard.type('kept');
    expect(await inner.locator('#inner').inputValue()).toBe('kept');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('probe-artifact');
    await inner.locator('#text').click();
    await inBox();
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 120_000);
