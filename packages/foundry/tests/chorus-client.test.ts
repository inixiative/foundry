// The remote Chorus client (dev mode + hosted Kingdom) against stand-in hosts: each wire answer as its outcome.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chorusResourceKind, SignetClient, SignetHttpError } from '@inixiative/signet';
import { verifySignetProof } from '@inixiative/signet/proof';
import { createChorusRemote } from '../src/providers/chorus-client';
import { directChorusTransport } from '../src/providers/chorus-direct-transport';
import { chorusRemotes } from '../src/providers/chorus-remotes';
import {
  createKingdomChorusTransport,
  type SignetAccessHandle,
} from '../src/providers/kingdom-chorus-transport';
import type { ProjectHostState } from '../src/providers/project-warden-hosts';

const CALL_ID = '00000000-0000-4000-8000-000000000001';
const SPOKE = {
  ok: true,
  result: {
    rosterRevision: 'r1',
    contributions: [
      {
        callId: CALL_ID,
        domain: 'convention',
        outcome: 'spoke',
        snippets: ['Use the repo helper.'],
        layers: [],
        confidence: 0.9,
      },
    ],
    elapsedMs: 5,
  },
};

interface Seen {
  path: string;
  auth: string | null;
  body: unknown;
}

/** A Chorus host stand-in: `x-reply` in the input's moment picks how it answers. */
let server: ReturnType<typeof Bun.serve>;
let url = '';
const seen: Seen[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { projectId: string; input: { moment?: string } };
      const path = new URL(req.url).pathname;
      seen.push({ path, auth: req.headers.get('authorization'), body });
      if (req.headers.get('authorization') !== 'Bearer devtoken')
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (!path.startsWith('/operations/chorus.'))
        return Response.json({ error: 'unknown_operation' }, { status: 404 });
      const reply = body.input.moment ?? '';
      if (reply === '400')
        return Response.json({ ok: false, refusal: 'invalid_request' }, { status: 400 });
      if (reply === '500') return Response.json({ ok: false, refusal: 'failed' }, { status: 500 });
      if (reply === 'warming') return Response.json({ ok: false, refusal: 'chorus_warming' });
      if (reply === 'garbage') return Response.json({ hello: 'world' });
      if (reply === 'slow') await Bun.sleep(1_500);
      if (path === '/operations/chorus.projectActivity')
        return Response.json({
          ok: true,
          result: {
            projectId: body.projectId,
            status: 'degraded',
            expectedWardens: 3,
            heldWardens: 2,
            wardensDown: ['security'],
            rosterRevision: 'r1',
          },
        });
      if (reply === 'r2')
        return Response.json({ ...SPOKE, result: { ...SPOKE.result, rosterRevision: 'r2' } });
      return Response.json(SPOKE);
    },
  });
  url = `http://localhost:${server.port}/`;
});

afterAll(() => server.stop(true));

const token = (value: string | undefined) => async () => value;
const advise = (moment: string) => ({ moment, deadlineMs: 1_000 });

