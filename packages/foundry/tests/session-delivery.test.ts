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
  standingPart,
} from '@inixiative/foundry-core';
import type { CreateSessionOpts, SessionAdapter } from '../src/providers/session-adapter';
import { DECISION_CONTEXT, SessionBackedProvider } from '../src/providers/session-backed';
import { sessionTurn } from '../src/providers/session-delivery';
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
  externalSessionId: string | undefined = 'native-1';
  events: readonly SessionEvent[] = [];
  turns = 0;
  totalTokens = { input: 0, output: 0 };
  sent: string[] = [];
  fail = false;
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
  test('a started session holds its base context: the turn carries only the per-turn text', () => {
    const turn = sessionTurn(delivery(learningV1, { learning: 'stale-from-old-session' }), user, {
      base,
      started: true,
      placement: 'first-turn',
    });
    expect(turn.report).toEqual({ session: 'started', base, sent: [] });
    expect(turn.messages).toEqual([
      { role: 'system', content: 'ROUTING_AND_ADVICE' },
      { role: 'user', content: 'USER_MESSAGE' },
    ]);
  });

  test('a held session receives only the parts whose hash the ledger does not hold', () => {
    const held = Object.fromEntries(base.map((part) => [part.id, part.hash]));
    const turn = sessionTurn(delivery(learningV2, held), user, {
      base,
      started: false,
      placement: 'system-prompt',
    });
    expect(ids(turn.report.sent)).toEqual(['learning']);
    expect(turn.messages[0].content).toContain('## Context: learning');
    expect(turn.messages[0].content).toContain('LEARNING_V2');
    expect(turn.messages[0].content).not.toContain('STANDING_INSTRUCTIONS');
    expect(turn.messages[0].content).toEndWith('ROUTING_AND_ADVICE');
  });

  test('after compaction a system prompt still holds the base; a first-turn base does not', () => {
    const kept = sessionTurn(delivery(learningV2, {}), user, {
      base,
      started: false,
      placement: 'system-prompt',
    });
    expect(ids(kept.report.sent)).toEqual(['learning']);
    const lost = sessionTurn(delivery(learningV2, {}), user, {
      base,
      started: false,
      placement: 'first-turn',
    });
    expect(ids(lost.report.sent)).toEqual(['instructions', 'learning', 'agent:worker']);
  });

  test('the ledger wins over the base: a part that changed back to its base version is sent again', () => {
    const turn = sessionTurn(delivery(learningV1, { learning: learningV2.hash }), user, {
      base,
      started: false,
      placement: 'system-prompt',
    });
    expect(ids(turn.report.sent)).toEqual(['learning']);
  });

  test('a part that is neither in the base nor the ledger is sent; no per-turn text sends no empty block', () => {
    const extra = standingPart('docs', 'DOCS');
    const turn = sessionTurn({ standing: [instructionsPart, extra], turn: '', held: {} }, user, {
      base: [base[0]],
      started: false,
      placement: 'system-prompt',
    });
    expect(ids(turn.report.sent)).toEqual(['docs']);
    const quiet = sessionTurn({ standing: [instructionsPart], turn: '', held: {} }, user, {
      base: [base[0]],
      started: false,
      placement: 'system-prompt',
    });
    expect(quiet.messages).toEqual(user);
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
    expect(adapter.created[0].baseContext).toBe(
      'STANDING_INSTRUCTIONS\n\nLEARNING_V1\n\nAGENT_PROMPT',
    );
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

  test('a session whose first turn failed is still treated as started on the next turn', async () => {
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
    const retry = await provider.complete(user, {
      threadId: 't',
      delivery: delivery(learningV1, { instructions: 'from-an-earlier-session' }),
    });
    expect(retry.delivery).toEqual({ session: 'started', base, sent: [] });
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
