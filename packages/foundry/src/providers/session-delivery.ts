import type {
  DeliveredPart,
  LLMMessage,
  SessionDelivery,
  SessionDeliveryReport,
  StandingPart,
} from '@inixiative/foundry-core';

/**
 * Warm-cache delivery for a native session (docs/FLOW.md, "Delivery"). A session starts with every
 * standing part in its base context; each later turn carries only the standing parts whose hash the
 * session does not hold, plus the per-turn text. What the session holds is the thread's delivery
 * ledger, and where the ledger has no record (after compaction), the base context, but only when
 * the base context is a system prompt that compaction keeps.
 */
export type BaseContextPlacement = 'system-prompt' | 'first-turn';

export interface SessionTurn {
  /** The messages for this turn, with the system message replaced by the delta and per-turn text. */
  readonly messages: LLMMessage[];
  readonly report: SessionDeliveryReport;
}

/** The base context a session starts with: every standing part, in order. */
export function baseContextOf(delivery: SessionDelivery): string {
  return delivery.standing.map((part) => part.text).join('\n\n');
}

export function sessionTurn(
  delivery: SessionDelivery,
  messages: readonly LLMMessage[],
  session: {
    /** The parts the session's base context carries. */
    readonly base: readonly DeliveredPart[];
    /** True on the session's first delivered turn: the ledger belongs to an earlier session. */
    readonly started: boolean;
    readonly placement: BaseContextPlacement;
  },
): SessionTurn {
  const base = new Map(session.base.map((part) => [part.id, part.hash]));
  const ledger = session.started ? {} : delivery.held;
  const holds = (part: StandingPart) =>
    Object.hasOwn(ledger, part.id)
      ? ledger[part.id] === part.hash
      : (session.started || session.placement === 'system-prompt') &&
        base.get(part.id) === part.hash;
  const sent = delivery.standing.filter((part) => !holds(part));
  const system = [
    ...sent.map(
      (part) =>
        `## Context: ${part.id}\nThis is the current version; it replaces any earlier version of ${part.id} in this session.\n\n${part.text}`,
    ),
    ...(delivery.turn.trim() ? [delivery.turn] : []),
  ].join('\n\n');
  return {
    messages: [
      ...(system ? [{ role: 'system' as const, content: system }] : []),
      ...messages.filter((message) => message.role !== 'system'),
    ],
    report: {
      session: session.started ? 'started' : 'held',
      base: session.base.map(({ id, hash }) => ({ id, hash })),
      sent: sent.map(({ id, hash }) => ({ id, hash })),
    },
  };
}
