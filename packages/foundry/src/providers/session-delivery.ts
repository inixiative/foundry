import type {
  DeliveredPart,
  LLMMessage,
  SessionDelivery,
  SessionDeliveryReport,
  StandingPart,
} from '@inixiative/foundry-core';

/**
 * Warm-cache delivery for a native session (docs/FLOW.md, "Delivery"). A Claude session starts with
 * every standing part in its system prompt; each later turn carries only the standing parts whose
 * hash the session does not hold, plus the per-turn text. What the session holds is the thread's
 * delivery ledger, and where the ledger has no record (after compaction), the system prompt.
 * A runtime without a system prompt (Codex) gets every part in its first turn's message instead.
 */
export type BaseContextPlacement = 'system-prompt' | 'first-turn';

export interface SessionTurn {
  /** The messages for this turn, with the system message replaced by the delta and per-turn text. */
  readonly messages: LLMMessage[];
  readonly report: SessionDeliveryReport;
}

const block = (part: StandingPart, replaces: boolean) =>
  `## Context: ${part.id}${replaces ? `\nThis is the current version of ${part.id}; it replaces any earlier version in this session.` : ''}\n\n${part.text}`;

/** The system prompt a session starts with: every standing part, labelled, in order. */
export function baseContextOf(delivery: SessionDelivery): string {
  return delivery.standing.map((part) => block(part, false)).join('\n\n');
}

export function sessionTurn(
  delivery: SessionDelivery,
  messages: readonly LLMMessage[],
  session: {
    /** The parts the session's system prompt carries; empty without one. */
    readonly base: readonly DeliveredPart[];
    /** True until the session completes a delivered turn: the ledger belongs to an earlier session. */
    readonly started: boolean;
    /**
     * The session resumed a native conversation, which may carry older versions of these parts as
     * messages; the first turn re-sends every part so the conversation's latest version is current.
     */
    readonly resumed: boolean;
    /**
     * The resumed conversation is the one the thread's ledger describes (a relaunch in this
     * process): the ledger is honored, so only parts whose latest delivered version is not current
     * are sent. Unknown (a resume from another process): every part is sent.
     */
    readonly ledgerHeld?: boolean;
  },
): SessionTurn {
  const base = new Map(session.base.map((part) => [part.id, part.hash]));
  const ledger = session.started && !session.ledgerHeld ? {} : delivery.held;
  const unknownHistory = session.started && session.resumed && !session.ledgerHeld;
  const holds = (part: StandingPart) =>
    Object.hasOwn(ledger, part.id)
      ? ledger[part.id] === part.hash
      : !unknownHistory && base.get(part.id) === part.hash;
  const sent = delivery.standing.filter((part) => !holds(part));
  const system = [
    ...sent.map((part) => block(part, true)),
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
      ...(session.started && session.ledgerHeld ? { ledgerKept: true as const } : {}),
    },
  };
}