describe('directChorusTransport', () => {
  test('posts {projectId, input} to /operations/<op> with the bearer and returns the outcome', async () => {
    seen.length = 0;
    const transport = directChorusTransport(url, token('devtoken'));
    const outcome = await transport(
      'chorus.advise',
      { projectId: 'p1', input: advise('hi') },
      5_000,
    );
    expect(outcome).toEqual(SPOKE as never);
    expect(seen[0]).toEqual({
      path: '/operations/chorus.advise',
      auth: 'Bearer devtoken',
      body: { projectId: 'p1', input: advise('hi') },
    });
  });

  test('a wrong token is a rejected failure naming the status', async () => {
    const outcome = await directChorusTransport(url, token('nope'))(
      'chorus.advise',
      { projectId: 'p1', input: advise('hi') },
      5_000,
    );
    expect(outcome).toMatchObject({ ok: false, failure: 'rejected' });
    expect((outcome as { message: string }).message).toContain('401');
  });

  test('no token is a no-token failure without a request', async () => {
    seen.length = 0;
    const outcome = await directChorusTransport(url, token(undefined))(
      'chorus.advise',
      { projectId: 'p1', input: advise('hi') },
      5_000,
    );
    expect(outcome).toMatchObject({ ok: false, failure: 'no-token' });
    expect(seen).toHaveLength(0);
  });

  test('an unknown operation (404) is rejected', async () => {
    const transport = directChorusTransport(`${url}nested`, token('devtoken'));
    const outcome = await transport(
      'chorus.advise',
      { projectId: 'p1', input: advise('hi') },
      5_000,
    );
    expect(outcome).toMatchObject({ ok: false, failure: 'rejected' });
    expect((outcome as { message: string }).message).toContain('404');
  });

  test('400 is invalid_request; 500 is the host’s failed refusal; a 200 refusal passes through', async () => {
    const transport = directChorusTransport(url, token('devtoken'));
    const call = (moment: string) =>
      transport('chorus.advise', { projectId: 'p1', input: advise(moment) }, 5_000);
    expect(await call('400')).toMatchObject({ ok: false, refusal: 'invalid_request' });
    expect(await call('500')).toEqual({ ok: false, refusal: 'failed' });
    expect(await call('warming')).toEqual({ ok: false, refusal: 'chorus_warming' });
  });

  test('a body off the contract is invalid-response', async () => {
    const outcome = await directChorusTransport(url, token('devtoken'))(
      'chorus.advise',
      { projectId: 'p1', input: advise('garbage') },
      5_000,
    );
    expect(outcome).toMatchObject({ ok: false, failure: 'invalid-response' });
  });

  test('no answer in time is a timeout', async () => {
    const outcome = await directChorusTransport(url, token('devtoken'))(
      'chorus.advise',
      { projectId: 'p1', input: advise('slow') },
      200,
    );
    expect(outcome).toMatchObject({ ok: false, failure: 'timeout' });
  });

  test('a host that is not listening is unreachable', async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response('') });
    const port = closed.port;
    closed.stop(true);
    const outcome = await directChorusTransport(`http://localhost:${port}`, token('devtoken'))(
      'chorus.advise',
      { projectId: 'p1', input: advise('hi') },
      2_000,
    );
    expect(outcome).toMatchObject({ ok: false, failure: 'unreachable' });
  });
});

describe('createChorusRemote', () => {
  test('an input off the schema is invalid_request and never sent', async () => {
    seen.length = 0;
    const remote = createChorusRemote({
      projectId: 'p1',
      endpoint: url,
      transport: directChorusTransport(url, token('devtoken')),
    });
    const outcome = await remote.call('chorus.advise', { moment: '', deadlineMs: 1_000 });
    expect(outcome).toMatchObject({ ok: false, refusal: 'invalid_request' });
    expect(seen).toHaveLength(0);
  });

  test('waits deadlineMs plus slack and sends its project id', async () => {
    const timeouts: number[] = [];
    const inner = directChorusTransport(url, token('devtoken'));
    const remote = createChorusRemote({
      projectId: 'p1',
      endpoint: url,
      transport: (operation, call, timeoutMs) => {
        timeouts.push(timeoutMs);
        expect(call.projectId).toBe('p1');
        return inner(operation, call, timeoutMs);
      },
    });
    await remote.call('chorus.advise', advise('hi'));
    await remote.call('chorus.advise', advise('r2'));
    expect(timeouts).toEqual([6_000, 6_000]);
  });
});

