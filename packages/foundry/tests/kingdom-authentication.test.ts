import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPrivateJson, SignetClient } from '@inixiative/signet';
import { KingdomAuthentication } from '../src/providers/kingdom-authentication';
import { kingdomToken } from '../src/providers/kingdom-token-helper';
import { heldSignet, mockKingdom, ownerOf } from './helpers/kingdom-installation';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const secret = (prefix: string) => `${prefix}${'x'.repeat(43)}`;

test('Kingdom resolves once through the Signet, persists source identity, and delegates only one-run renewal authority', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'foundry-kingdom-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const ownerKey = `Organization::${crypto.randomUUID()}:`,
    bindingId = crypto.randomUUID(),
    integrationId = crypto.randomUUID();
  const calls: string[] = [];
  const kingdom = mockKingdom({
    onSignet: (action, body, presented) => {
      calls.push(action);
      if (action === 'resolveRun')
        return {
          id: bindingId,
          owner: presented.owner,
          signetEnrollmentId: presented.enrollmentId,
          runId: body.runId,
          capacityId: crypto.randomUUID(),
          integrationId,
          model: 'bound-model',
          effort: 'low',
          runtime: 'claude',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          gatewayPath: `/api/v1/access/gateway/${bindingId}`,
        };
      return {
        secret: secret('kingdom_refresh_'),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
    },
  });
  cleanups.push(async () => kingdom.stop());
  const { credentialFile } = await heldSignet(kingdom, directory, ownerKey);
  const { accessToken } = (await readPrivateJson(credentialFile)) as { accessToken: string };
  const options = {
    directory: join(directory, 'runs'),
    defaultOwnerKey: ownerKey,
    sources: [
      {
        id: ownerKey,
        url: kingdom.url,
        credentialFile,
        selection: { model: 'bound-model', effort: 'low' },
      },
    ],
  };
  const auth = new KingdomAuthentication(options);
  const [a, b] = await Promise.all([
    auth.prepare('thread', 'claude'),
    auth.prepare('thread', 'claude'),
  ]);
  expect(calls).toEqual(['resolveRun', 'delegateRun']);
  expect(a.bindingId).toBe(b.bindingId);
  expect(a.connectionId).toBe(integrationId); // Local profile identity receives the selected remote Integration.
  expect(a.model).toBe('bound-model');
  expect(a.effort).toBe('low');
  const child = a.launch(['claude'], {});
  expect(() => b.launch(['claude'], {})).toThrow('in use');
  const settings = await readFile(join(child.env.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf8');
  expect(settings).not.toContain(credentialFile);
  expect(settings).not.toContain(accessToken);
  a.release();
  b.release();
  const restored = await new KingdomAuthentication(options).prepare('thread', 'claude');
  expect(restored.bindingId).toBe(a.bindingId);
  expect(calls).toHaveLength(2);
  restored.release();
  const changed = new KingdomAuthentication({
    ...options,
    sources: [{ ...options.sources[0]!, selection: { model: 'other-model', effort: 'low' } }],
  });
  await expect(changed.prepare('thread', 'claude')).rejects.toThrow('selection changed');
  const foreign = `Organization::${crypto.randomUUID()}:`;
  await expect(
    new KingdomAuthentication({
      ...options,
      defaultOwnerKey: foreign,
      sources: [{ ...options.sources[0]!, id: foreign }],
    }).prepare('other-thread', 'claude'),
  ).rejects.toThrow('another owner');
});

test('concurrent helper invocations renew once and cache only the scoped access token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'foundry-kingdom-token-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const bindingId = crypto.randomUUID();
  let calls = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      calls++;
      expect(request.headers.get('authorization')).toBe(`Bearer ${secret('kingdom_refresh_')}`);
      expect(await request.json()).toEqual({ bindingId });
      return Response.json({
        data: {
          id: crypto.randomUUID(),
          secret: secret('kingdom_run_'),
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        },
      });
    },
  });
  cleanups.push(async () => server.stop(true));
  const file = join(directory, 'run.json');
  await writeFile(
    file,
    JSON.stringify({
      url: server.url.origin,
      bindingId,
      refreshCredential: secret('kingdom_refresh_'),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }),
    { mode: 0o600 },
  );
  expect(await Promise.all([kingdomToken(file), kingdomToken(file), kingdomToken(file)])).toEqual([
    secret('kingdom_run_'),
    secret('kingdom_run_'),
    secret('kingdom_run_'),
  ]);
  expect(calls).toBe(1);
});

test('Kingdom clients reject credential URLs, remote HTTP and public credential files', async () => {
  expect(
    () =>
      new SignetClient(
        'https://user:secret@example.com',
        '/private/signet.json',
        crypto.randomUUID(),
      ),
  ).toThrow();
  expect(
    () => new SignetClient('http://example.com', '/private/signet.json', crypto.randomUUID()),
  ).toThrow();
  const directory = await mkdtemp(join(tmpdir(), 'foundry-kingdom-mode-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'public.json');
  await writeFile(file, '{}', { mode: 0o644 });
  await chmod(file, 0o644); // A restrictive runner umask must not turn this public-file fixture private.
  await expect(readPrivateJson(file)).rejects.toThrow('private regular file');
});

test('a transient resolution failure can retry the same durable run intent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'foundry-kingdom-retry-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const ownerKey = `Organization::${crypto.randomUUID()}:`,
    bindingId = crypto.randomUUID(),
    runIds: string[] = [];
  const kingdom = mockKingdom({
    onSignet: (action, body, presented) => {
      if (action === 'resolveRun') {
        runIds.push(body.runId);
        if (runIds.length === 1) return new Response('temporary failure', { status: 503 });
        return {
          id: bindingId,
          owner: ownerOf(ownerKey),
          signetEnrollmentId: presented.enrollmentId,
          runId: body.runId,
          capacityId: crypto.randomUUID(),
          integrationId: crypto.randomUUID(),
          model: 'model',
          effort: 'low',
          runtime: 'claude',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          gatewayPath: `/api/v1/access/gateway/${bindingId}`,
        };
      }
      return {
        secret: secret('kingdom_refresh_'),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
    },
  });
  cleanups.push(async () => kingdom.stop());
  const { credentialFile } = await heldSignet(kingdom, directory, ownerKey);
  const auth = new KingdomAuthentication({
    directory: join(directory, 'runs'),
    defaultOwnerKey: ownerKey,
    sources: [
      {
        id: ownerKey,
        url: kingdom.url,
        credentialFile,
        selection: { model: 'model', effort: 'low' },
      },
    ],
  });
  await expect(auth.prepare('thread', 'claude')).rejects.toThrow('503');
  const recovered = await auth.prepare('thread', 'claude');
  recovered.release();
  expect(runIds).toHaveLength(2);
  expect(runIds[0]).toBe(runIds[1]);
});
