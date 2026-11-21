/**
 * @atlas
 * @kind provider
 * @partOf primitive:decisions
 */
import type {
  ClaudeInSessionDecisions,
  PipedSubprocess,
  PrimeSpec,
} from '@inixiative/agent-session';
import { type CompletionOpts, type LLMMessage, sha256Hex } from '@inixiative/foundry-core';
import type { ProjectWardenHosts } from './project-warden-hosts';
import { formatMessagesForNativeSession } from './session-backed';

/** A decision host's child process: a project host's Claude Code launch. */
export type DecisionProcess = PipedSubprocess;

const hash = sha256Hex;

/**
 * Prime key, instructions, stable context and per-cycle input for one Warden decision on its
 * project host. The key is the logical session (Foundry's auxiliary session id) plus the role
 * instructions, so advice and guard on one domain are held as separate members.
 */
export function primedRequest(
  messages: LLMMessage[],
  opts: CompletionOpts,
  sessionKey: string,
): { spec: PrimeSpec; input: string } {
  const instructions = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content.trim())
    .filter(Boolean)
    .join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system');
  if (!turns.length || turns.at(-1)!.role !== 'user')
    throw Error('A decision needs a final user message');
  const first = turns[0]!;
  const prefix = opts.stablePrefix;
  const primed =
    !!prefix &&
    first.role === 'user' &&
    first.content.startsWith(prefix) &&
    first.content.length > prefix.length;
  const rest = primed
    ? [{ ...first, content: first.content.slice(prefix!.length) }, ...turns.slice(1)]
    : turns;
  const input = rest.length === 1 ? rest[0]!.content : formatMessagesForNativeSession(rest);
  const context = primed ? prefix! : '';
  return {
    spec: {
      key: `${sessionKey}#${hash(instructions).slice(0, 16)}`,
      instructions,
      context,
      hash: hash(`${instructions}\0${context}`),
    },
    input,
  };
}

/** Auxiliary session ids are `<thread>:aux:<role>` (agents/thread-runtime auxiliarySessionId). */
const AUXILIARY = ':aux:';
/** The Foundry thread an auxiliary session belongs to; undefined for a call outside any thread. */
export function decisionThread(sessionKey: string): string | undefined {
  const at = sessionKey.indexOf(AUXILIARY);
  return at > 0 ? sessionKey.slice(0, at) : undefined;
}
/** A Warden phase: advice and guard (`domain:<d>`) or post-work review (`review:<generation>:domain:<d>`). */
export function isWardenSession(sessionKey: string): boolean {
  const at = sessionKey.indexOf(AUXILIARY);
  if (at <= 0) return false;
  const role = sessionKey.slice(at + AUXILIARY.length);
  return role.startsWith('domain:') || /^review:[^:]+:domain:/.test(role);
}

/** The Warden a decision key belongs to (`<thread>:aux:domain:<d>#<hash>`): `<d>`; undefined for any other key. */
export function wardenOfDecisionKey(key: string): string | undefined {
  return /:aux:domain:(.+?)(?::stage:\d+)?(?:#[^#]*)?$/.exec(key)?.[1];
}

/** A later classify stage of a Warden (`domain:<d>:stage:<n>`). */
export function isStageSession(sessionKey: string): boolean {
  const at = sessionKey.indexOf(AUXILIARY);
  return at > 0 && /^domain:.+:stage:\d+$/.test(sessionKey.slice(at + AUXILIARY.length));
}

/**
 * Where a Warden's call (advice, guard, review or a later classify stage) goes while project hosts
 * run: its project's host (a later stage: its lane) while that host serves. Otherwise it is
 * `not-serving`: refused unsent (`not-held`) (Aron, 2026-11-18: "it should not
 * be handling warden calls at all"; "when the layers are down, they just skip"). A user message's
 * advice then catches up on the thread's next message (`agents/warden-catch-up.ts`); any other
 * trigger skips it; a later stage skipped leaves the Warden silent for the moment (classify
 * `runStages`), never with an earlier stage's unconfirmed answer. Undefined: not a Warden's call, or
 * no project hosts (API-token decisions). Advice and guard compose one system, so a guard is served by the same held
 * spares; a review carries no spare and runs as a cold member of the host, no process of its own.
 */
export function projectHostTarget(
  projectHosts: ProjectWardenHosts | undefined,
  sessionKey: string | undefined,
): ClaudeInSessionDecisions | 'not-serving' | undefined {
  if (!projectHosts || !sessionKey || !isWardenSession(sessionKey)) return undefined;
  const thread = decisionThread(sessionKey);
  const serving = thread ? projectHosts.serving(thread) : undefined;
  return serving && serving !== 'starting' ? serving : 'not-serving';
}

/** Whether a call is held-only: user-message advice at a Warden's first stage, never a later one. */
export function heldOnlyFor(sessionKey: string, opts: Pick<CompletionOpts, 'heldOnly'>): boolean {
  return !!opts.heldOnly && !isStageSession(sessionKey);
}
