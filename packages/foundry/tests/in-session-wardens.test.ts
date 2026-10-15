import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  HarnessSession,
  SessionArtifact,
  SessionEventHandler,
  SessionResult,
} from '@inixiative/agent-session';
import {
  ContextStack,
  EventStream,
  Executor,
  Harness,
  InterventionLog,
  type NativeEvidence,
  Thread,
  type ThreadMeta,
  type ThreadSetup,
} from '@inixiative/foundry-core';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import type { NativeTextConfig } from '../src/providers/native-text-provider';
import type { CreateSessionOpts, SessionAdapter } from '../src/providers/session-adapter';
import { SessionBackedProvider } from '../src/providers/session-backed';
import { buildSubscriptionDecisions } from '../src/providers/subscription-decisions';
import { ThreadLaunchSettings } from '../src/providers/thread-launch';
import { SubagentRecorder, type SubagentToolCall } from '../src/turns/subagents';
import { createViewer } from '../src/viewer/server';
import { until } from './helpers/live-watch-fixture';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

test('a turn waits queued while its thread sets up its Wardens; setup streams on the thread meta', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-setup-'));
  const started: string[] = [];
  const main = new Thread('main', new ContextStack());
  main.register(
    new Executor({
      id: 'worker',
      stack: main.stack,
      handler: async (_context, payload) => {
        started.push(String(payload));
        return `done:${payload}`;
      },
    }),
  );
  const harness = new Harness(main);
  harness.setDefaultExecutor('worker');
  let ready!: () => void;
  const opened: Array<{ threadId: string; bridge: boolean }> = [];
  const listeners: Array<(threadId: string, setup: ThreadSetup) => void> = [];
  const setup = (status: ThreadSetup['status'], held: number): ThreadSetup => ({
    status,
    startedAt: 1,
    wardens: { expected: 3, held, failed: [] },
    runtime: 'claude-in-session',
  });
  const viewer = createViewer({
    harness,
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    configDir: dir,
    threadSetup: {
      open: async (threadId, opts) => {
        opened.push({ threadId, bridge: !!opts.bridge });
        for (const l of listeners) l(threadId, setup('starting', 1));
        await new Promise<void>((resolve) => {
          ready = resolve;
        });
        for (const l of listeners) l(threadId, setup('ready', 3));
      },
      pending: () => !ready,
      onSetup: (listener) => {
        listeners.push(listener);
      },
    },
  });
  cleanup.push(async () => {
    ready?.();
    await viewer.analyticsReady.catch(() => {});
    viewer.localStore?.close();
    rmSync(dir, { force: true, recursive: true });
  });
  const response = await viewer.app.request('/api/messages/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'turn-1', threadId: 'main', message: 'hello' }),
  });
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ queued: false, settingUp: true });
  await until(() => opened.length === 1, 'setup opened');
  expect(opened[0]).toEqual({ threadId: 'main', bridge: false });
  expect(main.meta.setup?.status).toBe('starting');
  // Nothing ran: the turn waits queued until the Wardens are held.
  await Bun.sleep(50);
  expect(started).toEqual([]);
  expect(viewer.localStore!.turn('turn-1')?.status).toBe('queued');
  ready();
  await until(() => started.length === 1, 'turn ran');
  expect(main.meta.setup).toMatchObject({ status: 'ready', wardens: { held: 3 } });
});

test('decisions served in-session take no shared decision slot', async () => {
  const gates: Array<() => void> = [];
  const runs: string[] = [];
  const createRun = (_config: NativeTextConfig) => {
    const calls: Array<Record<string, unknown>> = [];
    let closed = false;
    return {
      provider: {
        id: 'fake',
        async complete(
          _messages: unknown,
          opts: {
            nativeObservation?: {
              owner: { providerSessionKey?: string };
              register(e: NativeEvidence): Promise<void>;
              observe(e: NativeEvidence): Promise<void>;
            };
          } = {},
        ) {
          const key = opts.nativeObservation!.owner.providerSessionKey!;
          runs.push(key);
          const admission: NativeEvidence = {
            schema: 1,
            owner: opts.nativeObservation!.owner as NativeEvidence['owner'],
            admissionId: crypto.randomUUID(),
            nativeOutcome: 'unknown',
            localOutcome: 'pending',
            dispatch: 'not-dispatched',
          };
          await opts.nativeObservation!.register(admission);
          await new Promise<void>((resolve) => gates.push(resolve));
          const native = {
            ...admission,
            nativeOutcome: 'completed' as const,
            localOutcome: 'resolved' as const,
            dispatch: 'attempted' as const,
          };
          calls.push({ valid: true, release: 'released', transport: 'primed', settled: true });
          return { content: 'ok', model: 'm', native };
        },
      },
      snapshot: () => ({ closed, calls: calls as never }),
      close: () => {
        closed = true;
      },
    };
  };
  const decisions = buildSubscriptionDecisions(
    {
      source: {
        id: 's',
        runtime: 'claude',
        mode: 'native-profile',
        profileDirectory: '/x',
      } as never,
      directory: '/tmp',
      model: 'm',
      maxCalls: 100,
      maxQueued: 100,
      callTimeoutMs: 20_000,
      maxConcurrent: 1,
      unbounded: (key) => key.includes(':aux:domain:'),
    },
    createRun as never,
  );
  cleanup.push(() => decisions.close());
  const ask = (key: string) =>
    decisions.provider.complete([{ role: 'user', content: 'x' }], { threadId: key });
  const warden1 = ask('t1:aux:domain:a');
  const warden2 = ask('t1:aux:domain:b');
  const router1 = ask('t1:aux:router');
  const router2 = ask('t1:aux:router2');
  await until(() => runs.length === 3, 'started');
  // Both Wardens and one router run at once; the second router waits for the one shared slot.
  expect(runs.sort()).toEqual(['t1:aux:domain:a', 't1:aux:domain:b', 't1:aux:router']);
  for (const release of gates.splice(0)) release();
  await Promise.all([warden1, warden2, router1]);
  await until(() => runs.length === 4, 'queued router started');
  for (const release of gates.splice(0)) release();
  await router2;
});

