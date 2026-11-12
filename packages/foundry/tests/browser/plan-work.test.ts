import '../helpers/isolate-archive';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextStack,
  EventStream,
  Harness,
  InterventionLog,
  type NativeEvidence,
  Thread,
  TokenTracker,
} from '@inixiative/foundry-core';
import { ProjectRegistry } from '../../src/agents/project';
import { ConfigStore, defaultAgents, starterConfig } from '../../src/viewer/config';
import { createViewer } from '../../src/viewer/server';
import { until } from '../helpers/live-watch-fixture';
import { type ReleaseStep, releaseAll } from '../helpers/release-all';

const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

function git(cwd: string, ...args: string[]) {
  const run = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
    },
  });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
}

const use = (toolName: string, toolInput: Record<string, unknown>) =>
  ({
    schema: 1,
    nativeOutcome: 'unknown',
    kind: 'tool_use',
    toolName,
    toolInput,
  }) as NativeEvidence;

const todos = (items: Array<[string, string]>) =>
  use('TodoWrite', { todos: items.map(([content, status]) => ({ content, status })) });

// Plan: About, then the agent's own plan as a checklist (status, the turn it got there, a child thread
// nested under the step that spawned it), a turn link that opens Thread on that turn. Work: the files
// the turns wrote, the branch's commits, artifacts and Signets.
test('Plan shows the about and the checklist, a step opens its turn; Work shows files, commits, artifacts, Signets', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-plan-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'fix/checkout');
    writeFileSync(join(repo, 'b.txt'), 'b');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'Cap retries at three');

    const projects = new ProjectRegistry();
    const project = projects.register({
      id: 'shop',
      label: 'acme-shop',
      path: repo,
      tags: [],
      runtime: 'claude-code',
    });
    const thread = new Thread('shop-1', new ContextStack(), {
      description: 'Checkout errors since 2:02',
      projectId: 'shop',
    });
    thread.meta.cwd = repo;
    const child = new Thread('shop-2', new ContextStack(), {
      description: 'Find the callers',
      projectId: 'shop',
      parentThreadId: 'shop-1',
    });
    child.meta.parentTurnId = 'turn-1';
    project.addThread(thread);
    project.addThread(child);

    const configStore = new ConfigStore(dir);
    const config = starterConfig('controlled', 'controlled');
    config.agents = defaultAgents();
    config.setupComplete = true;
    await configStore.save(config);
    const viewer = createViewer({
      harness: new Harness(new Thread('main', new ContextStack(), { description: 'Global' })),
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      tokenTracker: new TokenTracker(),
      configStore,
      configDir: dir,
      projectRegistry: projects,
    });
    cleanup.unshift(['store', () => viewer.localStore?.close()]);
    const store = viewer.localStore!;
    const turn = (id: string, ask: string, history: NativeEvidence[], at: number) => {
      store.beginTurn(thread, id, ask);
      store.completeTurn(
        thread,
        id,
        `Done: ${ask}`,
        { nativeHistory: history },
        { id: `trace-${id}`, messageId: id, startedAt: at, root: {}, summary: {}, spans: [] },
      );
    };
    turn(
      'turn-1',
      'Find why checkout fails',
      [
        todos([
          ['Survey the callers', 'in_progress'],
          ['Cap the retries', 'pending'],
        ]),
      ],
      1,
    );
    turn(
      'turn-2',
      'Cap them',
      [
        todos([
          ['Survey the callers', 'completed'],
          ['Cap the retries', 'in_progress'],
        ]),
        use('Edit', { file_path: 'src/checkout/retry.ts', old_string: '5', new_string: '3' }),
      ],
      2,
    );

    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: viewer.fetch,
      websocket: viewer.websocket,
    });
    cleanup.unshift(['server', () => server.stop(true)]);
    const browser = await chromium.launch({ headless: true });
    cleanup.unshift(['browser', () => browser.close()]);
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));

    await page.goto(`http://127.0.0.1:${server.port}/#thread=shop-1`);
    await page.locator('.context-bar-title', { hasText: 'Checkout errors since 2:02' }).waitFor();

    // Plan (key 2): About, then the checklist.
    await page.keyboard.press('Alt+Digit2');
    const plan = page.locator('.plan');
    await plan.locator('.plan-about').waitFor();
    await plan.locator('.plan-section-head', { hasText: '1 of 2 done' }).waitFor();
    // Plan is the what and why: five sections, and a link to the Loop for the how.
    expect(await plan.locator('.plan-section-head h3').allInnerTexts()).toEqual([
      'About',
      'Your outcomes',
      'Pain and friction',
      'Strategy',
      'Reasons',
      'Technical plan',
    ]);
    await plan.getByRole('button', { name: /The Loop is how/ }).waitFor();
    const survey = plan.locator('.plan-step', { hasText: 'Survey the callers' });
    expect(await survey.getAttribute('data-state')).toBe('done');
    expect(await survey.locator('.plan-when').first().innerText()).toBe('t2');
    expect(
      await plan.locator('.plan-step', { hasText: 'Cap the retries' }).getAttribute('data-state'),
    ).toBe('working');
    // The child thread spawned on turn 1 nests under the step in progress then.
    await survey.locator('.plan-child', { hasText: 'Find the callers' }).waitFor();
    // Stage chips sit above the checklist, the current one marked "now".
    await plan.locator('.lifecycle-step.is-current', { hasText: '· now' }).waitFor();
    expect(
      await plan.evaluate(
        (el: Element) =>
          !!(
            el
              .querySelector('.plan-lifecycle')!
              .compareDocumentPosition(el.querySelector('.plan-checklist')!) &
            Node.DOCUMENT_POSITION_FOLLOWING
          ),
      ),
    ).toBe(true);

    // A step's turn opens Thread on that turn.
    await survey.locator('.plan-when').first().click();
    await page.locator('.center-views .center-view--active', { hasText: 'Thread' }).waitFor();
    await until(
      async () => (await page.locator('[data-turn-id="turn-2"].chat-msg--focused').count()) > 0,
      'turn 2 focused',
    );

    // Work lives in the right panel (its first tab): four sections; the file the turn wrote and the commit.
    expect(await page.locator('.center-view', { hasText: 'Work' }).count()).toBe(0);
    await page.locator('.rp-tab', { hasText: 'Work' }).click();
    const work = page.locator('.right-panel .work');
    for (const title of ['File changes', 'Commits', 'Pull requests and turns', 'Signets'])
      await work.locator('.rp-section-title', { hasText: title }).waitFor();
    await work.locator('.work-file', { hasText: 'src/checkout/retry.ts' }).waitFor();
    await work.locator('.work-commit', { hasText: 'Cap retries at three' }).waitFor();
    await work
      .locator('.work-section', { hasText: 'No Signet is in use on this thread.' })
      .waitFor();
    // Larger steps the panel wider for diffs (normal → wide, then no larger); smaller steps back.
    const width = () =>
      page.locator('.panel-right').evaluate((el: Element) => el.getBoundingClientRect().width);
    const normal = await width();
    const larger = page.getByRole('button', { name: 'Make the right panel larger' });
    await larger.click();
    await page.waitForFunction(
      (n: number) =>
        (document.querySelector('.panel-right')?.getBoundingClientRect().width ?? 0) > n,
      normal,
    );
    await page.waitForFunction(() => location.hash.includes('rsize=wide'));
    expect(await larger.count()).toBe(0);
    const smaller = page.getByRole('button', { name: 'Make the right panel smaller' });
    await smaller.click();
    await page.waitForFunction(
      (n: number) =>
        Math.round(document.querySelector('.panel-right')?.getBoundingClientRect().width ?? 0) ===
        Math.round(n),
      normal,
    );
    expect(page.url()).not.toContain('rsize=');
    expect(errors).toEqual([]);
  } finally {
    const failures = await releaseAll(cleanup);
    expect(failures).toEqual([]);
  }
}, 120_000);
