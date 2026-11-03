/**
 * @atlas
 * @kind service
 * @partOf feature:evals, feature:feedback
 */
// One user message through a live thread's chorus, headless: what Foundry would deliver to a fresh
// Claude Code session for that message. The thread is built the way the daemon builds one (the
// factory, the per-thread runtime with its Cartographer, region Wardens and FlowOrchestrator, the
// harness), so the advice plan, its deadline and budget and the decoration are the live ones. Only
// the central agent's model call is replaced: it captures what the executor would send and answers
// nothing. Oracle's `chorus` replay arm reads the result (scripts/evals/chorus-advise.ts).

import {
  Harness,
  type InjectionArtifact,
  type LLMMessage,
  type LLMProvider,
  type MessageDecoration,
  newId,
  type SessionDelivery,
  type StandingPart,
  withAfterMessageNotes,
} from '@inixiative/foundry-core';
import { CHORUS_RECEPTION_LAYER } from '../agents/chorus-reception';
import { withChorusThread } from '../agents/chorus-thread';
import { threadKnowledgeLayerId } from '../agents/domain-librarian';
import type { DomainContribution, InjectionPlan } from '../agents/flow-orchestrator';
import { configureHarness, type SourceResolver } from '../agents/thread-factory';
import type { PhaseRecordInput, ThreadRuntimeDeps } from '../agents/thread-runtime';
import { formatMessagesForNativeSession } from '../providers/session-backed';
import { baseContextOf, sessionTurn } from '../providers/session-delivery';
import type { FoundryConfig } from '../viewer/config';

export interface ChorusAdviseOptions {
  /** The effective configuration a live thread composes under (subscription-resolved, overrides applied). */
  readonly config: FoundryConfig;
  readonly projectId: string;
  /** Where the thread works: the instruction ladder composes from here. */
  readonly cwd: string;
  /** The user's message, as typed. */
  readonly message: string;
  /** The decision provider the Cartographer and every Warden run on (the daemon's decision host). */
  readonly decisions: LLMProvider;
  /** A classify stage's own host (`ThreadRuntimeDeps.stageHost`). */
  readonly stageHost?: ThreadRuntimeDeps['stageHost'];
  readonly resolveSource: SourceResolver;
  readonly atlasRoot?: string;
  /** Every phase record (route, advice) the runtime journals, as the daemon's journal receives it. */
  readonly journal?: (record: PhaseRecordInput) => void;
  /** The thread's id; its Wardens' primed sessions are keyed by it (`<thread>:aux:domain:<d>`). */
  readonly threadId?: string;
  /**
   * Warm every Warden before the message: its caches, then one decision on PRIME_MESSAGE on its own
   * session keys, so the message is advised on primed keys as a later live turn is (a first live
   * turn primes as it decides, and may time out doing so). Nothing of it reaches the thread.
   */
  readonly prime?: boolean;
  /**
   * Called once priming is done, before the message is sent (a caller attributing usage by phase,
   * or waiting for a project host to hold its spares again).
   */
  readonly onPrimed?: () => void | Promise<void>;
  readonly log?: (line: string) => void;
  readonly warn?: (line: string) => void;
}

/** One Warden's decision on the message, as the sealed plan recorded it. */
export interface ChorusWardenDecision {
  readonly domain: string;
  readonly decision: DomainContribution['decision'];
  readonly reason?: string;
  readonly snippets: readonly string[];
  readonly pointer?: DomainContribution['pointer'];
  readonly elapsedMs?: number;
  readonly classified?: DomainContribution['classified'];
  /** The model that answered, when the provider reported it. */
  readonly served?: unknown;
  /** The exact input it was given (`not-sent` with the reason when no call was made). */
  readonly request: DomainContribution['request'];
  /** The exact input of every stage past the first. */
  readonly stageRequests?: DomainContribution['stageRequests'];
}

/** One Warden's priming decision (`prime`): what it answered and how long it took. */
export interface ChorusPrime {
  readonly domain: string;
  readonly outcome: 'answered' | 'skipped' | 'error';
  readonly reason?: string;
  readonly elapsedMs: number;
}

/** The priming message: a moment that touches no region, so every Warden is expected to answer NO_COMMENT. */
export const PRIME_MESSAGE =
  'Priming only: no task yet. Answer NO_COMMENT; nothing you could say applies to this message.';

