/**
 * @atlas
 * @kind service
 * @partOf feature:threads, feature:viewer
 */
import type { ClassifyStageTrace, NativeEvidence } from '@inixiative/foundry-core';
import { REDUCED_PHASE } from '../archives/reduced-middleware';
import { parseWardenPointer, type WardenPointer } from '../classify';
import type { StoredLearning, StoredPhase, TurnDetail } from '../persistence/local-session-store';

/**
 * One turn as the ordered steps Foundry already recorded (the turn view): the input, routing, each
 * chorus round per region, the sealed plan, what reached the session (and what it already held),
 * every tool call with its input and output, handoffs, the post-turn guard per region, writeback,
 * feedback and Archive capture. A projection of the journal only: nothing here is computed that the
 * turn did not record, and nothing here changes what a later turn receives. `saidBefore` on a chime
 * marks that the same region said the same pointer on an earlier turn of this thread (record-only).
 */

const MAX_TEXT = 4000;
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const clip = (text: string, max = MAX_TEXT) =>
  text.length > max ? `${text.slice(0, max)}…` : text;
const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
const num = (value: unknown) => (typeof value === 'number' ? value : null);
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

export interface ChorusRound {
  /** 1-based: round 1 recognises (Haiku), round 2 confirms and points (Sonnet), as configured. */
  readonly round: number;
  readonly task: ClassifyStageTrace['task'];
  readonly outcome: ClassifyStageTrace['outcome'] | null;
  readonly why: string | null;
  readonly remarks: readonly string[];
  readonly model: string | null;
  readonly effort: string | null;
  readonly elapsedMs: number | null;
  readonly error?: string;
  readonly timedOut?: true;
}

export interface ChorusRegion {
  readonly region: string;
  /** `contribute` (it chimed in), `no-comment`, `abstain`, `error`, `excluded`, … as journalled. */
  readonly decision: string;
  readonly reason: string | null;
  /** What it said (empty for NO_COMMENT). */
  readonly said: readonly string[];
  readonly pointer: WardenPointer | null;
  /** A Warden with configured stages: each round it ran. A single-stage Warden has none; `decision` is its answer. */
  readonly rounds: readonly ChorusRound[];
  readonly served: { model: string; effort?: string } | null;
}

export interface DeliveredChime {
  readonly region: string;
  readonly text: string;
  /** The same region said the same pointer on an earlier turn of this thread. Recorded, not acted on. */
  readonly saidBefore: { readonly turnId: string } | null;
}

export type TimelineStep =
  | { kind: 'input'; at: number | null; text: string; chars: number }
  | {
      kind: 'route';
      at: number | null;
      status: string | null;
      domains: string[];
      layers: string[];
      confidence: number | null;
      reason: string | null;
      elapsedMs: number | null;
    }
  | {
      kind: 'chorus';
      at: number | null;
      trigger: string;
      regions: ChorusRegion[];
      skipped: Record<string, string[]>;
      prefiltered: string[];
    }
  | {
      kind: 'plan';
      at: number | null;
      confidence: number | null;
      elapsedMs: number | null;
      layers: string[];
      omissions: unknown[];
      conflicts: unknown[];
    }
  | {
      kind: 'delivery';
      at: number | null;
      /** `started`: a fresh session (its system prompt carried the base); `held`: a continuing one. */
      session: string | null;
      /** Standing context parts: `sent` this turn, or `held` (the session already had this version). */
      parts: { id: string; hash: string; outcome: 'sent' | 'held' }[];
      chimes: DeliveredChime[];
    }
  | {
      kind: 'tool';
      at: number | null;
      /** `native`: the agent's own tool; `foundry`: a call into Foundry's MCP server. */
      source: 'native' | 'foundry';
      callId: string | null;
      tool: string;
      input: Record<string, unknown> | null;
      output: string | null;
      outputOmitted: boolean;
      error: boolean;
      finishedAt: number | null;
    }
  | {
      kind: 'handoff';
      at: number | null;
      childThreadId: string | null;
      description: string | null;
      agentType: string | null;
    }
  | {
      kind: 'guard';
      at: number | null;
      status: string | null;
      regions: {
        region: string;
        status: string;
        findings: number;
        notes: string[];
        rounds: ChorusRound[];
      }[];
      notes: { severity: string; description: string; location?: string }[];
      failed: string[];
    }
  | {
      kind: 'writeback';
      at: number | null;
      region: string;
      decision: string;
      reason: string | null;
      revision: number | null;
    }
  | {
      kind: 'feedback';
      at: number | null;
      itemId: string | null;
      statement: string | null;
      recurred: boolean;
    }
  | {
      kind: 'archive';
      at: number | null;
      /** `captured`: a capture after this turn ended was written; `pending`; `failed`; `unavailable`: no capture runs. */
      state: 'captured' | 'pending' | 'failed' | 'unavailable';
      error: string | null;
    };

