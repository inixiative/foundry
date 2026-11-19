import './helpers/isolate-archive';
import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextStack,
  EventStream,
  Harness,
  InterventionLog,
  Thread,
} from '@inixiative/foundry-core';
import { createViewer } from '../src/viewer/server';

test('a route that fails logs one line naming the route and answers 500 with the message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-route-errors-'));
  const viewer = createViewer({
    harness: new Harness(new Thread('main', new ContextStack())),
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    configDir: dir,
  });
  const logged = spyOn(console, 'error').mockImplementation(() => {});
  try {
    viewer.app.post('/api/test-cyclic', (c) => {
      const node: Record<string, unknown> = {};
      node.self = node;
      return c.json(node);
    });
    const response = await viewer.app.request('/api/test-cyclic', { method: 'POST' });
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toContain('cyclic');
    expect(logged.mock.calls.map((call) => call.join(' '))).toEqual([
      expect.stringMatching(/^\[Viewer\] POST \/api\/test-cyclic failed: .*cyclic/),
    ]);
  } finally {
    logged.mockRestore();
    await viewer.analyticsReady.catch(() => {});
    viewer.localStore?.close();
    rmSync(dir, { force: true, recursive: true });
  }
});
