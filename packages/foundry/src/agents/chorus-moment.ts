/**
 * @atlas
 * @kind transformer
 * @partOf feature:wardens
 */
import type { ClassifyStageTrace, ParticipantRequest } from '@inixiative/foundry-core';
import {
  type ChorusOperation,
  type ChorusStageTrace,
  type ChorusToolObservation,
  type ChorusWardenAdvice,
  chorusContextLimit,
  chorusDomainCountLimit,
  chorusDomainIdSchema,
  chorusEarlierMessagesSchema,
  chorusKnowledgeLimit,
  chorusMaxDeadlineMs,
  chorusMomentLimit,
  chorusToolObservationSchema,
  type RelayedOperationInput,
} from '@inixiative/signet';
import { z } from 'zod';
import { type ClassifyResult, parseWardenPointer } from '../classify';
import type { ChorusCallOutcome, ChorusRemote } from '../providers/chorus-client';
import type {
  AdviseOpts,
  AdviseResult,
  EarlierMessages,
  GuardFinding,
  GuardOpts,
  GuardResult,
  PhaseRequestEvidence,
  ToolObservation,
  TurnActivity,
} from './warden';
import type { AdviceTrigger } from './warden-triggers';

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

/** The provider a remote Chorus call is journalled under. */
const PROVIDER_ID = 'chorus-remote';

const earlierSchema = z.toJSONSchema(chorusEarlierMessagesSchema).properties?.messages;
const EARLIER_MAX =
  (typeof earlierSchema === 'object' ? earlierSchema.maxItems : undefined) ??
  chorusDomainCountLimit;
const field = chorusToolObservationSchema.shape;
const OBSERVATION_LIMIT = {
  tool: field.tool.maxLength ?? chorusMomentLimit,
  filePath: field.filePath.unwrap().maxLength ?? chorusMomentLimit,
  summary: field.summary.maxLength ?? chorusMomentLimit,
  detail: field.detail.unwrap().maxLength ?? chorusMomentLimit,
};

const clip = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max));
const momentText = (text: string) => clip(text.trim() ? text : '(no text)', chorusMomentLimit);
const deadline = (ms: number | undefined) =>
  Math.min(
    chorusMaxDeadlineMs,
    Math.max(1_000, Math.round(ms !== undefined && Number.isFinite(ms) ? ms : chorusMaxDeadlineMs)),
  );
const isDomainId = (domain: string) => chorusDomainIdSchema.safeParse(domain).success;
const unaskable = (domain: string) => `"${domain}" is not a domain id Chorus accepts`;

/** One Warden asked at the moment: its domain, its own thread knowledge, and what it missed (user messages). */
export interface ChorusMember {
  readonly domain: string;
  readonly threadKnowledge: string;
  readonly earlier?: EarlierMessages;
}

/** The fields every Warden's call shares, and its thread knowledge by domain. */
function sharedInput(members: readonly ChorusMember[], threadState: string) {
  const sendable = members.filter((m) => isDomainId(m.domain));
  const knowledge = sendable
    .filter((m) => m.threadKnowledge)
    .map((m) => [m.domain, clip(m.threadKnowledge, chorusKnowledgeLimit)] as const);
  return {
    ...(threadState ? { threadState: clip(threadState, chorusContextLimit) } : {}),
    ...(knowledge.length ? { threadKnowledge: Object.fromEntries(knowledge) } : {}),
    ...(sendable.length ? { domains: sendable.map((m) => m.domain) } : {}),
  };
}

/** The call exactly as it leaves, as every asked Warden's journalled request. */
const evidenceOf = (
  phase: PhaseRequestEvidence['phase'],
  remote: ChorusRemote,
  operation: ChorusOperation,
  input: unknown,
): PhaseRequestEvidence => ({
  phase,
  providerId: PROVIDER_ID,
  capturedAt: Date.now(),
  messages: [
    {
      role: 'user',
      content: JSON.stringify({ operation, projectId: remote.projectId, input }),
    },
  ],
});

/** The earlier messages as Chorus takes them: each within the moment limit, the newest that fit, the rest counted. */
function earlierInput(earlier: EarlierMessages | undefined) {
  if (!earlier || (!earlier.messages.length && !earlier.dropped)) return undefined;
  const kept = earlier.messages.filter((m) => m.trim()).map((m) => clip(m, chorusMomentLimit));
  const shown = kept.slice(-EARLIER_MAX);
  return { messages: shown, dropped: earlier.dropped + (earlier.messages.length - shown.length) };
}