class FakeSession implements HarnessSession {
  alive = false;
  externalSessionId: string | undefined = 'native-1';
  events = [];
  turns = 0;
  totalTokens = { input: 0, output: 0 };
  sent: string[] = [];
  async start(): Promise<void> {
    this.alive = true;
  }
  async send(message: string): Promise<SessionResult> {
    this.sent.push(message);
    this.turns++;
    return { content: `turn ${this.turns}`, events: [], externalSessionId: this.externalSessionId };
  }
  fork(): HarnessSession {
    return new FakeSession();
  }
  interrupt(): void {}
  kill(): void {
    this.alive = false;
  }
  onEvent(_handler: SessionEventHandler): () => void {
    return () => {};
  }
  onBeforeSend(): () => void {
    return () => {};
  }
  async push(): Promise<void> {}
  artifact(): SessionArtifact {
    return {
      externalSessionId: 'native-1',
      events: [],
      startedAt: 0,
      turns: 0,
      totalTokens: this.totalTokens,
      toolCalls: 0,
      toolResults: 0,
      errors: 0,
    };
  }
}

class FakeAdapter implements SessionAdapter {
  runtime = 'fake';
  created: CreateSessionOpts[] = [];
  sessions: FakeSession[] = [];
  async createSession(opts: CreateSessionOpts): Promise<HarnessSession> {
    this.created.push(opts);
    const session = new FakeSession();
    this.sessions.push(session);
    return session;
  }
  async getExternalSessionId(): Promise<string | null> {
    return null;
  }
  async clearSession(): Promise<void> {}
  async releaseIdleSession(session: HarnessSession): Promise<'released'> {
    session.kill();
    return 'released';
  }
}

test('a session opened ahead of the first turn is adopted by it, or relaunched when the turn asks for another model', async () => {
  const adapter = new FakeAdapter();
  const provider = new SessionBackedProvider({
    id: 'claude-code',
    adapter,
    defaultModel: 'opus',
    launch: new ThreadLaunchSettings(),
  });
  await provider.open('t1', { cwd: '/w' });
  expect(adapter.sessions.length).toBe(1);
  expect(adapter.sessions[0]!.alive).toBe(true);
  expect(adapter.created[0]).toMatchObject({ threadId: 't1', cwd: '/w', model: 'opus' });
  expect(provider.warmProfile('t1', '/w')?.provisional).toBe(true);
  // Opening again leaves it as it is; nothing was sent.
  await provider.open('t1', { cwd: '/w' });
  expect(adapter.sessions.length).toBe(1);
  expect(adapter.sessions[0]!.sent).toEqual([]);
  // The first turn with the same profile adopts it.
  await provider.complete([{ role: 'user', content: 'Work' }], { threadId: 't1', cwd: '/w' });
  expect(adapter.sessions.length).toBe(1);
  expect(provider.warmProfile('t1', '/w')?.provisional).toBe(false);

  // Another thread's first turn asks for a different model: the opened session is relaunched.
  await provider.open('t2', { cwd: '/w' });
  await provider.complete([{ role: 'user', content: 'Work' }], {
    threadId: 't2',
    cwd: '/w',
    model: 'sonnet',
  });
  expect(adapter.sessions.length).toBe(3);
  expect(adapter.sessions[1]!.alive).toBe(false);
  expect(adapter.created[2]).toMatchObject({ threadId: 't2', model: 'sonnet' });
});

test("a subagent's tool calls go to the root thread's guard Wardens, on the subagent's node", () => {
  const store = new LocalSessionStore(':memory:');
  cleanup.push(() => store.close());
  const root = {
    id: 'main',
    meta: {
      description: 'Main',
      tags: [],
      status: 'active',
      createdAt: 1,
      lastActiveAt: 1,
    } satisfies ThreadMeta,
  };
  store.saveThread(root);
  store.beginTurn(root, 'turn-1', 'Explore');
  const calls: Array<{ root: string; call: SubagentToolCall }> = [];
  const recorder = new SubagentRecorder({
    store,
    thread: (id) => store.threads().find((t) => t.id === id),
    observeTool: (rootId, call) => calls.push({ root: rootId, call }),
  });
  const base = { schema: 1 as const, nativeOutcome: 'unknown' as const };
  recorder.observe('main', {
    ...base,
    kind: 'subagent',
    subagent: {
      phase: 'started',
      taskId: 'task-1',
      toolUseId: 'toolu_spawn',
      agentType: 'general-purpose',
      prompt: 'Look around',
    },
  });
  recorder.observe('main', {
    ...base,
    kind: 'tool_use',
    parentToolUseId: 'toolu_spawn',
    callId: 'toolu_w',
    toolName: 'Write',
    toolInput: { file_path: 'a.ts' },
  });
  expect(calls).toEqual([]);
  recorder.observe('main', {
    ...base,
    kind: 'tool_result',
    parentToolUseId: 'toolu_spawn',
    callId: 'toolu_w',
    toolOutput: 'written',
    toolError: false,
  });
  expect(calls.length).toBe(1);
  expect(calls[0]!.root).toBe('main');
  expect(calls[0]!.call).toMatchObject({
    callId: 'toolu_w',
    tool: 'Write',
    input: { file_path: 'a.ts' },
    output: 'written',
    ok: true,
  });
  expect(calls[0]!.call.node.meta.parentThreadId).toBe('main');
  expect(calls[0]!.call.turnId).toBeTruthy();
});
