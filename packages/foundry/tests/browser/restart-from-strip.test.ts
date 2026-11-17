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
import { decisionPressureActivity } from '../../src/viewer/system-activity';
import { type ReleaseStep, releaseAll } from '../helpers/release-all';

// Aron, 2026-11-16: "Wardens stopped answering until Foundry restarts" gets a Restart beside it;
// restarting counts its blockers, and Foundry restarts once they are done.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

test('Restart on the Wardens-stopped row restarts Foundry once nothing blocks it', async () => {
  const cleanup: ReleaseStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'foundry-restart-strip-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  try {
    const eventStream = new EventStream();
    const viewer = await startViewer({
      port: 0,
      configDir: dir,
      localStore: null,
      harness: new Harness(new Thread('main', new ContextStack())),
      eventStream,
      interventions: new InterventionLog(),
      tokenTracker: new TokenTracker(),
      projectRegistry: new ProjectRegistry(),
    });
    cleanup.unshift(['viewer', () => viewer.server.stop(true)]);
    const restarts: number[] = [];
    viewer.restartRoll.acceptSupervisorRestart(() => restarts.push(1));
    eventStream.pushActivity(
      decisionPressureActivity({ kind: 'closed', reason: 'a decision run could not be closed' }),
    );
    const origin = `http://127.0.0.1:${viewer.server.port}`;
    await fetch(`${origin}/api/setup/complete`, { method: 'POST' });
    const browser = await chromium.launch({ headless: true });
    cleanup.unshift(['browser', () => browser.close()]);
    const page = await (
      await browser.newContext({ viewport: { width: 1600, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));

    await page.goto(`${origin}/#thread=main`);
    const row = page.locator('.system-strip-row[data-key="decisions:admission"]');
    await row.filter({ hasText: 'Wardens stopped answering until Foundry restarts.' }).waitFor();
    await row.getByRole('button', { name: 'Restart' }).click();
    // Nothing running: no blockers, so it restarts at once.
    for (let i = 0; i < 100 && restarts.length === 0; i++) await Bun.sleep(20);
    expect(restarts).toEqual([1]);
    await row.locator('[data-restart-blockers]').filter({ hasText: 'Restarting…' }).waitFor();
    expect(errors).toEqual([]);
  } finally {
    await releaseAll(cleanup);
  }
}, 60_000);
