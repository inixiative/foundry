import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { completionFixture } from '../helpers/completion-persistence-fixture';

const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

type Row = {
  actor: string;
  turnId?: string;
  output?: unknown;
  terminalSource?: string;
  journalRecord?: { meta?: { turnStatus?: string } };
};

test("a second tab on the thread keeps the first tab's unsaved completion and picks up new ones from storage", async () => {
  const browser = await chromium.launch({ headless: true });
  const fixture = await completionFixture();
  const runtime = fixture.make();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: runtime.fetch,
    websocket: runtime.websocket,
  });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const errors: string[] = [];
  try {
    const url = `http://127.0.0.1:${server.port}/#thread=main`;
    const a = await context.newPage();
    const b = await context.newPage();
    for (const page of [a, b]) page.on('pageerror', (error: Error) => errors.push(error.message));
    // Tab B sees the thread only through its history routes and browser storage: no live stream,
    // and storage events can be held back, so each phase has exactly one way for B to learn of A's row.
    await b.routeWebSocket(/\/ws/, () => {});
    await b.addInitScript(() => {
      const w = window as unknown as { __dropStorage: boolean; __writes: number };
      w.__dropStorage = true;
      w.__writes = 0;
      window.addEventListener(
        'storage',
        (event) => {
          if (w.__dropStorage) event.stopImmediatePropagation();
        },
        true,
      );
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (this === localStorage && key === 'foundry:msgs:main') w.__writes++;
        return set.call(this, key, value);
      };
    });
    const loaded = (page: any) =>
      page.waitForFunction(async () => {
        const s = await import(`${location.origin}/ui/store.js`);
        return s.historyPaging.value.main?.loading === false;
      });
    const memory = (page: any) =>
      page.evaluate(
        async () => (await import(`${location.origin}/ui/store.js`)).messages.value as Row[],
      );
    const stored = (page: any) =>
      page.evaluate(() => JSON.parse(localStorage.getItem('foundry:msgs:main') ?? '[]') as Row[]);
    const send = async (text: string) => {
      const before = (await stored(a)).filter(
        (m) => m.actor === 'agent' && m.terminalSource === 'response',
      ).length;
      await a.locator('.chat-input').fill(text);
      await a.locator('.chat-input').press('Enter');
      await a.waitForFunction(
        (n: number) =>
          JSON.parse(localStorage.getItem('foundry:msgs:main') ?? '[]').filter(
            (m: Row) => m.actor === 'agent' && m.terminalSource === 'response',
          ).length > n,
        before,
      );
      return (await stored(a))
        .filter((m) => m.actor === 'agent' && m.terminalSource === 'response')
        .at(-1)!;
    };

    await a.goto(url);
    await b.goto(url);
    await loaded(a);
    await loaded(b);

    // Phase 1: B never hears of A's completion and writes its own reconciled copy of the thread.
    const first = await send('First unsaved completion');
    expect(first.output).toBe(fixture.output);
    expect((await memory(b)).some((m) => m.turnId === first.turnId)).toBe(false);
    const journal = [
      { actor: 'user', turnId: first.turnId, content: 'First unsaved completion', timestamp: 1 },
      {
        actor: 'agent',
        turnId: first.turnId,
        content: 'Journal outcome unresolved',
        timestamp: 2,
        kind: 'error',
        meta: {
          turnStatus: 'interrupted',
          persistence: 'committed',
          inputEvidence: 'unavailable',
          nativeOutcome: 'unknown',
        },
      },
    ];
    await b.route('**/api/threads/main/history*', (route: any) =>
      route.fulfill({
        json: {
          threadId: 'main',
          source: 'journal',
          messages: journal,
          hasMore: false,
          oldestReached: true,
          nextCursor: null,
        },
      }),
    );
    const writesBefore = await b.evaluate(
      () => (window as unknown as { __writes: number }).__writes,
    );
    await b.evaluate(async () =>
      (await import(`${location.origin}/ui/store.js`)).requestReconcile('main', 0),
    );
    await b.waitForFunction(
      (n: number) => (window as unknown as { __writes: number }).__writes > n,
      writesBefore,
    );
    const kept = (await stored(b)).find((m) => m.actor === 'agent' && m.turnId === first.turnId)!;
    expect(kept.output).toBe(fixture.output);
    expect(kept.terminalSource).toBe('response');
    expect(kept.journalRecord?.meta?.turnStatus).toBe('interrupted');
    expect(
      (await memory(b)).find((m) => m.actor === 'agent' && m.turnId === first.turnId)?.output,
    ).toBe(fixture.output);

    // Phase 2: with storage events delivered, B shows A's next completion without writing or reloading.
    await b.evaluate(() => {
      (window as unknown as { __dropStorage: boolean }).__dropStorage = false;
    });
    const quiet = await b.evaluate(() => (window as unknown as { __writes: number }).__writes);
    const second = await send('Second unsaved completion');
    await b.waitForFunction(
      async (turnId: string) =>
        (await import(`${location.origin}/ui/store.js`)).messages.value.some(
          (m: Row) => m.actor === 'agent' && m.turnId === turnId && m.terminalSource === 'response',
        ),
      second.turnId,
    );
    expect(await b.evaluate(() => (window as unknown as { __writes: number }).__writes)).toBe(
      quiet,
    );
    expect(
      await b
        .locator('.chat-agent > .chat-msg-content')
        .filter({ hasText: fixture.output })
        .count(),
    ).toBe(2);
    expect(
      (await stored(a))
        .filter((m) => m.actor === 'agent' && m.terminalSource === 'response')
        .map((m) => m.turnId),
    ).toEqual([first.turnId, second.turnId]);
    expect(fixture.calls()).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await browser.close();
    server.stop(true);
    fixture.close();
  }
}, 60_000);
