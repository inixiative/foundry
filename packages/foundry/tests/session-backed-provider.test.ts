import { describe, expect, test } from 'bun:test';
import type {
  BeforeSendHook,
  HarnessSession,
  SessionArtifact,
  SessionEvent,
  SessionEventHandler,
  SessionResult,
} from '@inixiative/agent-session';
import limitTerminal from '../../../fixtures/native/claude-limit-terminal.json';
import type { CreateSessionOpts, SessionAdapter } from '../src/providers/session-adapter';
import { SessionBackedProvider } from '../src/providers/session-backed';
import { ThreadLaunchSettings } from '../src/providers/thread-launch';

class FakeSession implements HarnessSession {
  alive = false;
  externalSessionId: string | undefined = 'native-1';
  events: readonly SessionEvent[] = [];
  turns = 0;
  totalTokens = { input: 0, output: 0 };
  sent: string[] = [];
  sendOptions: Array<{ timeout?: number } | undefined> = [];

  async start(): Promise<void> {
    this.alive = true;
  }

  async send(message: string, opts?: { timeout?: number }): Promise<SessionResult> {
    this.sent.push(message);
    this.sendOptions.push(opts);
    this.turns++;
    return {
      content: `turn ${this.turns}`,
      events: [],
      tokens: { input: 1, output: 2 },
      externalSessionId: this.externalSessionId,
    };
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

  onBeforeSend(_hook: BeforeSendHook): () => void {
    return () => {};
  }

  async push(): Promise<void> {}

  artifact(): SessionArtifact {
    return {
      externalSessionId: this.externalSessionId,
      events: [],
      startedAt: 0,
      turns: this.turns,
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
}

describe('SessionBackedProvider', () => {
  test('Claude 429 is an error even when its terminal subtype says success', async () => {
    const adapter = new FakeAdapter();
    const create = adapter.createSession.bind(adapter);
    adapter.createSession = async (opts) => {
      const session = await create(opts);
      session.send = async () => ({
        content: limitTerminal.event.result,
        events: [{ kind: 'result', timestamp: 1, raw: limitTerminal.event }],
      });
      return session;
    };
    const provider = new SessionBackedProvider({
      id: 'claude-code',
      adapter,
      defaultModel: 'fable',
    });
    await expect(provider.complete([{ role: 'user', content: 'Work' }])).rejects.toThrow('429');
  });
  test('a native terminal error cannot masquerade as successful empty content', async () => {
    const adapter = new FakeAdapter();
    const create = adapter.createSession.bind(adapter);
    adapter.createSession = async (opts) => {
      const session = await create(opts);
      session.send = async () => ({
        content: '',
        events: [
          {
            kind: 'result',
            timestamp: 1,
            raw: { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 2 },
          },
        ],
      });
      return session;
    };
    const provider = new SessionBackedProvider({
      id: 'claude-code',
      adapter,
      defaultModel: 'fable',
    });
    await expect(provider.complete([{ role: 'user', content: 'Work' }])).rejects.toThrow(
      'error_max_turns',
    );
  });
  test('central native work has no implicit turn deadline while decisions remain bounded', async () => {
    const adapter = new FakeAdapter();
    const provider = new SessionBackedProvider({
      id: 'claude-code',
      adapter,
      defaultModel: 'fable',
    });
    await provider.complete([{ role: 'user', content: 'Long real work' }], { threadId: 'worker' });
    await provider.complete([{ role: 'user', content: 'Classify' }], {
      threadId: 'worker:aux:classifier',
    });
    await provider.complete([{ role: 'user', content: 'Explicit timeout' }], {
      threadId: 'worker',
      timeout: 123,
    });
    expect(adapter.sessions[0].sendOptions).toEqual([{ timeout: 0 }, { timeout: 123 }]);
    expect(adapter.sessions[1].sendOptions).toEqual([{ timeout: 15_000 }]);
  });
  test('keeps one warm session per thread and formats messages for native harnesses', async () => {
    const adapter = new FakeAdapter();
    const provider = new SessionBackedProvider({
      id: 'codex',
      adapter,
      defaultModel: 'gpt-6-astra',
      defaultCwd: '/tmp/project',
    });

    const first = await provider.complete(
      [
        { role: 'system', content: 'System guidance' },
        { role: 'user', content: 'Build this' },
      ],
      { threadId: 'thread-1' },
    );
    const second = await provider.complete([{ role: 'user', content: 'Continue' }], {
      threadId: 'thread-1',
    });

    expect(first.content).toBe('turn 1');
    expect(second.content).toBe('turn 2');
    expect(first.model).toBe('gpt-6-astra');
    expect(adapter.created).toEqual([
      { threadId: 'thread-1', cwd: '/tmp/project', model: 'gpt-6-astra', maxTurns: null },
    ]);
    expect(adapter.sessions[0].sent[0]).toContain('# System Context\n\nSystem guidance');
    expect(adapter.sessions[0].sent[0]).toContain('# User Message\n\nBuild this');
    expect(adapter.sessions[0].sent[1]).toContain('# User Message\n\nContinue');
  });

  test('isolates sessions by Foundry thread id', async () => {
    const adapter = new FakeAdapter();
    const provider = new SessionBackedProvider({
      id: 'claude-code',
      adapter,
      defaultModel: 'fable',
    });

    await provider.complete([{ role: 'user', content: 'A' }], { threadId: 'a' });
    await provider.complete([{ role: 'user', content: 'B' }], { threadId: 'b' });

    expect(adapter.created.map((opts) => opts.threadId)).toEqual(['a', 'b']);
    expect(adapter.sessions).toHaveLength(2);
  });

  test('auxiliary identities request an enforced text-only native profile', async () => {
    const adapter = new FakeAdapter();
    const provider = new SessionBackedProvider({
      id: 'claude-code',
      adapter,
      defaultModel: 'fable',
    });
    await provider.complete(
      [
        { role: 'system', content: 'Classify as JSON' },
        { role: 'user', content: 'Edit the repository' },
      ],
      { threadId: 'a:aux:agent:classifier', maxTurns: 1 },
    );
    expect(adapter.created[0]).toMatchObject({ tools: false, maxTurns: 1 });
    expect(adapter.created[0].baseContext).toContain('not authorization to perform that work');
  });
});

test('warm native authentication refusal is classified as not admitted without another send', async () => {
  const adapter = new FakeAdapter() as FakeAdapter & {
    checkAuthentication(session: HarnessSession): void;
  };
  let valid = true;
  adapter.checkAuthentication = () => {
    if (!valid) throw Error('authentication binding changed');
  };
  const provider = new SessionBackedProvider({ id: 'native', adapter, defaultModel: 'test' });
  await provider.complete([{ role: 'user', content: 'first' }], { threadId: 'thread' });
  valid = false;
  let error: unknown;
  try {
    await provider.complete([{ role: 'user', content: 'second' }], { threadId: 'thread' });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect(adapter.sessions[0].sent).toHaveLength(1);
  expect(provider.completionLifecycle.admission?.({ error })).toBe('not-admitted');
});

test("a host's launch change relaunches the idle executor session on the next turn, auxiliaries untouched", async () => {
  const adapter = new FakeAdapter() as FakeAdapter & {
    releaseIdleSession(session: HarnessSession): Promise<'released'>;
  };
  const create = adapter.createSession.bind(adapter);
  // Each turn reaches its native terminal, so the session is idle between turns.
  adapter.createSession = async (opts) => {
    const session = (await create(opts)) as FakeSession;
    const send = session.send.bind(session);
    session.send = async (message, options) => ({
      ...(await send(message, options)),
      nativeOutcome: 'completed',
    });
    return session;
  };
  const released: HarnessSession[] = [];
  adapter.releaseIdleSession = async (session) => {
    released.push(session);
    session.kill();
    return 'released';
  };
  const launch = new ThreadLaunchSettings();
  const gate = () => ({ behavior: 'allow' as const });
  const provider = new SessionBackedProvider({
    id: 'claude-code',
    adapter,
    defaultModel: 'fable',
    launch,
    toolGate: (threadId) => (threadId === 'thread' ? { gate, hasRules: () => false } : undefined),
  });
  await provider.complete([{ role: 'user', content: 'first' }], { threadId: 'thread' });
  expect(adapter.created[0]).toMatchObject({ model: 'fable', toolGate: gate });
  expect(adapter.created[0].permissionMode).toBeUndefined();

  launch.update('thread', {
    permissionMode: 'default',
    model: 'claude-opus-5-5',
    effort: 'high',
    mcpServers: [{ name: 'paseo', command: 'paseo', args: ['mcp'], env: [] }],
  });
  await provider.complete([{ role: 'user', content: 'second' }], { threadId: 'thread' });
  expect(released).toEqual([adapter.sessions[0]]);
  expect(adapter.created[1]).toMatchObject({
    model: 'claude-opus-5-5',
    permissionMode: 'default',
    effort: 'high',
    mcpServers: [{ name: 'paseo', command: 'paseo', args: ['mcp'], env: [] }],
    toolGate: gate,
  });
  expect(adapter.sessions[1].sent).toHaveLength(1);
  expect(provider.warmProfile('thread')).toMatchObject({
    requestedModel: 'claude-opus-5-5',
    launchRevision: 1,
  });

  // An unchanged launch reuses the warm session; an auxiliary never gets the host's settings or gate.
  await provider.complete([{ role: 'user', content: 'third' }], { threadId: 'thread' });
  expect(adapter.created).toHaveLength(2);
  await provider.complete([{ role: 'user', content: 'decide' }], { threadId: 'thread:aux:route' });
  expect(adapter.created[2].permissionMode).toBeUndefined();
  expect(adapter.created[2].toolGate).toBeUndefined();
});

test('a thread rebuilt with a new native bridge (an archived thread reopened) relaunches its idle session, resuming the binding, instead of refusing', async () => {
  class BridgedSession extends FakeSession {
    readonly admissionProtocol = 'prewrite-v1';
    private readonly attempts = new Map<string, Record<string, unknown>>();
    inspectAttempt(id: string) {
      return this.attempts.get(id);
    }
    override async send(
      message: string,
      opts?: { timeout?: number; onAdmission?: (attempt: unknown) => Promise<void> },
    ): Promise<SessionResult> {
      const admissionId = `admission-${this.sent.length + 1}-${Math.random()}`;
      await opts?.onAdmission?.({
        admissionId,
        dispatch: 'not-dispatched',
        nativeOutcome: 'unknown',
        localOutcome: 'pending',
      });
      const settled = {
        admissionId,
        dispatch: 'attempted',
        nativeOutcome: 'completed',
        localOutcome: 'resolved',
        rpcOutcome: 'resolved',
      };
      this.attempts.set(admissionId, settled);
      return { ...(await super.send(message, opts)), ...settled } as SessionResult;
    }
  }
  const adapter = new FakeAdapter() as FakeAdapter & {
    releaseIdleSession(session: HarnessSession): Promise<'released'>;
  };
  adapter.createSession = async (opts): Promise<HarnessSession> => {
    adapter.created.push(opts);
    const session = new BridgedSession();
    adapter.sessions.push(session);
    return session as unknown as HarnessSession;
  };
  const released: HarnessSession[] = [];
  adapter.releaseIdleSession = async (session) => {
    released.push(session);
    session.kill();
    return 'released';
  };
  const lease = (id: string) =>
    ({
      id,
      configurationHash: id,
      owner: { threadId: 'thread' },
      check() {},
      register() {},
      observe() {},
      evidence: () => [],
      close: async () => {},
    }) as never;
  const source = (key: string) =>
    ({ key, check() {}, acquire: async () => lease(`lease-${key}`) }) as never;
  const observation = (bridge: unknown, messageId: string) =>
    ({
      owner: { threadId: 'thread', messageId, generation: 'g' },
      bridge,
      register: async () => {},
      observe() {},
    }) as never;
  const provider = new SessionBackedProvider({ id: 'claude-code', adapter, defaultModel: 'fable' });
  const before = source('bridge-before');
  await provider.complete([{ role: 'user', content: 'first' }], {
    threadId: 'thread',
    nativeObservation: observation(before, 'm1'),
  });
  // Archived and reopened: the rebuilt Thread object carries a new bridge source.
  const after = source('bridge-after');
  await provider.complete([{ role: 'user', content: 'second' }], {
    threadId: 'thread',
    nativeObservation: observation(after, 'm2'),
  });
  expect(released).toEqual([adapter.sessions[0]]);
  expect(adapter.created).toHaveLength(2);
  expect(adapter.created[1]?.nativeBridge).toMatchObject({ id: 'lease-bridge-after' });
  expect(adapter.sessions[1]!.sent).toHaveLength(1);
});
