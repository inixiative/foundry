/**
 * @atlas
 * @kind service
 * @partOf feature:wardens
 */
import type { ClassifyStageTrace, NativeEvidence } from '@inixiative/foundry-core';
import type { ClassifiedSummary } from '../classify';
import type { ToolObservation } from './domain-librarian';
import type { AdviceTrigger } from './warden-triggers';

/**
 * A Warden the system, not the Warden, kept quiet at one moment: its call timed out, failed or was
 * never admitted, at Layer 1 (`stages[0]`) or Layer 2 (`stages[1]`). Wardens are a chorus, so the
 * turn went on without it; this is what the thread shows and what Retry asks again (FEAT-008).
 */
export interface DegradedWarden {
  readonly domain: string;
  readonly kind: 'timeout' | 'error' | 'not-started';
  /** 1-based layer that failed; null when the call never reported a stage (an orchestrator deadline). */
  readonly layer: number | null;
  /** True when the Warden said nothing. False: a pointing Layer 1's answer stood, unconfirmed. */
  readonly silent: boolean;
  readonly reason: string | null;
}

/** One Warden's recorded answer, as the advice rows journal it (and a guard outcome maps onto). */
export interface ChorusAnswer {
  readonly domain: string;
  /** `contribute`, `no-comment`, `timeout`, `error`, `excluded`, `skipped`, `omitted`. */
  readonly decision: string;
  readonly reason?: string;
  readonly classified?: Pick<ClassifiedSummary, 'fallback' | 'stages'>;
}

const clip = (text: string | undefined) => (text ? text.slice(0, 300) : null);

/** The stage that failed: the last trace, when it carries an error or a timeout. */
function failedStage(stages: readonly ClassifyStageTrace[] | undefined) {
  const last = stages?.at(-1);
  return last && (last.timedOut || last.error) ? last : undefined;
}

/** What the writer knows that a row alone does not say. */
export interface DegradedContext {
  /** How many layers a Warden runs: a one-layer Warden's failure is at Layer 1 by definition. */
  readonly stageCount?: (domain: string) => number | undefined;
  /** Wardens whose cache was not warm within the deadline (`warmWithin` shortfalls): skipped as cold. */
  readonly notWarm?: ReadonlySet<string>;
}

/**
 * Whether one Warden's answer was degraded, and how. Undefined when it was a real answer or a skip.
 * The failing stage is the last trace: `runStages` stops at the first stage that fails. A budget
 * `omitted` is not degraded: the Warden spoke and the composition policy chose (it is in `omissions`),
 * and asking again hits the same budget.
 */
export function degradedAnswer(
  answer: ChorusAnswer,
  context: DegradedContext = {},
): DegradedWarden | undefined {
  const { domain, decision, classified } = answer;
  const failed = failedStage(classified?.stages);
  const single = context.stageCount?.(domain) === 1;
  const layer = failed ? failed.stage + 1 : single ? 1 : null;
  const reason = clip(failed?.error ?? answer.reason);
  if (decision === 'timeout') return { domain, kind: 'timeout', layer, silent: true, reason };
  if (decision === 'excluded') return { domain, kind: 'not-started', layer, silent: true, reason };
  if (decision === 'skipped' && answer.reason === 'cold-cache' && context.notWarm?.has(domain))
    return { domain, kind: 'not-started', layer, silent: true, reason: 'not warm in time' };
  if (decision === 'error')
    return { domain, kind: failed?.timedOut ? 'timeout' : 'error', layer, silent: true, reason };
  // A later layer failed and the earlier layer's outcome stood (classify `runStages`'s fallback).
  if (classified?.fallback && failed)
    return {
      domain,
      kind: failed.timedOut ? 'timeout' : 'error',
      layer,
      silent: decision !== 'contribute',
      reason,
    };
  return undefined;
}

/** The degraded Wardens of one advice row's participants. */
export function degradedWardens(
  answers: readonly ChorusAnswer[],
  context: DegradedContext = {},
): DegradedWarden[] {
  return answers.flatMap((answer) => {
    const degraded = degradedAnswer(answer, context);
    return degraded ? [degraded] : [];
  });
}

/** Every Warden asked at a moment whose whole fan-out failed: none of them was heard. */
export function allDegraded(
  domains: readonly string[],
  error: string,
  context: DegradedContext = {},
): DegradedWarden[] {
  return domains.map((domain) => ({
    domain,
    kind: 'error' as const,
    layer: context.stageCount?.(domain) === 1 ? 1 : null,
    silent: true,
    reason: clip(error),
  }));
}

