import '../helpers/isolate-archive';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActionQueue,
  ContextStack,
  EventStream,
  Harness,
  InterventionLog,
  Thread,
  TokenTracker,
} from '@inixiative/foundry-core';
import { ProjectRegistry } from '../../src/agents/project';
import { draftAsk } from '../../src/scheduler/draft-asks';
import { ConfigStore, defaultAgents, starterConfig } from '../../src/viewer/config';
import { createViewer } from '../../src/viewer/server';
import { type ReleaseStep, releaseAll } from '../helpers/release-all';

const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

// The Scheduled rail (Aron, 11-14: "I should be able to go see past runs of the schedule"): schedules
// by Where, an agent's draft counted on the tab until accepted, a schedule's past runs each opening
// its thread, the run thread's "scheduled ·" pill opening the schedule back, pause and resume, and
// + New schedule making one the owner can remove.
test('the Scheduled rail lists schedules, their past runs, drafts to accept, and makes new ones', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-schedules-'));
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
    const dueAt = Date.UTC(2026, 10, 13, 9, 0);
    // A past run of the morning triage, and the thread that proposed the cleanup draft.
    const run = new Thread('triage-run', new ContextStack(), {
      description: 'Morning triage · Nov 13',
      projectId: 'shop',
    });
    run.meta.status = 'idle';
    run.meta.scheduledBy = {
      scheduleId: 'morning-triage',
      runId: `schedule:morning-triage:${dueAt}`,
      dueAt,
    };
    project.addThread(run);
    const proposer = new Thread('proposer', new ContextStack(), {
      description: 'Feedback sweep',
      projectId: 'shop',
    });
    proposer.meta.status = 'idle';
    project.addThread(proposer);

    const queue = new ActionQueue();
    const configStore = new ConfigStore(dir);
    const config = starterConfig('controlled', 'controlled');
    config.agents = defaultAgents();
    config.setupComplete = true;
    config.scheduler = {
      schedules: [
        {
          id: 'morning-triage',
          name: 'Morning triage',
          prompt: 'Scheduled run: triage the overnight errors and summarise them.',
          when: { every: '1d' },
          since: Date.now(),
        },
        {
          id: 'inbox-sweep',
          name: 'Weekly inbox sweep',
          prompt: 'Scheduled run: archive answered feedback.',
          when: { cron: '0 9 * * 1', tz: 'UTC' },
          scope: 'feedback',
          since: Date.now(),
          draft: { threadId: 'proposer' },
        },
      ],
    };
    await configStore.save(config);
    const viewer = createViewer({
      harness: new Harness(new Thread('main', new ContextStack(), { description: 'Global' })),
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      tokenTracker: new TokenTracker(),
      configStore,
      configDir: dir,
      projectRegistry: projects,
      actionQueue: queue,
    });
    cleanup.unshift(['store', () => viewer.localStore?.close()]);
    // Starting the socket asks the proposer about its draft, as the daemon does at start.
    viewer.startSocket();
    cleanup.unshift(['socket', () => viewer.stopSocket()]);
    const store = viewer.localStore;
    if (!store) throw Error('the viewer has no journal store');
    const runId = `schedule:morning-triage:${dueAt}`;
    store.claimScheduleRun({ id: runId, scheduleId: 'morning-triage', dueAt, manual: false });
    store.settleScheduleRun(runId, 'started', { threadId: 'triage-run' });
    const skipped = `schedule:morning-triage:${dueAt + 86_400_000}`;
    store.claimScheduleRun({
      id: skipped,
      scheduleId: 'morning-triage',
      dueAt: dueAt + 86_400_000,
      manual: false,
    });
    store.settleScheduleRun(skipped, 'skipped', { reason: 'the previous run was still working' });

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
    page.on('dialog', (d: { accept(): Promise<void> }) => d.accept());

    // The proposing thread asks Accept or Reject, as a structural prompt on its own conversation.
    await page.goto(`http://127.0.0.1:${server.port}/#thread=proposer`);
    await page
      .locator('.prompt-card-message', { hasText: draftAsk('Weekly inbox sweep') })
      .waitFor();
    const draftPrompts = () => queue.pending().filter((p) => p.meta?.scheduleDraft);
    expect(draftPrompts().map((p) => p.threadId)).toEqual(['proposer']);
    await page.goto(`http://127.0.0.1:${server.port}/#thread=main`);
    // The draft is counted on the Scheduled tab.
    const tab = page.locator('.rail-toggle-btn', { hasText: 'Scheduled' });
    await tab.locator('.rail-toggle-badge', { hasText: '1' }).waitFor();
    await tab.click();
    const pane = page.locator('.rail-pane[aria-label="Schedules"]');
    expect(
      await pane
        .locator('.schedule-group-head')
        .evaluateAll((els: Element[]) => els.map((e) => e.textContent)),
    ).toEqual(['Global', 'Feedback']);
    const triage = pane.locator('.schedule[data-schedule="morning-triage"]');
    const sweep = pane.locator('.schedule[data-schedule="inbox-sweep"]');
    expect(await triage.locator('.schedule-state').getAttribute('data-state')).toBe('on');
    expect(await triage.locator('.schedule-state').innerText()).toStartWith('next ');
    await triage.locator('.schedule-last', { hasText: 'last skipped' }).waitFor();
    expect(await sweep.locator('.schedule-state').innerText()).toBe('draft · waits for you');

    // Open the triage: its prompt and past runs, newest first, each run's thread one click away.
    await triage.locator('.tree-node').click();
    await triage.locator('.schedule-prompt', { hasText: 'triage the overnight errors' }).waitFor();
    const runs = triage.locator('.schedule-runs li');
    await runs.first().waitFor();
    expect(
      await runs.evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('data-outcome'))),
    ).toEqual(['skipped', 'started']);
    await runs.first().locator('.schedule-run-reason', { hasText: 'still working' }).waitFor();
    await runs.nth(1).locator('.schedule-link', { hasText: 'open thread' }).click();
    await page.waitForFunction(() => location.hash.includes('thread=triage-run'));
    // The run thread's pill opens its schedule back in the rail.
    const pill = page.locator('.band-pill', { hasText: 'scheduled ·' });
    await pill.locator('b', { hasText: 'Morning triage' }).waitFor();
    await page.locator('.rail-toggle-btn', { hasText: 'Open' }).click();
    await pill.click();
    await page.locator('.rail-toggle-btn.is-active', { hasText: 'Scheduled' }).waitFor();
    await triage.locator('.schedule-detail').waitFor();

    // Pause, then resume.
    await triage.locator('.schedule-actions button', { hasText: 'Pause' }).click();
    await triage.locator('.schedule-state[data-state="paused"]').waitFor();
    await triage.locator('.schedule-actions button', { hasText: 'Resume' }).click();
    await triage.locator('.schedule-state[data-state="on"]').waitFor();
    expect(configStore.config.scheduler?.schedules?.[0]?.paused).toBeUndefined();

    // The draft: no Run now or Pause, only Accept, Edit, Reject. Accepting clears the tab's count
    // and withdraws the proposing thread's prompt.
    await sweep.locator('.tree-node').click();
    await sweep.locator('.schedule-draft-note').waitFor();
    expect(
      await sweep
        .locator('.schedule-actions button')
        .evaluateAll((els: Element[]) => els.map((e) => (e as HTMLElement).innerText)),
    ).toEqual(['Accept', 'Edit', 'Reject']);
    await sweep.locator('.schedule-actions button', { hasText: 'Accept' }).click();
    await sweep.locator('.schedule-state[data-state="on"]').waitFor();
    expect(await tab.locator('.rail-toggle-badge').count()).toBe(0);
    for (let i = 0; i < 50 && draftPrompts().length > 0; i++) await Bun.sleep(20);
    expect(draftPrompts()).toEqual([]);
    expect(proposer.meta.agentStatus).toBeUndefined();
    expect(
      configStore.config.scheduler?.schedules?.find((s) => s.id === 'inbox-sweep')?.draft,
    ).toBeUndefined();

    // + New schedule: the list's full-width first row; a once-only Global schedule, then remove it.
    const newSchedule = pane.locator('.rail-frame > .rail-new-thread--block', {
      hasText: '+ New schedule',
    });
    expect(await newSchedule.count()).toBe(1);
    await newSchedule.click();
    expect(await newSchedule.count()).toBe(0);
    const form = pane.locator('form[aria-label="New schedule"]');
    await form.locator('label', { hasText: 'Name' }).locator('input').fill('Release notes');
    await form
      .locator('label', { hasText: 'Prompt' })
      .locator('textarea')
      .fill('Scheduled run: draft the release notes.');
    await form.locator('label', { hasText: 'When' }).locator('select').selectOption('at');
    await form.locator('input[type="datetime-local"]').fill('2027-01-04T09:00');
    await form.locator('button[type="submit"]').click();
    const created = pane.locator('.schedule[data-schedule="release-notes"]');
    await created.locator('.row-project', { hasText: 'once,' }).waitFor();
    expect(await pane.locator('form').count()).toBe(0);
    await created.locator('.schedule-detail').waitFor();
    expect(
      configStore.config.scheduler?.schedules?.find((s) => s.id === 'release-notes')?.when,
    ).toEqual({
      at: await page.evaluate(() => new Date('2027-01-04T09:00').toISOString()),
    });
    await created.locator('.schedule-actions button', { hasText: 'Remove' }).click();
    await created.waitFor({ state: 'detached' });
    expect(configStore.config.scheduler?.schedules?.map((s) => s.id)).toEqual([
      'morning-triage',
      'inbox-sweep',
    ]);
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 60_000);
