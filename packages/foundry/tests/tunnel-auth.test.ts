import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextStack,
  EventStream,
  Harness,
  InterventionLog,
  Thread,
} from '@inixiative/foundry-core';
import { Hono } from 'hono';
import { pairKingdomIntegration } from '../src/providers/kingdom-pairing';
import { ConfigStore } from '../src/viewer/config';
import { privateTunnelToken } from '../src/viewer/private-token';
import { authenticatedRequest, sessionValue } from '../src/viewer/request-auth';
import { createViewer } from '../src/viewer/server';
import { FoundryTunnel, tunnelAuth } from '../src/viewer/tunnel';
import { mockKingdom, userOwner } from './helpers/kingdom-installation';

const token = 'synthetic-only-token-0123456789abcdef';
const directories: string[] = [];
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-auth-'));
  directories.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fixture = () => {
  const app = new Hono();
  app.use('*', tunnelAuth(token));
  app.all('*', (c) => c.json({ protected: true }));
  return app;
};

test('forwarding headers and URL credentials cannot bypass authentication', async () => {
  const app = fixture();
  const forwarded: Record<string, string>[] = [
    { 'x-forwarded-for': '127.0.0.1' },
    { 'x-real-ip': '10.1.2.3' },
    {},
  ];
  for (const headers of forwarded)
    expect((await app.request('https://viewer.test/api/threads', { headers })).status).toBe(401);
  expect((await app.request(`https://viewer.test/ws?authorization=${token}`)).status).toBe(401);
  expect(
    (
      await app.request('https://viewer.test/api/threads', {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
  ).toBe(200);
});

test('login sets a private cookie; origin, expiration and signature checks apply to HTTP and websocket', async () => {
  const app = fixture();
  const login = await app.request('https://viewer.test/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://viewer.test' },
    body: `token=${token}`,
  });
  expect(login.status).toBe(302);
  const setCookie = login.headers.get('set-cookie')!;
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('Secure');
  expect(setCookie).not.toContain(token);
  const cookie = setCookie.split(';')[0];
  for (const path of ['/api/threads', '/ws']) {
    expect(
      authenticatedRequest(
        new Request(`https://viewer.test${path}`, { headers: { cookie } }),
        token,
      ),
    ).toBe(true);
    expect(
      (
        await app.request(`https://viewer.test${path}`, {
          headers: { cookie, origin: 'https://evil.test' },
        })
      ).status,
    ).toBe(403);
  }
  const expired = `foundry_session=${sessionValue(token, Date.now() - 86400001)}`;
  expect(
    (await app.request('https://viewer.test/api/threads', { headers: { cookie: expired } })).status,
  ).toBe(401);
  expect(
    authenticatedRequest(
      new Request('https://viewer.test/ws', { headers: { cookie: `${cookie}x` } }),
      token,
    ),
  ).toBe(false);
});

test('tunnel credential persists privately and refuses symlinks instead of reading another file', () => {
  const dir = directory(),
    first = privateTunnelToken(dir);
  expect(privateTunnelToken(dir)).toBe(first);
  expect(statSync(join(dir, 'tunnel-token')).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  const other = directory(),
    target = join(other, 'unrelated');
  writeFileSync(target, token);
  symlinkSync(target, join(other, 'tunnel-token'));
  expect(() => privateTunnelToken(other)).toThrow();
});

test('stopping a tunnel preserves the HTTP authentication boundary', async () => {
  const dir = directory(),
    thread = new Thread('security-test', new ContextStack());
  const viewer = createViewer({
    harness: new Harness(thread),
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    configDir: dir,
    localStore: null,
    tunnel: { port: 4500, token, configDir: dir },
  });
  const response = await viewer.app.request('http://localhost/api/tunnel/stop', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  expect(viewer.tunnelHolder.tunnel).toBeInstanceOf(FoundryTunnel);
  expect((await viewer.app.request('https://foundry-x.loca.lt/api/tunnel')).status).toBe(401);
  expect(
    (
      await viewer.app.request('https://foundry-x.loca.lt/api/tunnel', {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
  ).toBe(200);
  await viewer.analyticsReady;
});

test('trusted HTTPS tunnel origin works behind loopback proxy and does not trust forwarded origins', async () => {
  const app = new Hono();
  app.use('*', tunnelAuth(token, 'https://public-viewer.test'));
  app.get('/api/threads', (c) => c.json({ ok: true }));
  const login = await app.request('http://127.0.0.1:4500/auth', {
    method: 'POST',
    headers: {
      origin: 'https://public-viewer.test',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: `token=${token}`,
  });
  expect(login.status).toBe(302);
  expect(login.headers.get('set-cookie')).toContain('Secure');
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  expect(
    authenticatedRequest(
      new Request('http://127.0.0.1:4500/ws', {
        headers: { cookie, origin: 'https://public-viewer.test' },
      }),
      token,
      'https://public-viewer.test',
    ),
  ).toBe(true);
  expect(
    (
      await app.request('http://127.0.0.1:4500/api/threads', {
        headers: {
          cookie,
          origin: 'https://evil.test',
          'x-forwarded-host': 'evil.test',
          'x-forwarded-proto': 'https',
        },
      })
    ).status,
  ).toBe(403);
});

test('while tunnelled, this machine opens the viewer directly; only tunnel traffic meets the login', async () => {
  const dir = directory();
  const viewer = createViewer({
    harness: new Harness(new Thread('main', new ContextStack())),
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    configDir: dir,
    localStore: null,
    tunnel: { port: 4500, token, configDir: dir },
  });
  for (const host of ['localhost', '127.0.0.1', '[::1]'])
    expect((await viewer.app.request(`http://${host}:4500/api/tunnel`)).status).toBe(200);
  for (const headers of [{ 'x-forwarded-for': '203.0.113.9' }, { 'cf-ray': 'abc' }] as Record<
    string,
    string
  >[])
    expect((await viewer.app.request('http://localhost:4500/api/tunnel', { headers })).status).toBe(
      401,
    );
  const page = await viewer.app.request('https://foundry-x.loca.lt/', {
    headers: { accept: 'text/html' },
  });
  expect(page.status).toBe(302);
  expect(page.headers.get('location')).toBe('/auth');
  await viewer.analyticsReady;
});

test('the login page offers each paired Kingdom: its devices page, else its dashboard', async () => {
  const app = new Hono();
  app.use(
    '*',
    tunnelAuth(token, undefined, async () => [
      'https://kingdom.acme.test/devices',
      'https://api.kingdom.other.test/dashboard',
    ]),
  );
  const page = await (await app.request('https://viewer.test/auth')).text();
  expect(page).toContain('href="https://kingdom.acme.test/devices"');
  expect(page).toContain('Open through kingdom.acme.test');
  expect(page).toContain('Open through api.kingdom.other.test');
  const failed = await app.request('https://viewer.test/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'token=wrong',
  });
  expect(await failed.text()).toContain('https://kingdom.acme.test/devices');

  const single = new Hono();
  single.use(
    '*',
    tunnelAuth(token, undefined, async () => ['https://kingdom.acme.test/devices']),
  );
  expect(await (await single.request('https://viewer.test/auth')).text()).toContain(
    '>Open through Kingdom</a>',
  );

  const none = new Hono();
  none.use('*', tunnelAuth(token));
  expect(await (await none.request('https://viewer.test/auth')).text()).not.toContain('Kingdom');
});

test("the viewer's login page links to the paired Kingdom's devices page", async () => {
  const dir = directory();
  const kingdom = mockKingdom({
    onSignet: (action, body) =>
      action === 'describe'
        ? {
            signetId: body.signetId,
            name: 'Host Foundry',
            expiresAt: null,
            lifecycle: 'ongoing',
            taskId: null,
            currentRevision: 1,
            remainingRequests: null,
            operations: [],
            holder: {
              integration: { id: Bun.randomUUIDv7(), name: 'Host Foundry', provider: null },
              owner: {
                ownerModel: 'User',
                name: 'Grace',
                organization: null,
                space: null,
                user: { id: Bun.randomUUIDv7(), name: 'Grace', email: 'grace@acme.test' },
              },
              issuedBy: { id: Bun.randomUUIDv7(), name: null, email: 'grace@acme.test' },
              webUrl: 'https://kingdom.acme.test',
              manageUrl: 'https://kingdom.acme.test/dashboard',
            },
          }
        : undefined,
  });
  try {
    const store = new ConfigStore(dir);
    await pairKingdomIntegration(store, dir, {
      url: kingdom.url,
      name: 'Host Foundry',
      viewerToken: 't'.repeat(48),
      onReview: () => kingdom.approve(userOwner()),
    });
    const viewer = createViewer({
      harness: new Harness(new Thread('main', new ContextStack())),
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      configDir: dir,
      configStore: store,
      localStore: null,
      tunnel: { port: 4500, token, configDir: dir },
    });
    const page = await (await viewer.app.request('https://foundry-x.loca.lt/auth')).text();
    expect(page).toContain('href="https://kingdom.acme.test/devices"');
    await viewer.analyticsReady;
  } finally {
    kingdom.stop();
  }
});