describe('chorusRemotes', () => {
  test('off without dev or hosted link; dev mode wins over hosted; token read on every call; host state recorded', async () => {
    const setting = { current: undefined as { url: string; tokenKey: string } | undefined };
    const reads: string[] = [];
    const hosts: Array<[string, ProjectHostState]> = [];
    const remotes = chorusRemotes({
      devSetting: () => setting.current,
      readToken: async (name) => {
        reads.push(name);
        return 'devtoken';
      },
      onHost: (id, state) => hosts.push([id, state]),
    });
    expect(remotes.remote('p1')).toBeUndefined();
    setting.current = { url, tokenKey: 'CHORUS_DEV_TOKEN' };
    expect(remotes.remote('p1')).toBe(remotes.remote('p1')!);
    await remotes.activate('p1');
    await remotes.activate('p1');
    expect(reads).toEqual(['CHORUS_DEV_TOKEN', 'CHORUS_DEV_TOKEN']);
    expect(hosts[0]).toEqual([
      'p1',
      {
        status: 'serving',
        expected: 3,
        held: 2,
        failures: 0,
        wardensDown: ['security'],
        resets: {},
        generation: 1,
        remote: url,
      },
    ]);
    expect(Object.keys(remotes.snapshot())).toEqual(['p1']);
    setting.current = undefined;
    expect(remotes.snapshot()).toEqual({});
  });

  test('a host that cannot be reached is a failed host state, served by its URL', async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response('') });
    const dead = `http://localhost:${closed.port}`;
    closed.stop(true);
    const hosts: ProjectHostState[] = [];
    const remotes = chorusRemotes({
      devSetting: () => ({ url: dead, tokenKey: 'CHORUS_DEV_TOKEN' }),
      readToken: async () => 'devtoken',
      onHost: (_id, state) => hosts.push(state),
    });
    await remotes.activate('p1');
    expect(hosts[0]).toMatchObject({ status: 'failed', failures: 1, remote: dead });
  });

  test('routes hosted projects through Kingdom when dev mode is off and invalidates cached grants', async () => {
    const kingdomProjectId = Bun.randomUUIDv7();
    const chorusIntegrationId = Bun.randomUUIDv7();
    const chorusResourceId = Bun.randomUUIDv7();
    const signetId = Bun.randomUUIDv7();
    let describeCalls = 0;
    const executeTimeouts: number[] = [];

    const fakeHandle: SignetAccessHandle = {
      signetId,
      describe: async () => {
        describeCalls += 1;
        return {
          signetId,
          name: 'Foundry Pair',
          expiresAt: null,
          lifecycle: 'ongoing',
          taskId: null,
          currentRevision: 1,
          remainingRequests: null,
          dropped: [],
          operations: [
            {
              key: 'chorus.projectActivity',
              name: 'Project activity',
              resources: [
                {
                  id: chorusResourceId,
                  name: 'Chorus',
                  kind: chorusResourceKind,
                  externalId: kingdomProjectId,
                  integrationId: chorusIntegrationId,
                  provider: 'chorus',
                },
              ],
            },
            {
              key: 'chorus.advise',
              name: 'Advise',
              resources: [
                {
                  id: chorusResourceId,
                  name: 'Chorus',
                  kind: chorusResourceKind,
                  externalId: kingdomProjectId,
                  integrationId: chorusIntegrationId,
                  provider: 'chorus',
                },
              ],
            },
          ],
        };
      },
      execute: async (request, opts) => {
        if (opts?.timeoutMs !== undefined) executeTimeouts.push(opts.timeoutMs);
        if (request.operation === 'chorus.projectActivity') {
          return {
            executionId: Bun.randomUUIDv7(),
            result: {
              projectId: kingdomProjectId,
              status: 'serving',
              expectedWardens: 2,
              heldWardens: 2,
              wardensDown: [],
            },
          };
        }
        return {
          executionId: Bun.randomUUIDv7(),
          result: { rosterRevision: 'rev-hosted-1', contributions: [], elapsedMs: 12 },
        };
      },
    };

    const hosts: Array<[string, ProjectHostState]> = [];
    const remotes = chorusRemotes({
      devSetting: () => undefined,
      readToken: async () => undefined,
      hostedProject: (localId) =>
        localId === 'my-app'
          ? {
              key: 'k1',
              endpoint: 'kingdom:api.kingdom.test',
              kingdomProjectId,
              signets: async () => [fakeHandle],
            }
          : undefined,
      onHost: (id, state) => hosts.push([id, state]),
    });

    await remotes.activate('my-app');
    const advise = await remotes.remote('my-app')!.call('chorus.advise', {
      moment: 'Check auth',
      deadlineMs: 7_000,
    });
    expect(advise).toEqual({
      ok: true,
      result: { rosterRevision: 'rev-hosted-1', contributions: [], elapsedMs: 12 },
    });
    // describe() is cached across both calls until invalidate() is called.
    expect(describeCalls).toBe(1);
    // Custom deadlineMs + 5s slack overrides SignetClient's default timeout.
    expect(executeTimeouts[1]).toBe(12_000);
    expect(hosts[0]?.[1]).toMatchObject({
      status: 'serving',
      expected: 2,
      held: 2,
      remote: 'kingdom:api.kingdom.test',
    });

    remotes.invalidate();
    await remotes.remote('my-app')!.call('chorus.advise', { moment: 'After snapshot' });
    expect(describeCalls).toBe(2);
  });
});

