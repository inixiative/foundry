import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('a tunnel process that prints nothing fails the start at its deadline and is stopped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-tunnel-silent-'));
  const bin = join(dir, 'silent-tunnel');
  writeFileSync(bin, '#!/bin/sh\nexec sleep 600\n', { mode: 0o755 });
  const tunnel = new FoundryTunnel({
    port: 1,
    provider: 'cloudflared',
    cloudflaredBin: bin,
    urlTimeoutMs: 300,
    configDir: dir,
  });
  const started = Date.now();
  await expect(tunnel.start()).rejects.toThrow('Tunnel did not produce a URL within 0.3s');
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(tunnel.info).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

const scriptedTunnel = (dir: string, runs: string[]) => {
  const bin = join(dir, 'scripted-tunnel');
  const body = runs
    .map((run, index) => `${index + 1 === runs.length ? '*' : index + 1}) ${run};;`)
    .join('\n');
  writeFileSync(
    bin,
    `#!/bin/sh\nn=$(($(cat "$0.runs" 2>/dev/null || echo 0) + 1))\necho $n > "$0.runs"\ncase $n in\n${body}\nesac\n`,
    { mode: 0o755 },
  );
  return bin;
};
const until = async (met: () => boolean) => {
  for (let waited = 0; !met() && waited < 5_000; waited += 20) await Bun.sleep(20);
  expect(met()).toBe(true);
};

test('a kept-up tunnel is started again after a failed start and after its process exits', async () => {
  const dir = directory();
  const tunnel = new FoundryTunnel({
    port: 1,
    provider: 'cloudflared',
    cloudflaredBin: scriptedTunnel(dir, [
      'echo "failed: https://api.trycloudflare.com/tunnel" >&2; exit 1',
      'echo https://first.trycloudflare.com >&2; sleep 0.3',
      'echo https://second.trycloudflare.com >&2; exec sleep 600',
    ]),
    retryMs: 20,
    configDir: dir,
  });
  const seen: (string | null)[] = [];
  tunnel.keepUp(() => seen.push(tunnel.url));
  await until(() => seen.length === 3);
  expect(seen).toEqual([
    'https://first.trycloudflare.com',
    null,
    'https://second.trycloudflare.com',
  ]);
  await tunnel.stop();
  await Bun.sleep(100);
  expect(seen).toHaveLength(3);
  expect(tunnel.info).toBeNull();
});

test('a kept-up tunnel whose address stops answering is started again, its process still running', async () => {
  const dir = directory();
  const tunnel = new FoundryTunnel({
    port: 1,
    provider: 'cloudflared',
    cloudflaredBin: scriptedTunnel(dir, [
      'echo https://first.trycloudflare.com >&2; exec sleep 600',
      'echo https://second.trycloudflare.com >&2; exec sleep 600',
    ]),
    retryMs: 20,
    checkMs: 20,
    configDir: dir,
  });
  const asked: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    asked.push(url);
    const first = url.startsWith('https://first.');
    return new Response(null, {
      status: first && asked.length > 1 ? 530 : 200,
    });
  }) as unknown as typeof fetch;
  try {
    const seen: (string | null)[] = [];
    tunnel.keepUp(() => seen.push(tunnel.url));
    await until(() => seen.length === 3);
    expect(seen).toEqual([
      'https://first.trycloudflare.com',
      null,
      'https://second.trycloudflare.com',
    ]);
    expect(
      asked.filter((url) => url === 'https://first.trycloudflare.com/api/health'),
    ).toHaveLength(4);
    await until(() => asked.some((url) => url.startsWith('https://second.')));
    await Bun.sleep(100);
    expect(seen).toHaveLength(3);
  } finally {
    await tunnel.stop();
    globalThis.fetch = original;
  }
});

test('a kept-up tunnel whose address has never answered is left running', async () => {
  const dir = directory();
  const tunnel = new FoundryTunnel({
    port: 1,
    provider: 'cloudflared',
    cloudflaredBin: scriptedTunnel(dir, [
      'echo https://unresolved.trycloudflare.com >&2; exec sleep 600',
    ]),
    retryMs: 20,
    checkMs: 5,
    configDir: dir,
  });
  let asked = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    asked += 1;
    throw Error('getaddrinfo ENOTFOUND');
  }) as unknown as typeof fetch;
  try {
    const seen: (string | null)[] = [];
    tunnel.keepUp(() => seen.push(tunnel.url));
    await until(() => asked >= 8);
    expect(seen).toEqual(['https://unresolved.trycloudflare.com']);
    await tunnel.stop();
    const stopped = asked;
    await Bun.sleep(60);
    expect(asked).toBe(stopped);
  } finally {
    await tunnel.stop();
    globalThis.fetch = original;
  }
});

test('a start that a later start replaced ends its own process, never the new one', async () => {
  const dir = directory();
  const tunnel = new FoundryTunnel({
    port: 1,
    provider: 'cloudflared',
    cloudflaredBin: scriptedTunnel(dir, [
      'exec sleep 600',
      'sleep 0.2; echo https://second.trycloudflare.com >&2; exec sleep 600',
    ]),
    configDir: dir,
  });
  const first = tunnel.start().catch((error: Error) => error.message);
  await until(() => existsSync(join(dir, 'scripted-tunnel.runs')));
  await tunnel.stop();
  expect(await tunnel.start()).toBe('https://second.trycloudflare.com');
  expect(await first).toContain('Tunnel process ended before giving a URL');
  expect(tunnel.url).toBe('https://second.trycloudflare.com');
  await tunnel.stop();
});

test('starting the tunnel takes the saved provider, whatever provider the held tunnel last tried', async () => {
  const dir = directory(),
    thread = new Thread('tunnel-provider-test', new ContextStack());
  const viewer = createViewer({
    harness: new Harness(thread),
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    configDir: dir,
    localStore: null,
    tunnel: {
      port: 4500,
      token,
      configDir: dir,
      provider: 'localtunnel',
      cloudflaredBin: scriptedTunnel(dir, [
        'echo https://switched.trycloudflare.com >&2; exec sleep 600',
      ]),
    },
  });
  const call = (method: string, path: string, body?: unknown) =>
    viewer.app.request(`http://localhost:4500${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  await call('PATCH', '/api/tunnel', { provider: 'cloudflared' });
  const started = await call('POST', '/api/tunnel/start');
  expect(await started.json()).toEqual({
    active: true,
    url: 'https://switched.trycloudflare.com',
  });
  await viewer.tunnelHolder.tunnel?.stop();
  await viewer.analyticsReady;
});
