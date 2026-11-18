import './helpers/isolate-archive';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextStack,
  callOutcomeLabel,
  EventStream,
  Harness,
  InterventionLog,
  Thread,
} from '@inixiative/foundry-core';
import { createViewer } from '../src/viewer/server';

test("the viewer serves core's call-outcome module, and the browser reads outcomes with it", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-call-outcome-core-'));
  const viewer = createViewer({
    harness: new Harness(new Thread('main', new ContextStack())),
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    configDir: dir,
  });
  try {
    const response = await viewer.app.request('/ui/call-outcome-core.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/javascript');
    const source = await response.text();
    const served = (await import(
      `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
    )) as { callOutcomeLabel: typeof callOutcomeLabel };
    for (const outcome of [
      { status: 'not-sent', cause: 'over-budget' },
      { status: 'failed', cause: 'timeout' },
      { status: 'answered', result: 'spoke' },
    ] as const)
      expect(served.callOutcomeLabel(outcome)).toBe(callOutcomeLabel(outcome));
  } finally {
    await viewer.analyticsReady.catch(() => {});
    viewer.localStore?.close();
    rmSync(dir, { force: true, recursive: true });
  }
});
