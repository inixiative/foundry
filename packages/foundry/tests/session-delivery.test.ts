import { describe, expect, test } from 'bun:test';
import type {
  BeforeSendHook,
  HarnessSession,
  SessionArtifact,
  SessionEvent,
  SessionEventHandler,
  SessionResult,
} from '@inixiative/agent-session';
import {
  type DeliveryRecord,
  type InjectionArtifact,
  newId,
  type SessionDelivery,
  type SessionDeliveryReport,
  standingPart,
  standingParts,
} from '@inixiative/foundry-core';
import type { CreateSessionOpts, SessionAdapter } from '../src/providers/session-adapter';
import { DECISION_CONTEXT, SessionBackedProvider } from '../src/providers/session-backed';
import { baseContextOf, sessionTurn } from '../src/providers/session-delivery';
import {
  domainKnowledge,
  domains,
  instructions,
  interpretation,
  learned,
  m0Scenario,
} from './helpers/m0-domain-loop';

/** A prewrite-capable native session that records every prompt it was sent. */
class RecordingSession implements HarnessSession {
  readonly admissionProtocol = 'prewrite-v1' as const;
  alive = false;
  /** Fresh sessions learn their native id on the first turn; a resumed one would know it at construction. */
  externalSessionId: string | undefined;
  events: readonly SessionEvent[] = [];
  turns = 0;
  totalTokens = { input: 0, output: 0 };
  sent: string[] = [];
  fail = false;
  /** Runs while the turn is in flight, e.g. a native compaction. */
  during?: () => Promise<void>;
  private _attempts = new Map<string, Record<string, unknown>>();

  async start(): Promise<void> {
    this.alive = true;
  }

  inspectAttempt(id: string) {
    const attempt = this._attempts.get(id);
    return attempt ? (structuredClone(attempt) as never) : undefined;
  }

  async send(
    message: string,
    opts?: { onAdmission?: (attempt: unknown) => Promise<void> },
  ): Promise<SessionResult> {
    this.sent.push(message);
    this.externalSessionId ??= 'native-1';
    if (this.fail) {
      this.fail = false;
      throw Error('send failed before admission');
    }
    this.turns++;
    const attempt: Record<string, unknown> = {
      admissionId: `${this.externalSessionId}-${this.turns}-${this.sent.length}`,
      externalSessionId: this.externalSessionId,
      nativeSessionId: this.externalSessionId,
      dispatch: 'not-dispatched',
      nativeOutcome: 'unknown',
      localOutcome: 'pending',
      events: [],
    };
    this._attempts.set(attempt.admissionId as string, attempt);
    await opts?.onAdmission?.(structuredClone(attempt));
    await this.during?.();
    Object.assign(attempt, {
      dispatch: 'attempted',
      content: `turn ${this.turns}`,
      nativeOutcome: 'completed',
      localOutcome: 'resolved',
      terminal: { type: 'result', subtype: 'success' },
    });
    return {
      ...(structuredClone(attempt) as object),
      content: `turn ${this.turns}`,
      events: [
        {
          kind: 'result',
          timestamp: Date.now(),
          raw: { type: 'result', subtype: 'success', session_id: this.externalSessionId },
        },
      ],
      externalSessionId: this.externalSessionId,
    } as SessionResult;
  }