/** A guard outcome as the journal keeps it: its status, and its staged run when it had one. */
export interface GuardAnswer {
  readonly domain: string;
  readonly status: string;
  readonly noComment?: boolean;
  readonly findings?: number;
  readonly error?: string;
  readonly classified?: Pick<ClassifiedSummary, 'fallback' | 'stages'>;
}

/**
 * The degraded Wardens of one guard over a moment: the checks the report already lists as not
 * completed (`GuardReport.failed`), plus a completed check whose Layer 2 failed. A guard's stages run
 * under no per-stage deadline, so a slow guard is a provider error, never a stage timeout.
 */
export function degradedGuards(
  outcomes: readonly GuardAnswer[],
  failed: readonly string[],
  context: DegradedContext = {},
): DegradedWarden[] {
  const notCompleted = new Set(failed);
  return degradedWardens(
    outcomes.map((o) => ({
      domain: o.domain,
      decision: notCompleted.has(o.domain)
        ? o.status === 'not-admitted'
          ? 'excluded'
          : 'error'
        : o.status === 'completed' && !o.noComment && o.findings
          ? 'contribute'
          : 'no-comment',
      ...(o.error ? { reason: o.error } : {}),
      ...(o.classified ? { classified: o.classified } : {}),
    })),
    context,
  );
}

/** The journal field: present only when some Warden was degraded. */
export const degradedField = (degraded: readonly DegradedWarden[]) =>
  degraded.length ? { degraded: [...degraded] } : {};

/**
 * One journalled row asked again (FEAT-008): the degraded Wardens of an advice row on its own moment,
 * or of a guard row on the turn's tool activity rebuilt from the journal.
 */
export type ChorusRetry =
  | {
      readonly kind: 'advice';
      /** The phase row being retried. */
      readonly of: string;
      readonly turnId: string | null;
      readonly trigger: AdviceTrigger;
      readonly moment: string;
      readonly domains: readonly string[];
    }
  | {
      readonly kind: 'guard';
      readonly of: string;
      readonly turnId: string | null;
      readonly observations: readonly ToolObservation[];
      readonly domains: readonly string[];
    };

/** A chorus row of one turn as the reader needs it: advice, guard outcome or a dismissal. */
export interface ChorusRow {
  readonly id: string;
  readonly phase: string;
  readonly trigger?: string;
  readonly degraded?: readonly DegradedWarden[];
  readonly retryOf?: string;
  /** `chorus-dismiss`: the rows it dismissed. */
  readonly of?: readonly string[];
}

/** One row's degraded Wardens, and whether it was asked again. */
export interface ChorusNotice {
  readonly rowId: string;
  /** The row's trigger point (`user-message`, `subagent-spawn`, `consumed`, `agent-action`). */
  readonly trigger: string;
  readonly degraded: readonly DegradedWarden[];
  /** The row that asked these Wardens again, when one did. */
  readonly retriedBy: string | null;
}

/** A turn's chorus health: every degraded row, the ones still open (not retried, not dismissed). */
export interface TurnChorus {
  readonly notices: readonly ChorusNotice[];
  /** Rows still degraded: neither asked again nor dismissed. What Retry asks. */
  readonly open: readonly string[];
}

export const CHORUS_PHASES = ['advice', 'guard-outcome', 'chorus-dismiss'] as const;

/** The chorus health of one turn from its rows, in journal order. Undefined when nothing was degraded. */
export function turnChorus(rows: readonly ChorusRow[]): TurnChorus | undefined {
  const retriedBy = new Map<string, string>();
  const dismissed = new Set<string>();
  for (const row of rows) {
    if (row.retryOf) retriedBy.set(row.retryOf, row.id);
    if (row.phase === 'chorus-dismiss') for (const id of row.of ?? []) dismissed.add(id);
  }
  const notices = rows
    .filter((row) => row.phase !== 'chorus-dismiss' && row.degraded?.length)
    .map((row) => ({
      rowId: row.id,
      trigger: row.trigger ?? (row.phase === 'guard-outcome' ? 'agent-action' : 'user-message'),
      degraded: row.degraded!,
      retriedBy: retriedBy.get(row.id) ?? null,
    }));
  if (!notices.length) return undefined;
  return {
    notices,
    open: notices.filter((n) => !n.retriedBy && !dismissed.has(n.rowId)).map((n) => n.rowId),
  };
}

/** A journalled phase row, decoded (`LocalSessionStore.phaseHistory`). */
interface PhaseRow {
  readonly id: string;
  readonly phase: string;
  readonly record: Record<string, unknown>;
}

