import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Harness } from '@inixiative/foundry-core';
import { Hono } from 'hono';
import { ActionHandler } from '../src/viewer/actions';
import { ConfigStore, createProject } from '../src/viewer/config';
import { registerControlRoutes } from '../src/viewer/routes/control';

type FileListing = { files: string[]; dirs: string[] };
type FileContent = { content: string; size: number; path: string };
type ErrorBody = { error: string };
type OkBody = { ok: boolean };

function stubHarness(): Harness {
  return {
    thread: {
      agents: new Map(),
      stack: { layers: [] },
    },
  } as unknown as Harness;
}

type ActionDeps = ConstructorParameters<typeof ActionHandler>[0];

function stubActions(harness: Harness): ActionHandler {
  return new ActionHandler({
    harness,
    eventStream: { push() {}, subscribe: () => () => {} } as unknown as ActionDeps['eventStream'],
    interventions: { log: () => {} } as unknown as ActionDeps['interventions'],
  });
}

describe('control routes', () => {
  let configDir: string;
  let projectDir: string;
  let configStore: ConfigStore;
  let app: Hono;

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), 'foundry-cfg-'));
    projectDir = mkdtempSync(join(tmpdir(), 'foundry-proj-'));

    configStore = new ConfigStore(configDir);
    await configStore.load();
    const project = createProject(projectDir, { label: 'Test' });
    await configStore.patch('projects', { [project.id]: project });

    const harness = stubHarness();
    app = new Hono();
    registerControlRoutes(app, {
      harness,
      actions: stubActions(harness),
      configStore,
      aiAssist: null,
      analyticsStore: null,
      actionQueue: null,
      tunnelHolder: { tunnel: null },
      port: 4500,
      configDir,
      threadsChanged: () => {},
    });
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  // -- /api/browse --

  test('GET /api/browse?files=1 includes files in response', async () => {
    writeFileSync(join(projectDir, 'a.md'), 'a');
    writeFileSync(join(projectDir, 'b.md'), 'b');
    mkdirSync(join(projectDir, 'sub'));

    const res = await app.fetch(
      new Request(`http://test/api/browse?path=${encodeURIComponent(projectDir)}&files=1`),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as FileListing;
    expect(data.files).toContain('a.md');
    expect(data.files).toContain('b.md');
    expect(data.dirs).toContain('sub');
  });

  test('GET /api/browse without files=1 omits files', async () => {
    writeFileSync(join(projectDir, 'a.md'), 'a');
    const res = await app.fetch(
      new Request(`http://test/api/browse?path=${encodeURIComponent(projectDir)}`),
    );
    const data = (await res.json()) as FileListing;
    expect(data.files).toEqual([]);
  });

  // -- /api/files read/write --

  test('GET /api/files returns content for allowed path', async () => {
    const target = join(projectDir, 'doc.md');
    writeFileSync(target, 'hello\nworld');
    const res = await app.fetch(
      new Request(`http://test/api/files?path=${encodeURIComponent(target)}`),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as FileContent;
    expect(data.content).toBe('hello\nworld');
    expect(data.size).toBeGreaterThan(0);
    expect(data.path).toBe(resolve(target));
  });

  test('GET /api/files rejects path outside allowed roots with 403', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'foundry-outside-'));
    try {
      const target = join(outside, 'secret.md');
      writeFileSync(target, 'nope');
      const res = await app.fetch(
        new Request(`http://test/api/files?path=${encodeURIComponent(target)}`),
      );
      expect(res.status).toBe(403);
      const data = (await res.json()) as ErrorBody;
      expect(data.error).toContain('outside allowed roots');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('GET /api/files with missing path query returns 400', async () => {
    const res = await app.fetch(new Request('http://test/api/files'));
    expect(res.status).toBe(400);
  });

  test('PUT /api/files writes content and round-trips', async () => {
    const target = join(projectDir, 'nested', 'new.md');
    const writeRes = await app.fetch(
      new Request('http://test/api/files', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: target, content: 'written content' }),
      }),
    );
    expect(writeRes.status).toBe(200);
    const writeData = (await writeRes.json()) as OkBody;
    expect(writeData.ok).toBe(true);

    const readRes = await app.fetch(
      new Request(`http://test/api/files?path=${encodeURIComponent(target)}`),
    );
    const readData = (await readRes.json()) as FileContent;
    expect(readData.content).toBe('written content');
  });

  test('PUT /api/files rejects path outside allowed roots', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'foundry-outside-'));
    try {
      const target = join(outside, 'evil.md');
      const res = await app.fetch(
        new Request('http://test/api/files', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: target, content: 'x' }),
        }),
      );
      expect(res.status).toBe(403);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('PUT /api/files rejects oversized content', async () => {
    const target = join(projectDir, 'big.md');
    const huge = 'x'.repeat(2_000_001);
    const res = await app.fetch(
      new Request('http://test/api/files', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: target, content: huge }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
