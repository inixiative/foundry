/**
 * @atlas
 * @kind transformer
 * @partOf feature:wardens
 */
import type {
  AdviceOutcome,
  CallFailedCause,
  ClassifyStageTrace,
  ParticipantRequest,
} from '@inixiative/foundry-core';
import {
  type ChorusAdviceResult,
  type ChorusReviewResult,
  type ChorusStageTrace,
  type ChorusToolObservation,
  type ChorusWardenAdvice,
  chorusContextLimit,
  chorusDomainIdSchema,
  chorusEarlierMessagesSchema,
  chorusKnowledgeLimit,
  chorusMaxDeadlineMs,
  chorusMomentLimit,
  type RelayedOperationInput,
} from '@inixiative/signet';
import { type ClassifiedSummary, parseWardenPointer, type WardenPointer } from '../classify';
import type { ChorusCallOutcome } from '../providers/chorus-client';
import type {
  EarlierMessages,
  GuardFinding,
  GuardResult,
  PhaseRequestEvidence,
  ReviewInput,
  ReviewResult,
  ToolObservation,
} from './warden';
import type { AdviceTrigger } from './warden-triggers';

/** The provider a remote Chorus call is journalled under. */
const PROVIDER_ID = 'chorus-remote';

type AdviceOperation =
  | 'chorus.advise'
  | 'chorus.brief'
  | 'chorus.consumed'
  | 'chorus.milestone'
  | 'chorus.handBack';

/** One Chorus operation per trigger point, so each is its own grant and meter (R-2026-11-18-20). */
const ADVICE_OPERATION: Record<AdviceTrigger, AdviceOperation> = {
  'user-message': 'chorus.advise',
  'subagent-spawn': 'chorus.brief',
  consumed: 'chorus.consumed',
  milestone: 'chorus.milestone',
  'hand-back': 'chorus.handBack',
};

/** The Chorus earlier-messages cap: at most this many, each within the moment limit. */
const EARLIER_MAX = 50;
/** Tool observations: Chorus's limits on each field. */
const OBSERVATION_LIMIT = { count: 200, tool: 120, filePath: 1024, summary: 4_000, detail: 16_000 };

const clip = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max));
const moment = (text: string) => clip(text.trim() ? text : '(no text)', chorusMomentLimit);
const deadline = (ms: number) =>
  Math.min(
    chorusMaxDeadlineMs,
    Math.max(1_000, Math.round(Number.isFinite(ms) ? ms : chorusMaxDeadlineMs)),
  );
const isDomainId = (domain: string) => chorusDomainIdSchema.safeParse(domain).success;

/** One asked Warden: its domain and its own thread knowledge, frozen by the caller. */
export interface RemoteAsked {
  readonly domain: string;
  readonly threadKnowledge: string;
}

/** What one Warden's remote advice ended with, before the orchestrator adds segments and provenance. */
export interface RemoteAdvice {
  readonly outcome: AdviceOutcome;
  readonly reason?: string;
  readonly layers: string[];
  readonly snippets: string[];
  readonly confidence: number;
  readonly pointer?: WardenPointer;
  readonly classified?: ClassifiedSummary;
  readonly catchesUp?: true;
  readonly request: ParticipantRequest;
}

/** A remote guard's result for one domain; the orchestrator adds the thread-knowledge revision. */
export type RemoteGuard = Omit<
  GuardResult,
  'threadKnowledgeRevision' | 'classified' | 'stageRequests' | 'askDebugReason'
>;

/** The call's input, the per-domain request evidence, and the domains it could not ask. */
interface Prepared<O extends 'chorus.advise' | 'chorus.guard' | AdviceOperation> {
  readonly operation: O;
  readonly input: RelayedOperationInput<O>;
  /** Per asked domain, the slice of the input that was its own, as journal evidence. */
  readonly evidence: ReadonlyMap<string, PhaseRequestEvidence>;
  /** Asked domains whose id Chorus cannot carry: never sent, failed with this reason. */
  readonly unaskable: ReadonlyMap<string, string>;
}

const evidenceOf = (
  phase: PhaseRequestEvidence['phase'],
  operation: string,
  slice: Record<string, unknown>,
  capturedAt: number,
): PhaseRequestEvidence =>
  Object.freeze({
    phase,
    providerId: PROVIDER_ID,
    capturedAt,
    messages: Object.freeze([
      Object.freeze({
        role: 'user' as const,
        content: JSON.stringify({ operation, input: slice }),
      }),
    ]),
  });