/**
 * Why a call brought back no result, as the Warden outcome every asked one shares: nothing ran
 * (refused, unreachable, no token) is not sent; no answer in time or one off the contract failed.
 */
function unanswered(
  outcome: Exclude<ChorusCallOutcome<ChorusOperation>, { readonly ok: true }>,
): Pick<AdviseResult, 'notSent' | 'error' | 'failure'> {
  if ('refusal' in outcome) {
    const reason = `Chorus refused: ${outcome.refusal}${outcome.message ? ` (${outcome.message})` : ''}`;
    return { notSent: { cause: 'not-admitted', reason: reason.slice(0, 500) } };
  }
  if (outcome.failure === 'timeout' || outcome.failure === 'invalid-response')
    return { error: outcome.message, failure: outcome.failure };
  return { notSent: { cause: 'not-admitted', reason: outcome.message.slice(0, 500) } };
}

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

function classifiedOf(c: ChorusWardenAdvice): ClassifyResult | undefined {
  if (!c.stages?.length) return undefined;
  const stages = c.stages.map(stageTrace);
  const final = stages.findLastIndex((s) => s.outcome !== undefined);
  return {
    delivered: c.outcome === 'spoke',
    ...(final >= 0 ? { outcome: stages[final]!.outcome!, finalStage: final } : {}),
    stages,
  };
}

const empty = { layers: [], snippets: [], confidence: 0 };

/** One Chorus contribution as the Warden's own advise result. */
function adviseResultOf(c: ChorusWardenAdvice): AdviseResult {
  const classified = classifiedOf(c);
  const staged = classified ? { classified } : {};
  if (c.outcome === 'spoke') {
    const pointer = parseWardenPointer(c.snippets);
    return {
      layers: [...c.layers],
      snippets: [...c.snippets],
      confidence: c.confidence,
      ...(pointer.relevant ? { pointer } : {}),
      ...staged,
    };
  }
  if (c.outcome === 'no-comment') return { ...empty, noComment: true, ...staged };
  if (c.outcome === 'failed')
    return {
      ...empty,
      error: c.reason ?? 'Chorus reported the call failed',
      failure: c.stages?.some((s) => s.outcome === 'timeout') ? 'timeout' : 'provider-error',
      ...staged,
    };
  // A Warden the host holds no session for catches up on the next user message.
  const reason = c.reason ?? 'Chorus did not send it';
  return {
    ...empty,
    notSent: { cause: c.catchesUp ? 'not-held' : 'not-admitted', reason },
    ...staged,
  };
}

/**
 * A moment's advice through dev mode's remote Chorus (R-2026-11-25-05), in `Warden.advise`'s terms:
 * one `chorus.*` call for every Warden asked with the same earlier messages (a user message's
 * missed ones; signet carries one run per call), fired by the first Warden asked and shared by the
 * rest. Each gets back its own result, read off the shared answer.
 */
function advice(
  remote: ChorusRemote,
  moment: {
    readonly trigger: AdviceTrigger;
    readonly message: string;
    readonly threadState: string;
    readonly members: readonly ChorusMember[];
  },
): (domain: string, opts: AdviseOpts) => Promise<AdviseResult> {
  const operation = ADVICE_OPERATION[moment.trigger];
  interface Group {
    readonly members: ChorusMember[];
    readonly earlier?: ReturnType<typeof earlierInput>;
    sent?: { evidence: PhaseRequestEvidence; answer: Promise<ChorusCallOutcome<AdviceOperation>> };
  }
  const groups = new Map<string, Group>();
  const groupOf = new Map<string, Group>();
  for (const member of moment.members) {
    const earlier = moment.trigger === 'user-message' ? earlierInput(member.earlier) : undefined;
    const key = JSON.stringify(earlier ?? null);
    const group = groups.get(key) ?? { members: [], ...(earlier ? { earlier } : {}) };
    groups.set(key, group);
    group.members.push(member);
    groupOf.set(member.domain, group);
  }
  const send = (group: Group, timeoutMs: number | undefined) => {
    const input = {
      moment: momentText(moment.message),
      ...sharedInput(group.members, moment.threadState),
      deadlineMs: deadline(timeoutMs),
      ...(group.earlier ? { earlier: chorusEarlierMessagesSchema.parse(group.earlier) } : {}),
    } as RelayedOperationInput<AdviceOperation>;
    return {
      evidence: evidenceOf('advice', remote, operation, input),
      answer: remote.call(operation, input),
    };
  };
  return async (domain, opts) => {
    const group = groupOf.get(domain);
    if (!group) return { ...empty, error: `${domain} was not asked at this moment` };
    if (!isDomainId(domain))
      return { ...empty, notSent: { cause: 'not-admitted', reason: unaskable(domain) } };
    group.sent ??= send(group, opts.timeoutMs);
    opts.observeRequest?.({ ...group.sent.evidence, phase: 'advice' });
    const outcome = await group.sent.answer;
    if (!outcome.ok) return { ...empty, ...unanswered(outcome) };
    const contribution = outcome.result.contributions.find((c) => c.domain === domain);
    if (!contribution)
      return {
        ...empty,
        error: `not in Chorus's roster (revision ${outcome.result.rosterRevision})`,
        failure: 'provider-error',
      };
    return adviseResultOf(contribution);
  };
}

