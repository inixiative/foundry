/**
 * @atlas
 * @kind service
 * @partOf feature:acp
 */
/**
 * The "Foundry: context" item: what the middleware decided for a turn, read from the turn's
 * sealed route and advice phase rows on the `flow:<threadId>` stream. These rows are written
 * before the executor runs, so the host sees them before the agent's first output.
 */

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

export interface ContextSummary {
  readonly text: string;
  readonly routing: Record_ | null;
  readonly participants: Array<{ domain: string; decision: string; reason?: string }>;
}

/** The summary for one flow-stream turn, or null while neither phase row has been recorded. */
export function contextSummary(turn: unknown): ContextSummary | null {
  if (!isRecord(turn) || !Array.isArray(turn.phases)) return null;
  const rows = turn.phases.filter(isRecord);
  const route = rows.find((row) => row.phase === 'route');
  const advice = rows.find((row) => row.phase === 'advice');
  if (!route && !advice) return null;

  const routing =
    isRecord(route?.record) && isRecord(route.record.routing) ? route.record.routing : null;
  const participants = (
    isRecord(advice?.record) && Array.isArray(advice.record.participants)
      ? advice.record.participants
      : []
  )
    .filter(isRecord)
    .map((p) => ({
      domain: typeof p.domain === 'string' ? p.domain : 'unknown',
      decision: typeof p.decision === 'string' ? p.decision : 'unknown',
      ...(typeof p.reason === 'string' && p.reason ? { reason: p.reason } : {}),
    }));

  const lines: string[] = [];
  if (routing) {
    const status = typeof routing.status === 'string' ? routing.status : 'unknown';
    const confidence =
      typeof routing.confidence === 'number' ? `, confidence ${routing.confidence.toFixed(2)}` : '';
    const layers = strings(routing.layers);
    const domains = strings(routing.domains);
    lines.push(
      `Routing (${status}${confidence}): ${layers.length ? `layers ${layers.join(', ')}` : 'no layers'}${
        domains.length ? `; domains ${domains.join(', ')}` : ''
      }`,
    );
  }
  if (participants.length)
    lines.push(
      'Wardens:',
      ...participants.map((p) => `- ${p.domain}: ${p.decision}${p.reason ? ` (${p.reason})` : ''}`),
    );
  return { text: lines.join('\n') || 'No routing or advice recorded.', routing, participants };
}