const supplied = (e: PhaseRequestEvidence): ParticipantRequest => ({
  status: 'supplied',
  phase: e.phase,
  providerId: e.providerId,
  messages: e.messages,
  capturedAt: e.capturedAt,
});

/** The earlier messages as Chorus takes them: each within the moment limit, the newest fifty, the rest counted. */
function earlierInput(earlier: EarlierMessages | undefined) {
  if (!earlier || (!earlier.messages.length && !earlier.dropped)) return undefined;
  const kept = earlier.messages.filter((m) => m.trim()).map((m) => clip(m, chorusMomentLimit));
  const shown = kept.slice(-EARLIER_MAX);
  const value = {
    messages: shown,
    dropped: earlier.dropped + (earlier.messages.length - shown.length),
  };
  return chorusEarlierMessagesSchema.parse(value);
}

function knowledgeOf(asked: readonly RemoteAsked[]): Record<string, string> | undefined {
  const entries = asked
    .filter((a) => a.threadKnowledge)
    .map((a) => [a.domain, clip(a.threadKnowledge, chorusKnowledgeLimit)] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Splits the asked domains into those Chorus can carry and those it cannot. */
function splitAsked(asked: readonly RemoteAsked[]) {
  const sendable = asked.filter((a) => isDomainId(a.domain));
  const unaskable = new Map(
    asked
      .filter((a) => !isDomainId(a.domain))
      .map((a) => [a.domain, `"${a.domain}" is not a domain id Chorus accepts`] as const),
  );
  return { sendable, unaskable };
}

/** An advice-protocol call (`chorus.advise` and the between-turn operations) for these Wardens. */
function adviceCall(options: {
  readonly trigger: AdviceTrigger;
  readonly moment: string;
  readonly threadState: string;
  readonly asked: readonly RemoteAsked[];
  readonly deadlineMs: number;
  readonly earlier?: EarlierMessages;
  readonly capturedAt: number;
}): Prepared<AdviceOperation> {
  const operation = ADVICE_OPERATION[options.trigger];
  const { sendable, unaskable } = splitAsked(options.asked);
  const earlier = options.trigger === 'user-message' ? earlierInput(options.earlier) : undefined;
  const shared = {
    moment: moment(options.moment),
    ...(options.threadState ? { threadState: clip(options.threadState, chorusContextLimit) } : {}),
    deadlineMs: deadline(options.deadlineMs),
    ...(earlier ? { earlier } : {}),
  };
  const knowledge = knowledgeOf(sendable);
  const input = {
    ...shared,
    ...(knowledge ? { threadKnowledge: knowledge } : {}),
    ...(sendable.length ? { domains: sendable.map((a) => a.domain) } : {}),
  } as RelayedOperationInput<AdviceOperation>;
  const evidence = new Map(
    sendable.map((a) => {
      const own = knowledge?.[a.domain];
      const slice = { ...shared, ...(own ? { threadKnowledge: { [a.domain]: own } } : {}) };
      return [a.domain, evidenceOf('advice', operation, slice, options.capturedAt)] as const;
    }),
  );
  return { operation, input, evidence, unaskable };
}

const TIMED_OUT = /time(d)? ?out|deadline/i;

const stageTrace = (s: ChorusStageTrace, index: number): ClassifyStageTrace => ({
  stage: index,
  task: s.stage === 'recognise' ? 'recognise' : 'point',
  doc: s.stage,
  ...(s.model ? { model: s.model } : {}),
  ...(s.elapsedMs !== undefined ? { elapsedMs: s.elapsedMs } : {}),
  ...(s.outcome === 'yes' || s.outcome === 'no' || s.outcome === 'unsure'
    ? { outcome: s.outcome }
    : {}),
  ...(s.outcome === 'timeout' ? { timedOut: true as const } : {}),
  ...(s.outcome === 'error' ? { error: 'error' } : {}),
});

function classifiedOf(c: ChorusWardenAdvice): ClassifiedSummary | undefined {
  if (!c.stages?.length) return undefined;
  const stages = c.stages.map(stageTrace);
  const final = stages.findLastIndex((s) => s.outcome !== undefined);
  return {
    delivered: c.outcome === 'spoke',
    ...(final >= 0 ? { outcome: stages[final]!.outcome!, finalStage: final } : {}),
    stages,
  };
}

/** Why a call brought back no result: the host's refusal or the transport's failure, said once. */
const whyNot = (outcome: Exclude<ChorusCallOutcome<'chorus.advise'>, { ok: true }>) =>
  'failure' in outcome
    ? outcome.message
    : `Chorus refused: ${outcome.refusal}${outcome.message ? ` (${outcome.message})` : ''}`;

/** The advice outcome every asked Warden shares when the call itself brought back no result. */
function unanswered(
  outcome: Exclude<ChorusCallOutcome<'chorus.advise'>, { ok: true }>,
): Exclude<AdviceOutcome, { readonly status: 'answered' }> {
  if ('failure' in outcome) {
    if (outcome.failure === 'timeout') return { status: 'failed', cause: 'timeout' };
    if (outcome.failure === 'invalid-response')
      return { status: 'failed', cause: 'invalid-response' };
    return { status: 'failed', cause: 'provider-error' };
  }
  if (outcome.refusal === 'chorus_warming') return { status: 'not-sent', cause: 'not-held' };
  if (outcome.refusal === 'chorus_unavailable' || outcome.refusal === 'unknown_project')
    return { status: 'not-sent', cause: 'not-admitted' };
  return { status: 'failed', cause: 'provider-error' };
}

const notSentRequest = (reason: string): ParticipantRequest => ({
  status: 'not-sent',
  phase: 'advice',
  reason: reason.slice(0, 500),
});

/** One Chorus contribution as a Warden's advice. */
function adviceOf(
  c: ChorusWardenAdvice,
  evidence: PhaseRequestEvidence,
  catchingUp: boolean,
): RemoteAdvice {
  const classified = classifiedOf(c);
  const base = {
    ...(c.reason ? { reason: c.reason } : {}),
    ...(classified ? { classified } : {}),
    layers: [],
    snippets: [],
    confidence: 0,
  };
  if (c.outcome === 'spoke') {
    const pointer = parseWardenPointer(c.snippets);
    return {
      ...base,
      outcome: { status: 'answered', result: 'spoke' },
      layers: [...c.layers],
      snippets: [...c.snippets],
      confidence: c.confidence,
      ...(pointer.relevant ? { pointer } : {}),
      request: supplied(evidence),
    };
  }
  if (c.outcome === 'no-comment')
    return {
      ...base,
      outcome: { status: 'answered', result: 'no-comment' },
      request: supplied(evidence),
    };
  if (c.outcome === 'failed')
    return {
      ...base,
      outcome: {
        status: 'failed',
        cause: TIMED_OUT.test(c.reason ?? '') ? 'timeout' : 'provider-error',
      },
      request: supplied(evidence),
    };
  // Not sent: a Warden the host holds no session for catches up on the next user message.
  const catchesUp = Boolean(c.catchesUp);
  return {
    ...base,
    outcome: { status: 'not-sent', cause: catchesUp ? 'not-held' : 'not-admitted' },
    ...(catchesUp && catchingUp ? { catchesUp: true as const } : {}),
    request: notSentRequest(c.reason ?? 'Chorus did not send it'),
  };
}

/**
 * Chorus's advice answer as each asked Warden's: its contribution when the host named it, a failure
 * when it did not (not in the host's roster), or the call's own refusal or failure for every one.
 */
function advice(
  prepared: Prepared<AdviceOperation>,
  outcome: ChorusCallOutcome<AdviceOperation>,
  asked: readonly string[],
  catchingUp: boolean,
): Map<string, RemoteAdvice> {
  const answers = new Map<string, RemoteAdvice>();
  const empty = { layers: [], snippets: [], confidence: 0 };
  for (const [domain, reason] of prepared.unaskable)
    answers.set(domain, {
      ...empty,
      outcome: { status: 'failed', cause: 'provider-error' },
      reason,
      request: notSentRequest(reason),
    });
  if (!outcome.ok) {
    const shared = unanswered(outcome);
    const reason = whyNot(outcome);
    for (const domain of asked) {
      const evidence = prepared.evidence.get(domain);
      if (!evidence) continue;
      answers.set(domain, {
        ...empty,
        outcome: shared,
        reason,
        ...(shared.status === 'not-sent' && shared.cause === 'not-held' && catchingUp
          ? { catchesUp: true as const }
          : {}),
        request: shared.status === 'not-sent' ? notSentRequest(reason) : supplied(evidence),
      });
    }
    return answers;
  }
  const result: ChorusAdviceResult = outcome.result;
  const byDomain = new Map(result.contributions.map((c) => [c.domain, c]));
  for (const domain of asked) {
    const evidence = prepared.evidence.get(domain);
    if (!evidence) continue;
    const c = byDomain.get(domain);
    answers.set(
      domain,
      c
        ? adviceOf(c, evidence, catchingUp)
        : {
            ...empty,
            outcome: { status: 'failed', cause: 'provider-error' },
            reason: `not in Chorus's roster (revision ${result.rosterRevision})`,
            request: supplied(evidence),
          },
    );
  }
  return answers;
}

/** One tool call as Chorus's guard reads it, each field within its limit. */
const observationOf = (o: ToolObservation, callIndex: number): ChorusToolObservation => {
  const file = o.filesAffected?.[0];
  return {
    callIndex,
    tool: clip(o.tool || 'tool', OBSERVATION_LIMIT.tool),
    ...(file ? { filePath: clip(file, OBSERVATION_LIMIT.filePath) } : {}),
    summary: clip(JSON.stringify(o.input ?? {}) || '{}', OBSERVATION_LIMIT.summary),
    ...(o.output ? { detail: clip(o.output, OBSERVATION_LIMIT.detail) } : {}),
  };
};

/** A turn's tool calls as Chorus's observations, in call order. */
const observations = (calls: readonly ToolObservation[]) =>
  calls.slice(0, OBSERVATION_LIMIT.count).map(observationOf);

/** The guard call (`chorus.guard`) over a turn's activity, for the gated Wardens. */
function guardCall(options: {
  readonly calls: readonly ToolObservation[];
  readonly threadState: string;
  readonly asked: readonly RemoteAsked[];
  readonly deadlineMs: number;
  readonly capturedAt: number;
}): Prepared<'chorus.guard'> {
  const { sendable, unaskable } = splitAsked(options.asked);
  const shared = {
    observations: observations(options.calls),
    ...(options.threadState ? { threadState: clip(options.threadState, chorusContextLimit) } : {}),
    deadlineMs: deadline(options.deadlineMs),
  };
  const knowledge = knowledgeOf(sendable);
  const input: RelayedOperationInput<'chorus.guard'> = {
    ...shared,
    ...(knowledge ? { threadKnowledge: knowledge } : {}),
    ...(sendable.length ? { domains: sendable.map((a) => a.domain) } : {}),
  };
  const evidence = new Map(
    sendable.map((a) => {
      const own = knowledge?.[a.domain];
      const slice = { ...shared, ...(own ? { threadKnowledge: { [a.domain]: own } } : {}) };
      return [a.domain, evidenceOf('guard', 'chorus.guard', slice, options.capturedAt)] as const;
    }),
  );
  return { operation: 'chorus.guard', input, evidence, unaskable };
}

const guardRequest = (e: PhaseRequestEvidence | undefined, reason: string): ParticipantRequest =>
  e ? supplied(e) : { status: 'not-sent', phase: 'guard', reason: reason.slice(0, 500) };

/**
 * Chorus's guard answer as each asked Warden's: its findings (or an all-clear) when the host checked
 * it, a failure when it skipped or did not name it, or the call's own refusal or failure for every one.
 */
function guard(
  prepared: Prepared<'chorus.guard'>,
  outcome: ChorusCallOutcome<'chorus.guard'>,
  asked: readonly string[],
): Map<string, RemoteGuard> {
  const results = new Map<string, RemoteGuard>();
  const failedWith = (
    domain: string,
    reason: string,
    cause: CallFailedCause = 'provider-error',
  ): RemoteGuard => ({
    findings: [],
    outcome: { status: 'failed', cause },
    admission: 'unknown',
    error: reason.slice(0, 200),
    request: guardRequest(prepared.evidence.get(domain), reason),
  });
  for (const [domain, reason] of prepared.unaskable)
    results.set(domain, failedWith(domain, reason));
  if (!outcome.ok) {
    const shared = unanswered(outcome);
    const reason = whyNot(outcome);
    for (const domain of asked) {
      if (!prepared.evidence.has(domain)) continue;
      if (shared.status === 'not-sent') {
        results.set(domain, {
          findings: [],
          outcome: shared,
          ...(shared.cause === 'not-admitted' ? { admission: 'not-admitted' as const } : {}),
          error: reason.slice(0, 200),
          request: { status: 'not-sent', phase: 'guard', reason: reason.slice(0, 500) },
        });
        continue;
      }
      results.set(domain, failedWith(domain, reason, shared.cause));
    }
    return results;
  }
  const result = outcome.result;
  const checked = new Set(result.checkedDomains);
  const skipped = new Set(result.skippedDomains);
  for (const domain of asked) {
    const evidence = prepared.evidence.get(domain);
    if (!evidence) continue;
    if (skipped.has(domain) || !checked.has(domain)) {
      results.set(
        domain,
        failedWith(
          domain,
          skipped.has(domain)
            ? 'Chorus skipped its check'
            : `not in Chorus's roster (revision ${result.rosterRevision})`,
        ),
      );
      continue;
    }
    const findings: GuardFinding[] = result.findings
      .filter((f) => f.domain === domain)
      .map((f) => {
        const pointer = parseWardenPointer(f.description);
        return {
          severity: f.severity,
          description: f.description,
          ...(f.location ? { location: f.location } : {}),
          ...(pointer.relevant ? { pointer } : {}),
        };
      });
    results.set(domain, {
      findings,
      outcome: { status: 'answered', result: findings.length ? 'findings' : 'all-clear' },
      ...(findings.length ? {} : { noComment: true as const }),
      request: supplied(evidence),
    });
  }
  return results;
}

/** The review call (`chorus.review`): one call over the work, every Warden's update in its answer. */
function reviewCall(options: {
  readonly work: ReviewInput;
  readonly threadState: string;
  readonly asked: readonly RemoteAsked[];
  readonly deadlineMs: number;
}): RelayedOperationInput<'chorus.review'> {
  const { sendable } = splitAsked(options.asked);
  const knowledge = knowledgeOf(sendable);
  const calls = options.work.toolObservations
    .slice(0, OBSERVATION_LIMIT.count)
    .map((o, callIndex) => ({
      callIndex,
      tool: clip(o.tool || 'tool', OBSERVATION_LIMIT.tool),
      summary: clip(o.input || '(no input)', OBSERVATION_LIMIT.summary),
      ...(o.output || o.error
        ? { detail: clip(o.output || o.error || '', OBSERVATION_LIMIT.detail) }
        : {}),
    }));
  const work = options.work;
  return {
    workSummary: moment(
      `User message:\n${work.userMessage}\n\nAgent output${work.ok ? '' : ' (the turn failed)'}:\n${work.output || '(none)'}`,
    ),
    ...(calls.length ? { observations: calls } : {}),
    ...(options.threadState ? { threadState: clip(options.threadState, chorusContextLimit) } : {}),
    ...(knowledge ? { threadKnowledge: knowledge } : {}),
    ...(sendable.length ? { domains: sendable.map((a) => a.domain) } : {}),
    deadlineMs: deadline(options.deadlineMs),
  };
}

/** One Warden's review read off Chorus's answer: its update learned, none to make, or why there is none. */
function review(
  outcome: ChorusCallOutcome<'chorus.review'>,
  domain: string,
  maxChars: number,
): ReviewResult {
  if (!outcome.ok)
    return {
      capacity: 'settled',
      decision: 'error',
      facts: [],
      reason: whyNot(outcome).slice(0, 500),
    };
  const result: ChorusReviewResult = outcome.result;
  const update = result.threadKnowledgeUpdates[domain];
  if (update === undefined) return { capacity: 'settled', decision: 'no-comment', facts: [] };
  if (!update.trim())
    return {
      capacity: 'settled',
      decision: 'invalid',
      facts: [],
      reason: 'Chorus returned an empty update',
    };
  if (update.length > maxChars)
    return {
      capacity: 'settled',
      decision: 'invalid',
      facts: [],
      reason: `Chorus's update is ${update.length} chars, over the ${maxChars} allowed`,
    };
  return { capacity: 'settled', decision: 'learn', knowledge: update, facts: [] };
}

/**
 * Dev mode's remote Chorus (R-2026-11-25-05) in the Wardens' own terms: each trigger's call built
 * within Chorus's limits, with each Warden's own slice as its journalled request, and each answer read
 * back as the contribution, guard result or review a local Warden would have given.
 */
export const chorusRemoteMap = {
  operation: (trigger: AdviceTrigger) => ADVICE_OPERATION[trigger],
  adviceCall,
  advice,
  guardCall,
  guard,
  reviewCall,
  review,
  reviewEvidence: (input: RelayedOperationInput<'chorus.review'>, capturedAt: number) =>
    evidenceOf('review', 'chorus.review', input, capturedAt),
};