export interface ArchiveCaptureState {
  /** The last capture of this thread the Archive accepted. */
  readonly stored?: { readonly at: number; readonly archiveId: string };
  readonly error?: string;
}

export interface TurnTimelineSources {
  /** Earlier advice rows of this thread, for `saidBefore`. */
  readonly earlierAdvice?: readonly StoredPhase[];
  /** This thread's learning history (writeback outcomes are those whose evidence names this turn). */
  readonly learning?: readonly StoredLearning[];
  readonly archive?: ArchiveCaptureState | null;
}

function rounds(classified: unknown): ChorusRound[] {
  if (!isObject(classified) || !Array.isArray(classified.stages)) return [];
  return (classified.stages as ClassifyStageTrace[]).map((stage) => ({
    round: stage.stage + 1,
    task: stage.task,
    outcome: stage.outcome ?? null,
    why: stage.why ?? null,
    remarks: [...(stage.remarks ?? [])],
    model: stage.model ?? null,
    effort: stage.effort ?? null,
    elapsedMs: stage.elapsedMs ?? null,
    ...(stage.error ? { error: stage.error } : {}),
    ...(stage.timedOut ? { timedOut: true as const } : {}),
  }));
}

function served(request: unknown): ChorusRegion['served'] {
  const s = isObject(request) && isObject(request.served) ? request.served : null;
  return s && typeof s.model === 'string'
    ? { model: s.model, ...(typeof s.effort === 'string' ? { effort: s.effort } : {}) }
    : null;
}

/** What a region said, as one comparable key: its parsed pointer, else its remarks. */
function pointerKey(region: string, said: readonly string[]): string | null {
  if (!said.length) return null;
  const pointer = parseWardenPointer(said);
  const what = pointer.relevant && pointer.pointer ? pointer.pointer : said.join('\n');
  return `${region}\u0000${what.trim().toLowerCase()}`;
}

function chorusRegion(participant: Record<string, unknown>): ChorusRegion {
  const said = strings(participant.snippets);
  const pointer = said.length ? parseWardenPointer(said) : null;
  return {
    region: str(participant.domain) ?? '',
    decision: str(participant.decision) ?? 'unknown',
    reason: str(participant.reason) ?? null,
    said,
    pointer: pointer?.relevant ? pointer : null,
    rounds: rounds(participant.classified),
    served: served(participant.request),
  };
}

function toolSteps(detail: TurnDetail): TimelineStep[] {
  const results = new Map<string, NativeEvidence>();
  for (const e of detail.nativeHistory)
    if (e.kind === 'tool_result' && e.callId) results.set(e.callId, e);
  const native: TimelineStep[] = detail.nativeHistory
    .filter((e) => e.kind === 'tool_use' && e.toolName)
    .map((use) => {
      const result = use.callId ? results.get(use.callId) : undefined;
      return {
        kind: 'tool',
        at: use.observedAt ?? null,
        source: 'native',
        callId: use.callId ?? null,
        tool: use.toolName ?? 'tool',
        input: use.toolInput ? { ...use.toolInput } : null,
        output: result?.toolOutput !== undefined ? clip(result.toolOutput) : null,
        outputOmitted: !!result?.toolOutputOmitted,
        error: !!result?.toolError || use.nativeOutcome === 'failed',
        finishedAt: result?.observedAt ?? null,
      };
    });
  const foundry: TimelineStep[] = detail.nativeTools.map(({ record }) => ({
    kind: 'tool',
    at: record.startedAt,
    source: 'foundry',
    callId: record.id,
    tool: record.operation,
    input: { ...record.arguments },
    output: clip(record.refusal ?? record.result),
    outputOmitted: false,
    error: record.status !== 'ok' && record.status !== 'completed',
    finishedAt: record.finishedAt,
  }));
  return [...native, ...foundry];
}

