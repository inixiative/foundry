// The dev-mode Chorus client (R-2026-11-25-05) against a stand-in host: each wire answer as its outcome.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createChorusRemote } from '../src/providers/chorus-client';
import { chorusDevRemotes } from '../src/providers/chorus-dev-remotes';
import { directChorusTransport } from '../src/providers/chorus-direct-transport';
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

describe('chorusDevRemotes', () => {
  test('off without the setting; on, one remote per project, the token read on every call, the host state recorded', async () => {
    const setting = { current: undefined as { url: string; tokenKey: string } | undefined };
    const reads: string[] = [];
    const hosts: Array<[string, ProjectHostState]> = [];
    const remotes = chorusDevRemotes({
      setting: () => setting.current,
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
    const remotes = chorusDevRemotes({
      setting: () => ({ url: dead, tokenKey: 'CHORUS_DEV_TOKEN' }),
      readToken: async () => 'devtoken',
      onHost: (_id, state) => hosts.push(state),
    });
    await remotes.activate('p1');
    expect(hosts[0]).toMatchObject({ status: 'failed', failures: 1, remote: dead });
  });
});