  fork(): HarnessSession {
    return new RecordingSession();
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

class RecordingAdapter implements SessionAdapter {
  runtime = 'fake';
  created: CreateSessionOpts[] = [];
  sessions: RecordingSession[] = [];
  constructor(readonly baseContextPlacement: 'system-prompt' | 'first-turn' = 'system-prompt') {}
  async createSession(opts: CreateSessionOpts): Promise<HarnessSession> {
    this.created.push(opts);
    const session = new RecordingSession();
    this.sessions.push(session);
    return session;
  }
  async getExternalSessionId(): Promise<string | null> {
    return null;
  }
  async clearSession(): Promise<void> {}
}

const instructionsPart = standingPart('instructions', 'STANDING_INSTRUCTIONS');
const learningV1 = standingPart('learning', 'LEARNING_V1');
const learningV2 = standingPart('learning', 'LEARNING_V2');
const agentPart = standingPart('agent:worker', 'AGENT_PROMPT');
const delivery = (
  learning = learningV1,
  held: Record<string, string> = {},
  turn = 'ROUTING_AND_ADVICE',
): SessionDelivery => ({ standing: [instructionsPart, learning, agentPart], turn, held });
const ids = (parts: readonly { id: string }[]) => parts.map((part) => part.id);
const base = [instructionsPart, learningV1, agentPart].map(({ id, hash }) => ({ id, hash }));
const user = [{ role: 'user' as const, content: 'USER_MESSAGE' }];

describe('sessionTurn', () => {
  const opts = (over: Partial<{ base: typeof base; started: boolean; resumed: boolean }> = {}) => ({
    base,
    started: false,
    resumed: false,
    ...over,
  });

  test('a started session holds its system prompt: the turn carries only the per-turn text', () => {
    const turn = sessionTurn(
      delivery(learningV1, { learning: 'stale-from-old-session' }),
      user,
      opts({ started: true }),
    );
    expect(turn.report).toEqual({ session: 'started', base, sent: [] });
    expect(turn.messages).toEqual([
      { role: 'system', content: 'ROUTING_AND_ADVICE' },
      { role: 'user', content: 'USER_MESSAGE' },
    ]);
  });

  test('a session without a system prompt gets every part in its first turn', () => {
    const turn = sessionTurn(delivery(), user, opts({ base: [], started: true }));
    expect(ids(turn.report.sent)).toEqual(['instructions', 'learning', 'agent:worker']);
    expect(turn.messages[0].content).toContain('STANDING_INSTRUCTIONS');
  });

  test('a resumed conversation may hold older versions as messages: its first turn re-sends every part', () => {
    const turn = sessionTurn(delivery(), user, opts({ started: true, resumed: true }));
    expect(ids(turn.report.sent)).toEqual(['instructions', 'learning', 'agent:worker']);
    const next = sessionTurn(delivery(learningV1, {}), user, opts({ resumed: true }));
    expect(next.report.sent).toEqual([]);
  });

  test('a held session receives only the parts whose hash the ledger does not hold', () => {
    const held = Object.fromEntries(base.map((part) => [part.id, part.hash]));
    const turn = sessionTurn(delivery(learningV2, held), user, opts());
    expect(ids(turn.report.sent)).toEqual(['learning']);
    expect(turn.messages[0].content).toContain('## Context: learning');
    expect(turn.messages[0].content).toContain('it replaces any earlier version');
    expect(turn.messages[0].content).toContain('LEARNING_V2');
    expect(turn.messages[0].content).not.toContain('STANDING_INSTRUCTIONS');
    expect(turn.messages[0].content).toEndWith('ROUTING_AND_ADVICE');
  });

  test('after compaction the system prompt still holds its parts; without one everything is sent', () => {
    expect(ids(sessionTurn(delivery(learningV2, {}), user, opts()).report.sent)).toEqual([
      'learning',
    ]);
    expect(
      ids(sessionTurn(delivery(learningV2, {}), user, opts({ base: [] })).report.sent),
    ).toEqual(['instructions', 'learning', 'agent:worker']);
  });

  test('the ledger wins over the base: a part that changed back to its base version is sent again', () => {
    const turn = sessionTurn(delivery(learningV1, { learning: learningV2.hash }), user, opts());
    expect(ids(turn.report.sent)).toEqual(['learning']);
  });

  test('a part in neither the base nor the ledger is sent; no per-turn text sends no empty block', () => {
    const extra = standingPart('docs', 'DOCS');
    const turn = sessionTurn(
      { standing: [instructionsPart, extra], turn: '', held: {} },
      user,
      opts({ base: [base[0]] }),
    );
    expect(ids(turn.report.sent)).toEqual(['docs']);
    const quiet = sessionTurn(
      { standing: [instructionsPart], turn: '', held: {} },
      user,
      opts({ base: [base[0]] }),
    );
    expect(quiet.messages).toEqual(user);
  });

  test('the system prompt labels each part the way a later delta names it', () => {
    expect(baseContextOf(delivery())).toBe(
      '## Context: instructions\n\nSTANDING_INSTRUCTIONS\n\n## Context: learning\n\nLEARNING_V1\n\n## Context: agent:worker\n\nAGENT_PROMPT',
    );
  });
});

describe('SessionBackedProvider warm-cache delivery', () => {
  test('starts the session with every standing part as base context, then sends only changes', async () => {
    const adapter = new RecordingAdapter();
    const provider = new SessionBackedProvider({ id: 'claude-code', adapter, defaultModel: 'm' });
    const messages = [
      { role: 'system' as const, content: 'STANDING_INSTRUCTIONS LEARNING_V1 AGENT_PROMPT' },
      { role: 'user' as const, content: 'first' },
    ];
    const first = await provider.complete(messages, { threadId: 't', delivery: delivery() });
    expect(adapter.created[0].baseContext).toBe(baseContextOf(delivery()));
    expect(adapter.sessions[0].sent[0]).toBe(
      '# System Context\n\nROUTING_AND_ADVICE\n\n# User Message\n\nfirst',
    );
    expect(first.delivery).toEqual({ session: 'started', base, sent: [] });

    const held = Object.fromEntries(base.map((part) => [part.id, part.hash]));
    const second = await provider.complete([{ role: 'user', content: 'second' }], {
      threadId: 't',
      delivery: delivery(learningV2, held, 'NEXT_ADVICE'),
    });
    expect(adapter.created).toHaveLength(1);
    expect(second.delivery).toMatchObject({ session: 'held', sent: [{ id: 'learning' }] });
    const prompt = adapter.sessions[0].sent[1];
    expect(prompt).toContain('LEARNING_V2');
    expect(prompt).toContain('NEXT_ADVICE');
    expect(prompt).not.toContain('STANDING_INSTRUCTIONS');
    expect(prompt).not.toContain('AGENT_PROMPT');
  });

  test('without a system prompt the first turn carries every part, also when the first send failed', async () => {
    const adapter = new RecordingAdapter('first-turn');
    const provider = new SessionBackedProvider({ id: 'codex', adapter, defaultModel: 'm' });
    const create = adapter.createSession.bind(adapter);
    adapter.createSession = async (opts) => {
      const session = (await create(opts)) as RecordingSession;
      session.fail = true;
      return session;
    };
    await expect(provider.complete(user, { threadId: 't', delivery: delivery() })).rejects.toThrow(
      'send failed',
    );
    expect(adapter.created[0].baseContext).toBeUndefined();
    const retry = await provider.complete(user, {
      threadId: 't',
      delivery: delivery(learningV1, { instructions: 'from-an-earlier-session' }),
    });
    // Nothing reached the model before, so the retry carries every part itself.
    expect(retry.delivery).toEqual({ session: 'started', base: [], sent: base });
    expect(adapter.sessions[0].sent[1]).toContain('STANDING_INSTRUCTIONS');
    const next = await provider.complete(user, {
      threadId: 't',
      delivery: delivery(learningV1, Object.fromEntries(base.map((p) => [p.id, p.hash]))),
    });
    expect(next.delivery).toEqual({ session: 'held', base: [], sent: [] });
  });

  test('decision sessions keep their own base context and ignore delivery', async () => {
    const adapter = new RecordingAdapter();
    const provider = new SessionBackedProvider({ id: 'claude-code', adapter, defaultModel: 'm' });
    const result = await provider.complete(user, {
      threadId: 't:aux:classifier',
      delivery: delivery(),
    });
    expect(adapter.created[0].baseContext).toBe(DECISION_CONTEXT);
    expect(result.delivery).toBeUndefined();
  });
});

type Body = { meta: { injection: InjectionArtifact; delivery: DeliveryRecord } };

test('a thread delivers standing context once, sends a post-hoc learning update as a delta, and redelivers after compaction', async () => {
  const adapter = new RecordingAdapter();
  const f = await m0Scenario({
    session: () => adapter,
    review: (call) => learned(call.thread, call.domain!),
  });
  try {
    const send = async (id: string) => {
      const turn = await f.send('a', id);
      if (turn.status !== 200) throw Error(JSON.stringify(turn.body).slice(0, 2000));
      return (turn.body as Body).meta;
    };
    const session = () => adapter.sessions.find((s) => s.sent.length > 0)!;
    const ledger = () =>
      Object.fromEntries(
        f.current.manager.get('a')!.librarian.state.injectedLayers.map((r) => [r.id, r.hash]),
      );

    const first = await send('t1');
    await f.settled();
    const created = adapter.created.find((c) => !c.threadId.includes(':aux:'))!;
    for (const d of domains) {
      expect(created.baseContext).toContain(instructions(d));
      expect(created.baseContext).toContain(domainKnowledge(d));
      expect(session().sent[0]).not.toContain(instructions(d));
    }
    expect(created.baseContext).toContain('Perform the requested bounded migration.');
    expect(first.delivery.session).toMatchObject({ session: 'started', sent: [] });
    expect(Object.keys(ledger()).sort()).toEqual(
      first.delivery.session!.base.map((part) => part.id).sort(),
    );
    expect(first.injection.sessionDelivery).toEqual(first.delivery.session);

    // The post-hoc review taught each Warden an interpretation: the next turn carries it once.
    const second = await send('t2');
    await f.settled();
    expect(second.delivery.session!.session).toBe('held');
    for (const d of domains) {
      expect(session().sent[1]).toContain(interpretation('a', d));
      expect(session().sent[1]).not.toContain(instructions(d));
    }
    const third = await send('t3');
    await f.settled();
    for (const d of domains) expect(session().sent[2]).not.toContain(interpretation('a', d));
    expect(third.delivery.session!.sent.length).toBeLessThan(second.delivery.session!.sent.length);

    // Compaction clears the ledger: what lived only in the conversation is sent again, the system prompt is not.
    await f.current.manager.get('a')!.thread.signals.emit({
      id: newId('compact'),
      kind: 'session_compacted',
      source: 'session-adapter:fake',
      content: { source: 'fake', threadId: 'a' },
      timestamp: Date.now(),
    });
    await Bun.sleep(0);
    expect(ledger()).toEqual({});
    const fourth = await send('t4');
    for (const d of domains) {
      expect(session().sent[3]).toContain(interpretation('a', d));
      expect(session().sent[3]).not.toContain(instructions(d));
    }
    expect(fourth.delivery.session!.session).toBe('held');
  } finally {
    await f.close();
  }
});

test('a compaction while a turn runs leaves what that turn sent undelivered, so the next turn sends it again', async () => {
  const adapter = new RecordingAdapter();
  const f = await m0Scenario({
    session: () => adapter,
    review: (call) => learned(call.thread, call.domain!),
  });
  try {
    const send = async (id: string) => {
      const turn = await f.send('a', id);
      if (turn.status !== 200) throw Error(JSON.stringify(turn.body).slice(0, 2000));
      return (turn.body as Body).meta;
    };
    await send('c1');
    await f.settled();
    const runtime = f.current.manager.get('a')!;
    const session = adapter.sessions.find((s) => s.sent.length > 0)!;
    session.during = async () => {
      session.during = undefined;
      await runtime.thread.signals.emit({
        id: newId('compact'),
        kind: 'session_compacted',
        source: 'session-adapter:fake',
        content: { source: 'fake', threadId: 'a' },
        timestamp: Date.now(),
      });
    };
    const second = await send('c2');
    await f.settled();
    for (const d of domains) expect(session.sent[1]).toContain(interpretation('a', d));
    expect(second.delivery.committed).toEqual([]);
    await send('c3');
    for (const d of domains) expect(session.sent[2]).toContain(interpretation('a', d));
  } finally {
    await f.close();
  }
});

test('two layers sharing an id stay two standing parts with their own ledger records', () => {
  const parts = standingParts([
    { role: 'content', id: 'thread-state', text: 'A' },
    { role: 'content', id: 'instructions', text: 'B' },
    { role: 'layer', id: 'thread-state', text: 'prompt' },
    { role: 'content', id: 'thread-state', text: 'C' },
  ]);
  expect(parts.map((part) => [part.id, part.text])).toEqual([
    ['thread-state', 'A'],
    ['instructions', 'B'],
    ['thread-state#2', 'prompt\n\nC'],
  ]);
});

/** Sessions that resume the thread's native binding once it exists, and release when idle. */
class ResumingAdapter extends RecordingAdapter {
  binding: string | null = null;
  released: RecordingSession[] = [];
  override async createSession(opts: CreateSessionOpts): Promise<HarnessSession> {
    const session = (await super.createSession(opts)) as RecordingSession;
    session.externalSessionId = this.binding ?? undefined;
    this.binding ??= 'native-1';
    return session;
  }
  override async getExternalSessionId(): Promise<string | null> {
    return this.binding;
  }
  async releaseIdleSession(session: HarnessSession): Promise<'released'> {
    this.released.push(session as RecordingSession);
    session.kill();
    return 'released';
  }
}

/** The ledger a thread keeps from each turn's report (thread-runtime's commit, deduplicated). */
const nextLedger = (
  report: SessionDeliveryReport,
  previous: Record<string, string>,
): Record<string, string> => {
  const next = report.session === 'started' ? {} : { ...previous };
  for (const part of [...(report.session === 'started' ? report.base : []), ...report.sent])
    next[part.id] = part.hash;
  return next;
};
const conventions = (v: string) => standingPart('conventions', `CONV_${v}`);
const standingOf =
  (...parts: ReturnType<typeof standingPart>[]) =>
  (held: Record<string, string>) =>
    ({ standing: parts, turn: '', held }) satisfies SessionDelivery;

describe('one native session per thread', () => {
  test('a thread that moves to another cwd retires its session there; moving back starts afresh', async () => {
    const adapter = new ResumingAdapter();
    const provider = new SessionBackedProvider({ id: 'claude-code', adapter, defaultModel: 'm' });
    let ledger: Record<string, string> = {};
    const turn = async (cwd: string, version: string) => {
      const result = await provider.complete(user, {
        threadId: 'T',
        cwd,
        delivery: standingOf(instructionsPart, conventions(version))(ledger),
      });
      ledger = nextLedger(result.delivery!, ledger);
      return result;
    };
    await turn('/A', 'v1');
    await turn('/B', 'v2');
    // The session in /A was released before /B's started: never two processes on one conversation.
    expect(adapter.released).toEqual([adapter.sessions[0]]);
    const back = await turn('/A', 'v2');
    expect(adapter.sessions).toHaveLength(3);
    expect(adapter.released).toEqual([adapter.sessions[0], adapter.sessions[1]]);
    // The review's repro: the old /A session used to be reused, held, and never sent CONV_v2.
    expect(back.delivery!.session).toBe('started');
    expect(adapter.created[2].baseContext).toContain('CONV_v2');
    expect(adapter.sessions.filter((session) => session.alive)).toHaveLength(1);
  });

  test('a move while the old session still works is refused, and nothing is sent', async () => {
    const adapter = new ResumingAdapter();
    const provider = new SessionBackedProvider({ id: 'claude-code', adapter, defaultModel: 'm' });
    await provider.complete(user, { threadId: 'T', cwd: '/A', delivery: delivery() });
    let release!: () => void;
    adapter.sessions[0].during = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const working = provider.complete(user, { threadId: 'T', cwd: '/A', delivery: delivery() });
    await Bun.sleep(5);
    await expect(
      provider.complete(user, { threadId: 'T', cwd: '/B', delivery: delivery() }),
    ).rejects.toThrow('has unsettled work; nothing was sent');
    expect(adapter.sessions).toHaveLength(1);
    release();
    await working;
  });
});

describe('a relaunch in this process honors the ledger', () => {
  test('a host launch change re-sends only what changed, with a byte-identical system prompt', async () => {
    const adapter = new ResumingAdapter();
    let launch = { revision: 1 };
    const provider = new SessionBackedProvider({
      id: 'claude-code',
      adapter,
      defaultModel: 'm',
      launch: { get: () => launch } as never,
    });
    adapter.releaseIdleSession = async () => 'released';
    let ledger: Record<string, string> = {};
    const turn = async (...parts: ReturnType<typeof standingPart>[]) => {
      const result = await provider.complete(user, {
        threadId: 'T',
        cwd: '/A',
        delivery: standingOf(...parts)(ledger),
      });
      ledger = nextLedger(result.delivery!, ledger);
      return result;
    };
    await turn(instructionsPart, conventions('v1'));
    await turn(instructionsPart, conventions('v2'));
    launch = { revision: 2 };
    const relaunched = await turn(instructionsPart, conventions('v2'));
    expect(adapter.sessions).toHaveLength(2);
    // The ledger proves the conversation holds both parts at their current hashes: nothing is re-sent.
    expect(relaunched.delivery).toMatchObject({ session: 'started', sent: [] });
    expect(adapter.sessions[1].sent[0]).not.toContain('STANDING_INSTRUCTIONS');
    launch = { revision: 3 };
    const changed = await turn(instructionsPart, conventions('v3'));
    expect(changed.delivery!.sent.map((part) => part.id)).toEqual(['conventions']);
    // Unchanged standing context gives an unchanged system prompt, so the cached prefix survives.
    expect(adapter.created[1].baseContext).toBe(
      baseContextOf(standingOf(instructionsPart, conventions('v2'))({})),
    );
  });

  test('a resume from another process still re-sends every part once', async () => {
    const adapter = new ResumingAdapter();
    adapter.binding = 'native-from-yesterday';
    const provider = new SessionBackedProvider({ id: 'claude-code', adapter, defaultModel: 'm' });
    const held = Object.fromEntries(base.map((part) => [part.id, part.hash]));
    const result = await provider.complete(user, {
      threadId: 'T',
      delivery: delivery(learningV1, held),
    });
    expect(ids(result.delivery!.sent)).toEqual(['instructions', 'learning', 'agent:worker']);
  });
});

test('a thread keeps its thread state out of the system prompt and commits each part once', async () => {
  const adapter = new RecordingAdapter();
  const f = await m0Scenario({
    session: () => adapter,
    review: (call) => learned(call.thread, call.domain!),
  });
  try {
    const turn = await f.send('a', 's1');
    if (turn.status !== 200) throw Error(JSON.stringify(turn.body).slice(0, 2000));
    const meta = (turn.body as Body).meta;
    const created = adapter.created.find((c) => !c.threadId.includes(':aux:'))!;
    expect(created.baseContext).not.toContain('## Context: thread-state');
    expect(meta.delivery.session!.base.map((part) => part.id)).not.toContain('thread-state');
    // Each part is recorded once, never twice for a started session.
    expect(new Set(meta.delivery.committed).size).toBe(meta.delivery.committed.length);
    const session = adapter.sessions.find((s) => s.sent.length > 0)!;
    expect(session.sent[0]).toContain('"messageCount"');
    expect(session.sent[0]).not.toContain('injectedLayers');
  } finally {
    await f.close();
  }
});

test('a Codex relaunch in this process keeps its ledger, so nothing it held is sent again', async () => {
  const adapter = new ResumingAdapter('first-turn');
  let launch = { revision: 1 };
  const provider = new SessionBackedProvider({
    id: 'codex',
    adapter,
    defaultModel: 'm',
    launch: { get: () => launch } as never,
  });
  adapter.releaseIdleSession = async () => 'released';
  const first = await provider.complete(user, { threadId: 'T', delivery: delivery() });
  // Codex has no system prompt: the first turn carries every part, and the ledger records them.
  expect(ids(first.delivery!.sent)).toEqual(['instructions', 'learning', 'agent:worker']);
  const held = Object.fromEntries(first.delivery!.sent.map((part) => [part.id, part.hash]));
  launch = { revision: 2 };
  const relaunched = await provider.complete(user, {
    threadId: 'T',
    delivery: delivery(learningV1, held),
  });
  expect(relaunched.delivery).toMatchObject({
    session: 'started',
    base: [],
    sent: [],
    ledgerKept: true,
  });
});

test('a thread whose old session already died moves cwd without being wedged', async () => {
  const adapter = new ResumingAdapter();
  const provider = new SessionBackedProvider({ id: 'claude-code', adapter, defaultModel: 'm' });
  adapter.releaseIdleSession = async () => 'unknown' as never;
  await provider.complete(user, { threadId: 'T', cwd: '/A', delivery: delivery() });
  adapter.sessions[0].kill();
  const moved = await provider.complete(user, { threadId: 'T', cwd: '/B', delivery: delivery() });
  expect(moved.delivery!.session).toBe('started');
  expect(adapter.sessions).toHaveLength(2);
});