describe('createKingdomChorusTransport', () => {
  test('maps structured Kingdom refusals, validates result schema, and retries describe once on 403', async () => {
    const projectId = Bun.randomUUIDv7();
    const signetId = Bun.randomUUIDv7();
    const integrationId = Bun.randomUUIDv7();
    let resourceId = Bun.randomUUIDv7();
    let describeCalls = 0;
    let nextOutcome: 'warming' | 'offline' | 'timeout' | 'bad-result' | 'stale-403-then-ok' =
      'warming';

    const handle: SignetAccessHandle = {
      signetId,
      describe: async () => {
        describeCalls += 1;
        return {
          signetId,
          name: 'Test Signet',
          expiresAt: null,
          lifecycle: 'ongoing',
          taskId: null,
          currentRevision: 1,
          remainingRequests: null,
          dropped: [],
          operations: [
            {
              key: 'chorus.advise',
              name: 'Advise',
              resources: [
                {
                  id: resourceId,
                  name: 'Chorus',
                  kind: chorusResourceKind,
                  externalId: projectId,
                  integrationId,
                  provider: 'chorus',
                },
              ],
            },
          ],
        };
      },
      execute: async (req) => {
        if (nextOutcome === 'warming') {
          throw new SignetHttpError(
            503,
            'chorus_warming; execution x',
            'chorus_warming',
            'Warming up',
          );
        }
        if (nextOutcome === 'offline') {
          throw new SignetHttpError(503, 'host_offline', 'host_offline');
        }
        if (nextOutcome === 'timeout') {
          throw new SignetHttpError(504, 'host_timeout; execution x', 'host_timeout');
        }
        if (nextOutcome === 'bad-result') {
          return { executionId: Bun.randomUUIDv7(), result: { bogus: true } };
        }
        if (req.input.resourceId !== resourceId) {
          throw new SignetHttpError(403, 'Resource rotated');
        }
        return {
          executionId: Bun.randomUUIDv7(),
          result: { rosterRevision: 'rev-rotated', contributions: [], elapsedMs: 5 },
        };
      },
    };

    const { transport } = createKingdomChorusTransport({
      endpoint: 'kingdom:test',
      signets: async () => [handle],
    });

    expect(await transport('chorus.advise', { projectId, input: { moment: 'a' } }, 5_000)).toEqual({
      ok: false,
      refusal: 'chorus_warming',
      message: 'Warming up',
    });

    nextOutcome = 'offline';
    expect(await transport('chorus.advise', { projectId, input: { moment: 'b' } }, 5_000)).toEqual({
      ok: false,
      refusal: 'chorus_unavailable',
      message: 'host_offline',
    });

    nextOutcome = 'timeout';
    expect(
      await transport('chorus.advise', { projectId, input: { moment: 'c' } }, 5_000),
    ).toMatchObject({ ok: false, failure: 'timeout' });

    nextOutcome = 'bad-result';
    expect(
      await transport('chorus.advise', { projectId, input: { moment: 'd' } }, 5_000),
    ).toMatchObject({ ok: false, failure: 'invalid-response' });

    // Rotate resourceId on Kingdom: first execute hits 403, transport re-describes once and succeeds.
    nextOutcome = 'stale-403-then-ok';
    const beforeRefresh = describeCalls;
    resourceId = Bun.randomUUIDv7();
    expect(await transport('chorus.advise', { projectId, input: { moment: 'e' } }, 5_000)).toEqual({
      ok: true,
      result: { rosterRevision: 'rev-rotated', contributions: [], elapsedMs: 5 },
    });
    expect(describeCalls).toBe(beforeRefresh + 1);

    // Unknown project returns unknown_project without calling execute.
    expect(
      await transport(
        'chorus.advise',
        { projectId: Bun.randomUUIDv7(), input: { moment: 'f' } },
        5_000,
      ),
    ).toMatchObject({ ok: false, refusal: 'unknown_project' });
  });

  test('does not retry on structured 403 host_unavailable and falls back across multiple Signets on unstructured 403', async () => {
    const projectId = Bun.randomUUIDv7();
    const integrationId = Bun.randomUUIDv7();
    const resourceId = Bun.randomUUIDv7();
    const signet1 = Bun.randomUUIDv7();
    const signet2 = Bun.randomUUIDv7();
    let describeCount = 0;
    let executeCount = 0;
    let hostUnavailable = true;

    const makeHandle = (signetId: string, fail403: boolean): SignetAccessHandle => ({
      signetId,
      describe: async () => {
        describeCount += 1;
        return {
          signetId,
          name: signetId,
          expiresAt: null,
          lifecycle: 'ongoing',
          taskId: null,
          currentRevision: 1,
          remainingRequests: null,
          dropped: [],
          operations: [
            {
              key: 'chorus.advise',
              name: 'Advise',
              resources: [
                {
                  id: resourceId,
                  name: 'Chorus',
                  kind: chorusResourceKind,
                  externalId: projectId,
                  integrationId,
                  provider: 'chorus',
                },
              ],
            },
          ],
        };
      },
      execute: async () => {
        executeCount += 1;
        if (hostUnavailable) {
          throw new SignetHttpError(403, 'host_unavailable', 'host_unavailable');
        }
        if (fail403) {
          throw new SignetHttpError(403, 'Signet quota exhausted');
        }
        return {
          executionId: Bun.randomUUIDv7(),
          result: { rosterRevision: 'rev-signet2', contributions: [], elapsedMs: 3 },
        };
      },
    });

    const { transport } = createKingdomChorusTransport({
      endpoint: 'kingdom:test',
      signets: async () => [makeHandle(signet1, true), makeHandle(signet2, false)],
    });

    // Structured 403 host_unavailable must NOT trigger cache bust, re-describe, or duplicate execute.
    expect(await transport('chorus.advise', { projectId, input: { moment: 'a' } }, 5_000)).toEqual({
      ok: false,
      refusal: 'chorus_unavailable',
      message: 'host_unavailable',
    });
    expect(describeCount).toBe(1);
    expect(executeCount).toBe(1);

    // Unstructured 403 on signet1 falls back to signet2 and succeeds.
    hostUnavailable = false;
    expect(await transport('chorus.advise', { projectId, input: { moment: 'b' } }, 5_000)).toEqual({
      ok: true,
      result: { rosterRevision: 'rev-signet2', contributions: [], elapsedMs: 3 },
    });
  });

  test('end-to-end over HTTP with real SignetClient DPoP proofs against a Kingdom access server', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'foundry-kingdom-chorus-e2e-'));
    const projectId = Bun.randomUUIDv7();
    const signetId = Bun.randomUUIDv7();
    const integrationId = Bun.randomUUIDv7();
    const resourceId = Bun.randomUUIDv7();
    const accessToken = `kingdom_${'A'.repeat(43)}`;
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const privateKey = keys.privateKey.export({ format: 'jwk' });
    const keyFile = join(tmp, 'installation-key.json');
    const credFile = join(tmp, `signet-${signetId}.json`);
    const nonces = new Set<string>();
    let mode: 'ok' | 'warming' = 'ok';

    const kingdomServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const parsed = new URL(request.url);
        if (request.method === 'POST' && parsed.pathname === '/api/v1/access/nonce') {
          const nonce = 'N'.repeat(43);
          nonces.add(nonce);
          return Response.json({ data: { nonce } });
        }
        const auth = request.headers.get('authorization');
        const proof = request.headers.get('dpop') ?? '';
        if (auth !== `DPoP ${accessToken}`) return new Response('Unauthorized', { status: 401 });
        const verified = await verifySignetProof({
          proof,
          url: `${parsed.origin}${parsed.pathname}`,
          method: 'POST',
          now: new Date(),
          token: accessToken,
        });
        if (!nonces.has(verified.nonce)) return new Response('Bad nonce', { status: 401 });

        if (parsed.pathname === '/api/v1/access/describe') {
          return Response.json({
            data: {
              signetId,
              name: 'Hosted Foundry Signet',
              expiresAt: null,
              lifecycle: 'ongoing',
              taskId: null,
              currentRevision: 1,
              remainingRequests: null,
              operations: [
                {
                  key: 'chorus.conventions',
                  name: 'Conventions',
                  resources: [
                    {
                      id: resourceId,
                      name: 'Chorus',
                      kind: chorusResourceKind,
                      externalId: projectId,
                      integrationId,
                      provider: 'chorus',
                    },
                  ],
                },
              ],
            },
          });
        }
        if (parsed.pathname === '/api/v1/access/execute') {
          const body = (await request.json()) as {
            integrationId: string;
            operation: string;
            input: { resourceId: string; domain?: string };
          };
          expect(body.integrationId).toBe(integrationId);
          expect(body.input.resourceId).toBe(resourceId);
          if (mode === 'warming') {
            return Response.json(
              {
                message: 'chorus_warming; execution exec-1',
                details: [{ code: 'chorus_warming', message: 'Chorus host is warming' }],
              },
              { status: 503 },
            );
          }
          return Response.json({
            data: {
              executionId: Bun.randomUUIDv7(),
              result: {
                domain: body.input.domain ?? 'auth',
                found: true,
                title: 'Authentication',
                summary: 'Use requireAuth.',
                rosterRevision: 'rev-e2e-1',
              },
            },
          });
        }
        return new Response('Not found', { status: 404 });
      },
    });

    try {
      const origin = `http://127.0.0.1:${kingdomServer.port}`;
      mkdirSync(tmp, { recursive: true, mode: 0o700 });
      writeFileSync(keyFile, JSON.stringify(privateKey), { mode: 0o600 });
      writeFileSync(
        credFile,
        JSON.stringify({
          url: origin,
          signetId,
          enrollmentId: Bun.randomUUIDv7(),
          keyFile,
          lifecycle: 'ongoing',
          taskId: null,
          accessToken,
          tokenType: 'DPoP',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          renewalCredential: `signet_renew_${'R'.repeat(43)}`,
          renewalExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          idleExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
        { mode: 0o600 },
      );

      const client = new SignetClient(origin, credFile, signetId);
      const { transport } = createKingdomChorusTransport({
        endpoint: `kingdom:127.0.0.1:${kingdomServer.port}`,
        signets: async () => [client],
      });
      const remote = createChorusRemote({
        projectId,
        endpoint: `kingdom:127.0.0.1:${kingdomServer.port}`,
        transport,
      });

      const ok = await remote.call('chorus.conventions', { domain: 'auth' });
      expect(ok).toEqual({
        ok: true,
        result: {
          domain: 'auth',
          found: true,
          title: 'Authentication',
          summary: 'Use requireAuth.',
          rosterRevision: 'rev-e2e-1',
        },
      });

      mode = 'warming';
      const warming = await remote.call('chorus.conventions', { domain: 'auth' });
      expect(warming).toEqual({
        ok: false,
        refusal: 'chorus_warming',
        message: 'Chorus host is warming',
      });
    } finally {
      await kingdomServer.stop(true);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
