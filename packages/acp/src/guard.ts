/**
 * @atlas
 * @kind service
 * @partOf feature:acp, feature:wardens
 */
/**
 * Warden findings on a tool call, as host comments: the `guard-outcome` phase rows the post-action
 * review journals (on the `flow:<threadId>` stream). Wardens are a chorus: their findings are shown,
 * never turned into a block.
 */
type Row = Record<string, unknown>;
const isRecord = (value: unknown): value is Row =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export interface GuardComment {
  readonly id: string;
  readonly text: string;
  readonly meta: Row;
}

export function guardComments(turn: unknown): GuardComment[] {
  if (!isRecord(turn) || !Array.isArray(turn.phases)) return [];
  return turn.phases.filter(isRecord).flatMap((row) => {
    if (row.phase !== 'guard-outcome' || typeof row.id !== 'string' || !isRecord(row.record))
      return [];
    const record = row.record;
    const notes = Array.isArray(record.notes) ? record.notes.filter(isRecord) : [];
    if (!notes.length) return [];
    const tool = isRecord(record.observation) ? record.observation.tool : undefined;
    const lines = notes.map((note) => {
      const where = typeof note.location === 'string' ? ` (${note.location})` : '';
      const fix = typeof note.suggestion === 'string' ? ` Suggestion: ${note.suggestion}` : '';
      return `- ${note.severity === 'critical' ? 'Critical' : 'Note'}: ${String(note.description)}${where}.${fix}`;
    });
    const domains = Array.isArray(record.domainsChecked) ? record.domainsChecked.join(', ') : '';
    return [
      {
        id: row.id,
        text: [
          `Wardens${domains ? ` (${domains})` : ''} on ${typeof tool === 'string' ? tool : 'a tool call'}:`,
          ...lines,
        ].join('\n'),
        meta: {
          tool: typeof tool === 'string' ? tool : null,
          critical: typeof record.critical === 'number' ? record.critical : 0,
          findings: typeof record.findings === 'number' ? record.findings : notes.length,
        },
      },
    ];
  });
}