export interface ChorusAdvice {
  /**
   * The standing context the chorus adds to a fresh session's system prompt, framed as live frames
   * it (`## Context: <id>`): the reception charter, and any thread knowledge a Warden holds (none on
   * a first turn). Foundry's other standing parts (instruction layers, the agent's own prompt) are
   * left out: they are Foundry, not the chorus.
   */
  readonly systemAppend: string;
  /** Every standing part a fresh live session would start with, and whether it is the chorus's. */
  readonly standing: ReadonlyArray<{ id: string; hash: string; chorus: boolean }>;
  /** The per-turn context text (routing line, per-turn layers): the session's `# System Context`. */
  readonly turnText: string;
  /** The message as typed. */
  readonly payload: string;
  /** Each Warden's note appended to the message, in order. */
  readonly notes: readonly string[];
  /** The message the executor sends: `payload`, then the notes below a rule. */
  readonly message: string;
  /**
   * The exact first prompt a fresh live Claude Code session receives: the per-turn context (the
   * routing block) as `# System Context`, then `# User Message` and `message`. The turn's text rides
   * the user prompt, never the system prompt.
   */
  readonly nativePrompt: string;
  /** The exact system prompt that session starts with (every standing part, Foundry's included). */
  readonly liveSystemPrompt: string;
  readonly decisions: readonly ChorusWardenDecision[];
  readonly omissions: InjectionPlan['omissions'];
  readonly routing: Pick<InjectionPlan['routing'], 'status' | 'domains' | 'confidence' | 'reason'>;
  readonly elapsedMs: number;
  readonly decoration: MessageDecoration;
  /** The regions the thread composed as Wardens, in configured order. */
  readonly composed: readonly string[];
  /** The orchestrator's deadlines and budget, as this thread ran them (`contributionBudget` null: unlimited). */
  readonly timing: {
    readonly maxAdviseParallel: number | null;
    readonly adviseTimeoutMs: number;
    readonly routingTimeoutMs: number;
    readonly planTimeoutMs: number | null;
    readonly contributionBudget: number | null;
  };
  /** `prime`: each Warden's priming decision; absent when not primed. */
  readonly primed?: readonly ChorusPrime[];
}

/** Whether a standing part is the chorus's: the reception charter, or a Warden's thread knowledge. */
export const chorusPart = (id: string, domains: Iterable<string>): boolean =>
  id === CHORUS_RECEPTION_LAYER || [...domains].some((d) => id === threadKnowledgeLayerId(d));

/** The message a turn sends for a decoration: its after-message notes appended (the executor's join). */
export function chorusMessage(
  payload: string,
  decoration: MessageDecoration | undefined,
): { notes: string[]; message: string } {
  const blocks = (decoration?.blocks ?? []).filter((b) => b.placement === 'after-message');
  return { notes: blocks.map((b) => b.text), message: withAfterMessageNotes(payload, blocks) };
}

/** A fresh session's view of a turn: its system prompt and its first prompt, as live builds them. */
export function freshSessionTurn(
  delivery: SessionDelivery,
  messages: readonly LLMMessage[],
): { systemPrompt: string; prompt: string } {
  const base = delivery.standing.map(({ id, hash }) => ({ id, hash }));
  const turn = sessionTurn(delivery, messages, { base, started: true, resumed: false });
  return {
    systemPrompt: baseContextOf(delivery),
    prompt: formatMessagesForNativeSession(turn.messages),
  };
}

/**
 * Sends one message through a thread of the project, built as the daemon builds it, and returns what
 * a fresh live Claude Code session would receive. The thread is disposed before it returns.
 */