/** The guard over the turn: its outcome row, with each region's rounds from its request rows' outcomes. */
function guardStep(row: StoredPhase): TimelineStep {
  const r = row.record;
  const outcomes = Array.isArray(r.outcomes) ? r.outcomes.filter(isObject) : [];
  return {
    kind: 'guard',
    at: num(r.finishedAt) ?? row.storedAt,
    status: str(r.status) ?? null,
    regions: outcomes.map((o) => ({
      region: str(o.domain) ?? '',
      status: str(o.status) ?? 'unknown',
      findings: num(o.findings) ?? 0,
      notes: strings(o.notes),
      rounds: rounds(o.classified),
    })),
    notes: (Array.isArray(r.notes) ? r.notes.filter(isObject) : []).map((n) => ({
      severity: str(n.severity) ?? 'advisory',
      description: str(n.description) ?? '',
      ...(str(n.location) ? { location: str(n.location)! } : {}),
    })),
    failed: strings(r.failed),
  };
}

/** The ordered steps of one recorded turn. */
export function turnTimeline(detail: TurnDetail, sources: TurnTimelineSources = {}) {
  const { turn } = detail;
  const user = detail.messages.find((m) => m.actor === 'user');
  const agent = detail.messages.find((m) => m.actor === 'agent');
  const injection = isObject(detail.injection) ? detail.injection : null;
  const plan = isObject(injection?.plan) ? injection.plan : null;
  // Raw rows while retention keeps them; a reduced row only stands in for calls whose raw rows are gone.
  const ids = new Set(detail.phases.map((p) => p.id));
  const phases = detail.phases.filter(
    (p) =>
      p.phase !== REDUCED_PHASE || !strings(p.record.sources).some((source) => ids.has(source)),
  );

  const steps: TimelineStep[] = [];
  if (user)
    steps.push({
      kind: 'input',
      at: turn.startedAt,
      text: clip(user.content),
      chars: user.content.length,
    });

  for (const row of phases.filter((p) => p.phase === 'route')) {
    const routing = isObject(row.record.routing) ? row.record.routing : {};
    steps.push({
      kind: 'route',
      at: num(routing.finishedAt) ?? row.storedAt,
      status: str(routing.status) ?? null,
      domains: strings(routing.domains),
      layers: strings(routing.layers),
      confidence: num(routing.confidence),
      reason: str(routing.reason) ?? null,
      elapsedMs: num(routing.elapsedMs),
    });
  }

  const adviceRows = phases.filter((p) => p.phase === 'advice');
  const chorus = (row: StoredPhase): TimelineStep => {
    const r = row.record;
    const skipped = isObject(r.skipped)
      ? Object.fromEntries(Object.entries(r.skipped).map(([k, v]) => [k, strings(v)]))
      : {};
    return {
      kind: 'chorus',
      at: num(r.sealedAt) ?? row.storedAt,
      trigger: str(r.trigger) ?? 'user-message',
      regions: (Array.isArray(r.participants) ? r.participants.filter(isObject) : []).map(
        chorusRegion,
      ),
      skipped,
      prefiltered: (Array.isArray(r.prefiltered) ? r.prefiltered.filter(isObject) : []).flatMap(
        (p) => (str(p.domain) ? [str(p.domain)!] : []),
      ),
    };
  };
  const onMessage = adviceRows.filter(
    (p) => (str(p.record.trigger) ?? 'user-message') === 'user-message',
  );
  for (const row of onMessage) steps.push(chorus(row));

  if (plan)
    steps.push({
      kind: 'plan',
      at: num(plan.sealedAt),
      confidence: num(plan.confidence),
      elapsedMs: num(plan.elapsed),
      layers: strings(plan.layers),
      omissions: Array.isArray(plan.omissions) ? plan.omissions : [],
      conflicts: Array.isArray(plan.conflicts) ? plan.conflicts : [],
    });

  if (injection) {
    const session = isObject(injection.sessionDelivery) ? injection.sessionDelivery : null;
    const sent = new Set(
      (Array.isArray(session?.sent) ? session.sent.filter(isObject) : []).map(
        (p) => `${p.id}\u0000${p.hash}`,
      ),
    );
    const standing = Array.isArray(injection.standingParts)
      ? injection.standingParts.filter(isObject)
      : [];
    // Earlier turns' chimes, oldest first: the first turn a region said each pointer.
    const earlier = new Map<string, string>();
    for (const row of sources.earlierAdvice ?? []) {
      if (!row.turnId || row.turnId === turn.id) continue;
      for (const p of Array.isArray(row.record.participants)
        ? row.record.participants.filter(isObject)
        : []) {
        if (p.decision !== 'contribute') continue;
        const key = pointerKey(str(p.domain) ?? '', strings(p.snippets));
        if (key && !earlier.has(key)) earlier.set(key, row.turnId);
      }
    }
    const saidNow = new Map(
      onMessage.flatMap((row) =>
        (Array.isArray(row.record.participants) ? row.record.participants.filter(isObject) : [])
          .filter((p) => p.decision === 'contribute')
          .map((p) => [str(p.domain) ?? '', strings(p.snippets)] as const),
      ),
    );
    const decoration = isObject(injection.decoration) ? injection.decoration : null;
    const chimes = (Array.isArray(decoration?.blocks) ? decoration.blocks.filter(isObject) : [])
      .filter((b) => b.segment === 'domain-knowledge' && typeof b.source === 'string')
      .map((b) => {
        const region = b.source as string;
        const key = pointerKey(region, saidNow.get(region) ?? []);
        const before = key ? earlier.get(key) : undefined;
        return {
          region,
          text: clip(str(b.text) ?? ''),
          saidBefore: before ? { turnId: before } : null,
        };
      });
    steps.push({
      kind: 'delivery',
      at: num(injection.capturedAt),
      session: str(session?.session) ?? null,
      parts: standing.map((p) => {
        const id = str(p.id) ?? '',
          hash = str(p.hash) ?? '';
        return { id, hash, outcome: sent.has(`${id}\u0000${hash}`) ? 'sent' : 'held' };
      }),
      chimes,
    });
  }

  // The agent's work and what Foundry did during it (handoffs, handoff briefs, the guard), by time.
  const work: TimelineStep[] = toolSteps(detail);
  for (const row of phases) {
    if (row.phase === 'handoff')
      work.push({
        kind: 'handoff',
        at: row.storedAt,
        childThreadId: str(row.record.childThreadId) ?? null,
        description: str(row.record.description) ?? null,
        agentType: str(row.record.agentType) ?? null,
      });
    else if (row.phase === 'advice' && !onMessage.includes(row)) work.push(chorus(row));
    else if (row.phase === 'guard-outcome') work.push(guardStep(row));
  }
  steps.push(...work.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)));

  for (const entry of sources.learning ?? []) {
    const content = isObject(entry.signal.content) ? entry.signal.content : {};
    const evidence = isObject(content.evidence) ? content.evidence : {};
    if (evidence.messageId !== turn.id || typeof content.domain !== 'string') continue;
    steps.push({
      kind: 'writeback',
      at: num(content.at) ?? entry.storedAt,
      region: content.domain,
      decision: str(content.decision) ?? 'unknown',
      reason: str(content.reason) ?? null,
      revision: num(content.revision),
    });
  }

  for (const row of phases.filter((p) => p.phase === 'feedback-capture'))
    steps.push({
      kind: 'feedback',
      at: row.storedAt,
      itemId: str(row.record.itemId) ?? null,
      statement: str(row.record.statement) ?? null,
      recurred: row.record.recurred === true,
    });

  const archive = sources.archive;
  const ended = turn.endedAt;
  steps.push(
    archive === undefined || archive === null
      ? { kind: 'archive', at: null, state: 'unavailable', error: null }
      : archive.stored && ended !== undefined && archive.stored.at >= ended
        ? { kind: 'archive', at: archive.stored.at, state: 'captured', error: null }
        : archive.error
          ? { kind: 'archive', at: null, state: 'failed', error: archive.error }
          : { kind: 'archive', at: null, state: 'pending', error: null },
  );

  return {
    threadId: detail.threadId,
    turnId: detail.turnId,
    status: turn.status,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt ?? null,
    ...(turn.error ? { error: turn.error } : {}),
    outcome: str(agent?.meta?.turnStatus) ?? null,
    steps,
  };
}
export type TurnTimeline = ReturnType<typeof turnTimeline>;
