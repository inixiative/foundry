import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
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
import { pairKingdomIntegration } from '../src/providers/kingdom-pairing';
import { ConfigStore } from '../src/viewer/config';
import { createViewer } from '../src/viewer/server';
import { mockKingdom, userOwner } from './helpers/kingdom-installation';
import { until } from './helpers/live-watch-fixture';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

const origin = 'https://studio.foundry.kingdom.test';
type Status = { integrations: { id: string; opensViewer: boolean }[] };

/** A Foundry paired to a mock Kingdom, with what Kingdom's viewer frames need to reach it. */
async function paired() {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-viewer-via-kingdom-'));
  const kingdom = mockKingdom();
  const store = new ConfigStore(dir);
  await pairKingdomIntegration(store, dir, {
    url: kingdom.url,
    name: 'Studio Foundry',
    onReview: () => kingdom.approve(userOwner()),
  });
  const saved = await store.load();
  const viewer = createViewer({
    harness: new Harness(new Thread('main', new ContextStack())),
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    configDir: dir,
    configStore: store,
    kingdomIntegrations: saved.kingdomIntegrations,
  });
  expect(await viewer.kingdom.start()).toEqual([]);
  cleanup.push(async () => {
    viewer.kingdom.stop();
    await viewer.analyticsReady.catch(() => {});
    viewer.localStore?.close();
    kingdom.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const sent = (action: string, id: string) =>
    kingdom.frames.filter(
      (frame) => frame.action === action && (frame.requestId === id || frame.socketId === id),
    );
  /** Forward one request as Kingdom does and return the viewer's status and JSON body. */
  const forward = async (
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const requestId = Bun.randomUUIDv7();
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    kingdom.threadFrame({
      type: 'viewer.request',
      requestId,
      origin,
      method,
      path,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...options.headers },
      hasBody: body !== null,
    });
    if (body !== null)
      kingdom.threadFrame({
        type: 'viewer.request.body',
        requestId,
        data: Buffer.from(body).toString('base64'),
        last: true,
      });
    await until(() => {
      const [head] = sent('viewer.response', requestId);
      return (
        head &&
        (!head.hasBody || sent('viewer.response.body', requestId).some((frame) => frame.last))
      );
    }, `no answer to ${method} ${path}`);
    const text = sent('viewer.response.body', requestId)
      .map((frame) => Buffer.from(String(frame.data), 'base64').toString('utf8'))
      .join('');
    const status = sent('viewer.response', requestId)[0]?.status;
    return { status, text, json: () => JSON.parse(text) };
  };
  const integrationId = () =>
    forward('GET', '/api/kingdom/status').then(
      (answer) => answer.json().integrations[0].id as string,
    );
  return { dir, kingdom, viewer, store, forward, sent, integrationId };
}

test('a request a paired Kingdom forwards reaches the viewer, which answers it as it would on this machine', async () => {
  const { viewer, forward } = await paired();
  const direct = await viewer.app.request('http://localhost:4500/api/kingdom/status');
  const forwarded = await forward('GET', '/api/kingdom/status');
  expect(forwarded.status).toBe(200);
  expect(forwarded.json().integrations).toEqual(((await direct.json()) as Status).integrations);
  expect(forwarded.json().integrations[0].opensViewer).toBe(true);

  // The same address asked of the viewer directly is not this machine and is refused.
  const outside = await viewer.app.request(`${origin}/api/kingdom/status`);
  expect(outside.status).toBe(403);
});

test('a forwarded request from another origin, or a write with none, is refused, and so is what only this machine may change', async () => {
  const { forward, integrationId, store } = await paired();
  const foreign = await forward('POST', '/api/kingdom/cancel', {
    body: {},
    headers: { origin: 'https://www.inixiative.com' },
  });
  expect(foreign.status).toBe(403);

  const noOrigin = await forward('POST', '/api/threads', { body: {} });
  expect(noOrigin.status).toBe(403);
  for (const path of ['/api/kingdom/disconnect', '/api/kingdom/cancel'])
    expect((await forward('POST', path, { body: {}, headers: { origin } })).status).toBe(403);

  const id = await integrationId();
  const pair = await forward('POST', '/api/kingdom/pair', {
    body: { url: 'https://kingdom.attacker.test' },
    headers: { origin },
  });
  expect(pair.status).toBe(403);
  expect(pair.json().error).toContain('on the machine');
  const close = await forward('POST', '/api/kingdom/viewer', {
    body: { id, opensViewer: false },
    headers: { origin },
  });
  expect(close.status).toBe(403);
  expect((await store.load()).kingdomViewerRefused).toBeUndefined();
});

test('switching a Kingdom off on the machine tells it, refuses its requests, and survives a settings save', async () => {
  const { viewer, kingdom, forward, integrationId, store } = await paired();
  const id = await integrationId();
  const local = (path: string, method: string, body: unknown) =>
    viewer.app.request(`http://localhost:4500${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const off = await local('/api/kingdom/viewer', 'POST', { id, opensViewer: false });
  expect(off.status).toBe(200);
  expect(((await off.json()) as Status).integrations[0]?.opensViewer).toBe(false);
  await until(
    () => kingdom.frames.findLast((frame) => frame.action === 'viewer.serving')?.serving === false,
    'Kingdom was not told',
  );
  expect((await forward('GET', '/api/kingdom/status')).status).toBe(403);

  const saved = await store.load();
  await local('/api/settings', 'PUT', { ...saved, kingdomViewerRefused: undefined });
  expect((await store.load()).kingdomViewerRefused).toEqual(saved.kingdomViewerRefused);

  await local('/api/kingdom/viewer', 'POST', { id, opensViewer: true });
  expect((await forward('GET', '/api/kingdom/status')).status).toBe(200);
  expect((await store.load()).kingdomViewerRefused).toBeUndefined();
});

test("the viewer's socket through Kingdom connects, answers a ping, and is refused from another origin or none", async () => {
  const { kingdom, sent } = await paired();
  const socketId = Bun.randomUUIDv7();
  kingdom.threadFrame({
    type: 'viewer.socket.open',
    socketId,
    origin,
    path: '/ws?client=tab_12345678',
    headers: { origin },
  });
  await until(() => sent('viewer.socket.message', socketId).length === 1, 'no connected frame');
  expect(sent('viewer.socket.opened', socketId)).toHaveLength(1);
  expect(JSON.parse(String(sent('viewer.socket.message', socketId)[0]?.data))).toMatchObject({
    type: 'connected',
  });
  kingdom.threadFrame({
    type: 'viewer.socket.message',
    socketId,
    data: JSON.stringify({ action: 'ping' }),
  });
  await until(() => sent('viewer.socket.message', socketId).length === 2, 'no pong');
  expect(JSON.parse(String(sent('viewer.socket.message', socketId)[1]?.data))).toEqual({
    type: 'pong',
  });

  for (const headers of [{ origin: 'https://www.inixiative.com' }, {}]) {
    const refused = Bun.randomUUIDv7();
    kingdom.threadFrame({
      type: 'viewer.socket.open',
      socketId: refused,
      origin,
      path: '/ws',
      headers,
    });
    await until(() => sent('viewer.socket.close', refused).length === 1, 'not refused');
    expect(sent('viewer.socket.opened', refused)).toHaveLength(0);
  }
});