export async function adviseOnce(opts: ChorusAdviseOptions): Promise<ChorusAdvice> {
  const { config } = opts;
  const threadId = opts.threadId ?? newId('chorus-advise');
  let captured: { messages: LLMMessage[]; delivery?: SessionDelivery } | undefined;
  // The central agent's provider: captures what the executor sends and answers nothing.
  const capture = (id: string): LLMProvider => ({
    id,
    async complete(messages, callOpts) {
      if (callOpts?.threadId !== threadId)
        throw Error(`chorus-advise runs no agent call but the central one (${callOpts?.threadId})`);
      if (captured) throw Error('chorus-advise captures one turn');
      captured = {
        messages: structuredClone(messages),
        ...(callOpts.delivery ? { delivery: structuredClone(callOpts.delivery) } : {}),
      };
      return { model: 'chorus-advise-capture', content: '' };
    },
  });
  return withChorusThread(
    {
      config,
      projectId: opts.projectId,
      cwd: opts.cwd,
      decisions: opts.decisions,
      agentProvider: capture,
      ...(opts.stageHost ? { stageHost: opts.stageHost } : {}),
      resolveSource: opts.resolveSource,
      ...(opts.atlasRoot ? { atlasRoot: opts.atlasRoot } : {}),
      ...(opts.journal ? { journal: opts.journal } : {}),
      threadId,
      ...(opts.log ? { log: opts.log } : {}),
      ...(opts.warn ? { warn: opts.warn } : {}),
    },
    async ({ thread, live }) => {
      const primed = opts.prime
        ? await Promise.all(
            [...live.domainLibrarians.values()].map(async (lib): Promise<ChorusPrime> => {
              const started = Date.now();
              try {
                await lib.warm();
                lib.prestart();
                const result = await lib.advise(PRIME_MESSAGE, live.librarian.layer.content, {
                  cache: lib.cache.content,
                  cacheComposition: lib.cacheComposition(),
                  threadKnowledge: lib.threadKnowledge.content,
                  trigger: 'user-message',
                });
                const failed = result.error ?? result.skipped ?? result.notStarted;
                return {
                  domain: lib.domain,
                  outcome: result.error ? 'error' : failed ? 'skipped' : 'answered',
                  ...(failed ? { reason: failed } : {}),
                  elapsedMs: Date.now() - started,
                };
              } catch (error) {
                return {
                  domain: lib.domain,
                  outcome: 'error',
                  reason: (error as Error).message,
                  elapsedMs: Date.now() - started,
                };
              }
            }),
          )
        : undefined;
      await opts.onPrimed?.();
      const harness = new Harness(thread);
      configureHarness(harness, config);
      const started = Date.now();
      const sent = await harness.send({ id: newId('msg'), payload: opts.message });
      const elapsedMs = Date.now() - started;
      const artifact = sent.result.meta?.injection as InjectionArtifact | undefined;
      const plan = artifact?.plan as InjectionPlan | undefined;
      const decoration = artifact?.decoration;
      if (!captured || !artifact || !plan || !decoration)
        throw Error('the turn reached no executor with a sealed plan: nothing was decorated');
      const user = captured.messages.filter((m) => m.role === 'user').at(-1);
      const executorMessage = typeof user?.content === 'string' ? user.content : undefined;
      const { notes, message } = chorusMessage(opts.message, decoration);
      if (executorMessage !== message)
        throw Error('the executor sent another message than the decoration composes');
      const delivery = captured.delivery;
      if (!delivery) throw Error('the executor gave no session delivery');
      const domains = [...live.domainLibrarians.keys()];
      const standing: StandingPart[] = [...delivery.standing];
      const fresh = freshSessionTurn(delivery, captured.messages);
      return {
        systemAppend: baseContextOf({
          standing: standing.filter((part) => chorusPart(part.id, domains)),
          turn: '',
          held: {},
        }),
        standing: standing.map(({ id, hash }) => ({ id, hash, chorus: chorusPart(id, domains) })),
        turnText: delivery.turn,
        payload: opts.message,
        notes,
        message,
        nativePrompt: fresh.prompt,
        liveSystemPrompt: fresh.systemPrompt,
        decisions: plan.contributions.map((c) => ({
          domain: c.domain,
          decision: c.decision,
          ...(c.reason ? { reason: c.reason } : {}),
          snippets: [...c.snippets],
          ...(c.pointer ? { pointer: c.pointer } : {}),
          ...(c.provenance.elapsedMs !== undefined ? { elapsedMs: c.provenance.elapsedMs } : {}),
          ...(c.classified ? { classified: c.classified } : {}),
          ...(c.request.status === 'supplied' && c.request.served
            ? { served: c.request.served }
            : {}),
          request: c.request,
          ...(c.stageRequests ? { stageRequests: c.stageRequests } : {}),
        })),
        omissions: plan.omissions,
        routing: {
          status: plan.routing.status,
          domains: plan.routing.domains,
          confidence: plan.routing.confidence,
          ...(plan.routing.reason ? { reason: plan.routing.reason } : {}),
        },
        elapsedMs,
        decoration,
        composed: domains,
        timing: (({ maxAdviseParallel, contributionBudget, planTimeoutMs, ...deadlines }) => ({
          ...deadlines,
          // Unbounded values (every Warden at once, no budget, no plan deadline) are null in JSON.
          maxAdviseParallel:
            Number.isSafeInteger(maxAdviseParallel) && maxAdviseParallel < Number.MAX_SAFE_INTEGER
              ? maxAdviseParallel
              : null,
          contributionBudget: Number.isFinite(contributionBudget) ? contributionBudget : null,
          planTimeoutMs: planTimeoutMs ?? null,
        }))(live.flowOrchestrator.timing),
        ...(primed ? { primed } : {}),
      };
    },
  );
}
