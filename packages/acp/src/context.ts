/**
 * @atlas
 * @kind service
 * @partOf feature:acp
 */
/**
 * The "Foundry: context" item: what the middleware decided for a turn, read from the turn's
 * sealed advice phase row on the `flow:<threadId>` stream. These rows are written
 * before the executor runs, so the host sees it before the agent's first output.
 */

import { ADVICE_RESULTS, recordedOutcomeLabel } from '@inixiative/foundry-core';

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const outcomeLabel = (value: unknown) => recordedOutcomeLabel(value, ADVICE_RESULTS) ?? 'unknown';

export interface ContextSummary {
  readonly text: string;
  readonly participants: Array<{ domain: string; outcome: string; reason?: string }>;
  /** Wardens the system kept quiet (timed out, failed, not admitted), as the row records them (FEAT-008). */
  readonly degraded: Record_[];
}

/** A row's `degraded` list, as recorded. */
export function degradedOf(record: unknown): Record_[] {
  return isRecord(record) && Array.isArray(record.degraded) ? record.degraded.filter(isRecord) : [];
}

/** "Some Wardens went unheard …" in words: which Wardens went unheard, at which layer, and why. */
export function degradedLine(degraded: readonly Record_[]): string | null {
  if (!degraded.length) return null;
  const what = degraded.map((d) => {
    const layer = typeof d.layer === 'number' ? `Layer ${d.layer} ` : '';
    const kind =
      d.kind === 'timeout' ? 'timed out' : d.kind === 'not-started' ? 'not started' : 'failed';
    const spoke = d.silent === false ? '; spoke from Layer 1 only, unconfirmed' : '';
    return `${String(d.domain)} (${layer}${kind}${spoke})`;
  });
  return `Some Wardens went unheard; the turn went on without them: ${what.join(', ')}. Retry is in the Foundry viewer.`;
}

/** The summary for one flow-stream turn, or null while its advice row has not been recorded. */
export function contextSummary(turn: unknown): ContextSummary | null {
  if (!isRecord(turn) || !Array.isArray(turn.phases)) return null;
  const rows = turn.phases.filter(isRecord);
  // The sealed advice row; a retry (FEAT-008) is a later row with `retryOf`.
  const advice = rows.find(
    (row) => row.phase === 'advice' && !(isRecord(row.record) && row.record.retryOf),
  );
  if (!advice) return null;

  const participants = (
    isRecord(advice?.record) && Array.isArray(advice.record.participants)
      ? advice.record.participants
      : []
  )
    .filter(isRecord)
    .map((p) => ({
      domain: typeof p.domain === 'string' ? p.domain : 'unknown',
      outcome: outcomeLabel(p.outcome),
      ...(typeof p.reason === 'string' && p.reason ? { reason: p.reason } : {}),
    }));

  const lines: string[] = [];
  if (participants.length)
    lines.push(
      'Wardens:',
      ...participants.map((p) => `- ${p.domain}: ${p.outcome}${p.reason ? ` (${p.reason})` : ''}`),
    );
  const degraded = degradedOf(advice?.record);
  const line = degradedLine(degraded);
  if (line) lines.push(line);
  return {
    text: lines.join('\n') || 'No advice recorded.',
    participants,
    degraded,
  };
}