/** One tool call as Chorus's guard reads it, each field within its signet limit. */
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

const supplied = (e: PhaseRequestEvidence): ParticipantRequest => ({
  status: 'supplied',
  phase: e.phase,
  providerId: e.providerId,
  messages: e.messages,
  capturedAt: e.capturedAt,
});

/**
 * A turn's guard through dev mode's remote Chorus, in `Warden.guard`'s terms: one `chorus.guard`
 * built once for every gated Warden, observed by each as its request, then sent as observed. A
 * Warden whose observer refuses it is not admitted (the caller's catch says so); when every one
 * refuses, nothing is sent.
 */
function guard(
  remote: ChorusRemote,
  turn: {
    readonly activity: TurnActivity;
    readonly threadState: string;
    readonly members: readonly ChorusMember[];
    readonly deadlineMs: number;
  },
): (domain: string, opts: GuardOpts) => Promise<GuardResult> {
  const input: RelayedOperationInput<'chorus.guard'> = {
    observations: turn.activity.observations.slice(0, chorusDomainCountLimit).map(observationOf),
    ...sharedInput(turn.members, turn.threadState),
    deadlineMs: deadline(turn.deadlineMs),
  };
  const evidence = evidenceOf('guard', remote, 'chorus.guard', input);
  let answer: Promise<ChorusCallOutcome<'chorus.guard'>> | undefined;
  return async (domain, opts) => {
    const revision =
      opts.threadKnowledgeRevision !== undefined
        ? { threadKnowledgeRevision: opts.threadKnowledgeRevision }
        : {};
    if (!isDomainId(domain))
      return {
        findings: [],
        outcome: { status: 'not-sent', cause: 'not-admitted' },
        admission: 'not-admitted',
        error: unaskable(domain),
        ...revision,
        request: { status: 'not-sent', phase: 'guard', reason: unaskable(domain) },
      };
    opts.observeRequest?.(evidence);
    // why: every gated Warden is observed in the caller's same synchronous pass; send after it.
    await null;
    answer ??= remote.call('chorus.guard', input);
    const outcome = await answer;
    const request = supplied(evidence);
    if (!outcome.ok) {
      const { notSent, error, failure } = unanswered(outcome);
      if (notSent)
        return {
          findings: [],
          outcome: { status: 'not-sent', cause: notSent.cause },
          admission: 'not-admitted',
          error: notSent.reason.slice(0, 200),
          ...revision,
          request,
        };
      return {
        findings: [],
        outcome: { status: 'failed', cause: failure ?? 'provider-error' },
        admission: 'unknown',
        error: (error ?? '').slice(0, 200),
        ...revision,
        request,
      };
    }
    const result = outcome.result;
    if (result.skippedDomains.includes(domain))
      return {
        findings: [],
        outcome: { status: 'not-sent', cause: 'not-held' },
        error: 'Chorus skipped its check: no session held for it',
        ...revision,
        request,
      };
    if (!result.checkedDomains.includes(domain))
      return {
        findings: [],
        outcome: { status: 'failed', cause: 'provider-error' },
        admission: 'unknown',
        error: `not in Chorus's roster (revision ${result.rosterRevision})`,
        ...revision,
        request,
      };
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
    return {
      findings,
      outcome: { status: 'answered', result: findings.length ? 'findings' : 'all-clear' },
      ...(findings.length ? {} : { noComment: true as const }),
      ...revision,
      request,
    };
  };
}

/**
 * Dev mode's remote Chorus at the Warden boundary: a moment's advice and a turn's guard as one
 * call each, handed back per Warden as `Warden.advise` and `Warden.guard` would, so the
 * orchestrator's own path (deadlines, catch-up, journal) is the only path.
 */
export const chorusMoment = { advice, guard };
