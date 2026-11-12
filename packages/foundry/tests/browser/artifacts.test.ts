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
import {
  ARTIFACT_PHASE,
  type ArtifactInput,
  type ArtifactJournal,
  artifactVersionId,
  recordArtifact,
} from '../../src/tools/thread-record';
import { ConfigStore, defaultAgents, starterConfig } from '../../src/viewer/config';
import { createViewer } from '../../src/viewer/server';
import { until } from '../helpers/live-watch-fixture';
import { type ReleaseStep, releaseAll } from '../helpers/release-all';

const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

/** A page whose script reports what it could reach: it runs, but neither the network nor the viewer. */
const PROBE = `<p id="out">waiting</p><script>
const out = ['ran'];
try { parent.document.body; out.push('parent open'); } catch { out.push('parent isolated'); }
try { localStorage.length; out.push('storage open'); } catch { out.push('storage isolated'); }
fetch('/api/threads').then(() => out.push('fetch open'), () => out.push('fetch blocked'))
  .finally(() => { document.getElementById('out').textContent = out.join(' · '); });
</script>`;

// Artifacts: the agent's set_artifact versions, listed beside Plan and carded on the turn that wrote
// them. Markdown renders; an HTML page runs its scripts in a sandboxed frame that reaches nothing.
test('Artifacts lists versions, cards open them from their turn, and an HTML page runs sandboxed', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-artifacts-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const projects = new ProjectRegistry();
    const project = projects.register({
      id: 'shop',
      label: 'acme-shop',
      path: dir,
      tags: [],
      runtime: 'claude-code',
    });
    const thread = new Thread('shop-1', new ContextStack(), {
      description: 'Sketch the checkout',
      projectId: 'shop',
    });
    project.addThread(thread);

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
    const records = viewer.records.artifacts!;
    store.beginTurn(thread, 'turn-1', 'Draw the checkout page');
    store.completeTurn(
      thread,
      'turn-1',
      'Here it is.',
      {},
      {
        id: 'trace-1',
        messageId: 'turn-1',
        startedAt: 1,
        root: {},
        summary: {},
        spans: [],
      },
    );

    // Written as during turn 1 (the viewer's own journal writes the running turn's id, none here).
    const duringTurn: ArtifactJournal = {
      write(target, record) {
        store.appendPhase(target, {
          id: artifactVersionId(target.id, record.id, record.version),
          phase: ARTIFACT_PHASE,
          turnId: 'turn-1',
          dispatchId: null,
          record: record as unknown as Record<string, unknown>,
        });
        return { turnId: 'turn-1' };
      },
    };
    const save = (input: ArtifactInput, journal: ArtifactJournal = records) =>
      recordArtifact(thread, input, journal, records.latest(thread.id, input.id));
    save({
      id: 'notes',
      title: 'Checkout notes',
      kind: 'markdown',
      content: '# Retries\n\nCap at **three**.',
    });
    const page1 = { id: 'page', title: 'Checkout page', kind: 'html' as const, content: PROBE };
    save(page1, duringTurn);
    expect(save(page1, duringTurn).written).toBe(false);
    save({ ...page1, content: '<h1 id="v2">Second draft</h1>' }, duringTurn);
    expect(thread.meta.artifacts!.find((a) => a.id === 'page')!.versions).toHaveLength(2);

    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: viewer.fetch,
      websocket: viewer.websocket,
    });
    cleanup.unshift(['server', () => server.stop(true)]);
    const base = `http://127.0.0.1:${server.port}`;

    // The route serves every version of an artifact the thread lists, and nothing else.
    const read = await (await fetch(`${base}/api/threads/shop-1/artifacts/page`)).json();
    expect(
      read.versions.map((v: { version: number; turnId: string }) => [v.version, v.turnId]),
    ).toEqual([
      [1, 'turn-1'],
      [2, 'turn-1'],
    ]);
    expect((await fetch(`${base}/api/threads/shop-1/artifacts/nope`)).status).toBe(404);
    // A request from the sandboxed frame carries an opaque origin; the API refuses it.
    expect(
      (await fetch(`${base}/api/threads/shop-1/artifacts/page`, { headers: { origin: 'null' } }))
        .status,
    ).toBe(403);

    const browser = await chromium.launch({ headless: true });
    cleanup.unshift(['browser', () => browser.close()]);
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));

    await page.goto(`${base}/#thread=shop-1`);
    await page.locator('.context-bar-title', { hasText: 'Sketch the checkout' }).waitFor();

    // The turn that wrote the page carries a card per version; notes (no turn) carries none.
    const cards = page.locator('[data-turn-id="turn-1"][data-actor="agent"] .artifact-card');
    await cards.first().waitFor();
    expect(await cards.allInnerTexts()).toEqual(
      expect.arrayContaining([expect.stringContaining('Checkout page')]),
    );
    expect(await cards.count()).toBe(2);
    expect(await page.locator('.artifact-card', { hasText: 'Checkout notes' }).count()).toBe(0);

    // A card opens Artifacts on its version; the page's script runs but reaches nothing.
    await cards.filter({ hasText: 'v1' }).click();
    await page.locator('.center-view--active', { hasText: 'Artifacts' }).waitFor();
    const viewerPane = page.locator('.artifact-viewer[data-artifact="page"]');
    expect(await viewerPane.locator('.artifact-version').inputValue()).toBe('1');
    expect(await viewerPane.locator('iframe.artifact-frame').getAttribute('sandbox')).toBe(
      'allow-scripts',
    );
    const probe = page.frameLocator('iframe.artifact-frame').locator('#out');
    await until(async () => (await probe.innerText()) !== 'waiting', 'the page script reports');
    expect(await probe.innerText()).toBe(
      'ran · parent isolated · storage isolated · fetch blocked',
    );

    // The picker moves to the latest version.
    await viewerPane.locator('.artifact-version').selectOption('2');
    await page.frameLocator('iframe.artifact-frame').locator('#v2').waitFor();

    // The list, newest first; a Markdown artifact renders as Markdown.
    expect(await page.locator('.artifact-item-title').allInnerTexts()).toEqual([
      'Checkout page',
      'Checkout notes',
    ]);
    await page.locator('.artifact-item', { hasText: 'Checkout notes' }).click();
    await page
      .locator('.artifact-viewer[data-artifact="notes"] .md h1', { hasText: 'Retries' })
      .waitFor();
    await page
      .locator('.artifact-viewer[data-artifact="notes"] .md strong', { hasText: 'three' })
      .waitFor();
    expect(errors).toEqual([]);
  } finally {
    const failures = await releaseAll(cleanup);
    expect(failures).toEqual([]);
  }
}, 120_000);