/** The chorus rows of a turn's decoded phase rows. */
export function chorusRows(phases: readonly PhaseRow[]): ChorusRow[] {
  return phases
    .filter((p) => (CHORUS_PHASES as readonly string[]).includes(p.phase))
    .map((p) => ({
      id: p.id,
      phase: p.phase,
      ...(typeof p.record.trigger === 'string' ? { trigger: p.record.trigger } : {}),
      ...(Array.isArray(p.record.degraded)
        ? { degraded: p.record.degraded as DegradedWarden[] }
        : {}),
      ...(typeof p.record.retryOf === 'string' ? { retryOf: p.record.retryOf } : {}),
      ...(Array.isArray(p.record.of)
        ? { of: p.record.of.filter((id): id is string => typeof id === 'string') }
        : {}),
    }));
}

/** What a retry needs from the journal of one turn. */
export interface RetrySource {
  readonly turnId: string;
  readonly phases: readonly PhaseRow[];
  /** The turn's native history: its tool calls are the guard's moment. */
  readonly nativeHistory: readonly NativeEvidence[];
}

/**
 * The guard row's moment rebuilt from the journal: exactly the calls it recorded (`activity.calls`,
 * by call id, in its order), each with its journalled input and output. Refused, with why, when the
 * row elided calls or the journal no longer holds a call whole. `filesAffected` and the original
 * clipping are not journalled, so the moment is the same calls, not the same bytes.
 */
export function journalActivity(
  record: Record<string, unknown>,
  history: readonly NativeEvidence[],
): { observations: ToolObservation[] } | { unavailable: string } {
  const activity = record.activity as
    | { calls?: Array<{ tool?: unknown; callId?: unknown }>; overflow?: unknown }
    | undefined;
  const calls = Array.isArray(activity?.calls) ? activity.calls : [];
  if (!calls.length) return { unavailable: 'the row recorded no calls' };
  if (activity?.overflow) return { unavailable: 'the row elided calls past its bound' };
  const uses = new Map<string, NativeEvidence>();
  const results = new Map<string, NativeEvidence>();
  for (const e of history)
    if (e.callId)
      (e.kind === 'tool_result' ? results : e.kind === 'tool_use' ? uses : null)?.set(e.callId, e);
  const observations: ToolObservation[] = [];
  for (const call of calls) {
    const use = typeof call.callId === 'string' ? uses.get(call.callId) : undefined;
    if (!use?.toolName || use.toolInputOmitted)
      return { unavailable: `the journal does not hold call ${String(call.callId ?? call.tool)}` };
    const result = results.get(call.callId as string);
    if (result?.toolOutputOmitted)
      return { unavailable: `the journal omitted the output of call ${String(call.callId)}` };
    observations.push({
      tool: use.toolName,
      input: { ...(use.toolInput ?? {}) },
      ...(result?.toolOutput !== undefined ? { output: result.toolOutput } : {}),
      callId: call.callId as string,
      ...(result ? { ok: !result.toolError } : {}),
    });
  }
  return { observations };
}

/**
 * The retries Retry starts for a turn: one per open degraded row, asking only its degraded Wardens,
 * each on its own moment. A row whose moment the journal does not hold is reported, not guessed.
 */
export function chorusRetries(source: RetrySource): {
  retries: ChorusRetry[];
  unavailable: Array<{ rowId: string; reason: string }>;
} {
  const health = turnChorus(chorusRows(source.phases));
  const retries: ChorusRetry[] = [];
  const unavailable: Array<{ rowId: string; reason: string }> = [];
  for (const rowId of health?.open ?? []) {
    const notice = health!.notices.find((n) => n.rowId === rowId)!;
    const record = source.phases.find((p) => p.id === rowId)!.record;
    const domains = [...new Set(notice.degraded.map((d) => d.domain))];
    if (notice.trigger === 'agent-action') {
      const rebuilt = journalActivity(record, source.nativeHistory);
      if ('unavailable' in rebuilt) unavailable.push({ rowId, reason: rebuilt.unavailable });
      else
        retries.push({
          kind: 'guard',
          of: rowId,
          turnId: source.turnId,
          observations: rebuilt.observations,
          domains,
        });
      continue;
    }
    const moment = typeof record.moment === 'string' ? record.moment : undefined;
    if (!moment) {
      unavailable.push({ rowId, reason: 'the journal does not hold the moment it was asked on' });
      continue;
    }
    retries.push({
      kind: 'advice',
      of: rowId,
      turnId: source.turnId,
      trigger: notice.trigger as AdviceTrigger,
      moment,
      domains,
    });
  }
  return { retries, unavailable };
}
