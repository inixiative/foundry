// The stage loop: ask each stage in order, read its answer under its protocol, and go on only with
// the outcomes it escalates, carrying their tag and why. The caller frames the moment and makes the
// call (`ask`); this module never builds a provider. A later stage that fails, answers out of shape or
// outlives its share of the deadline leaves the run with the previous stage's outcome, journalled.

import type {
  ClassifyOutcome,
  ClassifyStageTrace,
  ServedModel,
  TokenCounts,
} from '@inixiative/foundry-core';
import { type Charter, type ClassifyRole, charterFor, charterVersion } from './charters';
import {
  FOLLOWUP_QUESTION,
  type ProtocolSpec,
  parseFollowup,
  readStageAnswer,
  responseProtocol,
  type StageReading,
} from './protocol';
import { deadlineShares, type StageConfig } from './stages';

type Tokens = Omit<TokenCounts, 'providerUsage'>;

/** What an escalating stage hands the next: its outcome, its why and who answered. */
export interface Carried {
  readonly stage: number;
  readonly outcome: Exclude<ClassifyOutcome, 'no'>;
  readonly why?: string;
  readonly model?: string;
}

/** One stage as the caller asks it: its config, charter, protocol and what it carries in. */
export interface StageRun {
  readonly index: number;
  readonly stage: StageConfig;
  readonly charter: Charter;
  readonly spec: ProtocolSpec;
  readonly protocol: string;
  readonly carried?: Carried;
  /** Its share of the trigger's deadline, when the trigger has one. */
  readonly timeoutMs?: number;
}

/** What one call returned: the answer's text, or why there is none. */
export type StageCall =
  | {
      readonly content: string;
      readonly served?: ServedModel;
      readonly tokens?: Tokens;
      readonly docHash?: string;
      /** The same exchange with the answer quoted back and `question` asked (`reason: followup`). */
      readonly followUp?: (question: string) => Promise<{ content: string; tokens?: Tokens }>;
    }
  | { readonly error: string; readonly docHash?: string; readonly cause?: unknown }
  | { readonly notStarted: string };

export interface ClassifyRunOptions {
  readonly stages: readonly StageConfig[];
  readonly envelope: ProtocolSpec['envelope'];
  readonly trigger: ProtocolSpec['trigger'];
  readonly role?: ClassifyRole;
  /** Candidate charter text per stage (eval only); a stage without one runs its fixed charter. */
  readonly charters?: readonly (string | undefined)[];
  /** The trigger's deadline: each stage gets its share. */
  readonly deadlineMs?: number;
  /** The region ids this unit holds (a group's members, else itself): a recogniser naming others is counted. */
  readonly holds?: readonly string[];
  /** Start at a later stage (a group recogniser's fan-out), carrying what the earlier one said. */
  readonly from?: { readonly index: number; readonly carried: Carried };
  readonly ask: (run: StageRun) => Promise<StageCall>;
}

export interface ClassifyResult {
  /** The run's final outcome; absent when its first stage never answered. */
  readonly outcome?: ClassifyOutcome;
  /** The reading the outcome came from, and its stage. */
  readonly final?: StageReading;
  readonly finalStage?: number;
  /** Whether the final reading reaches the thread: a pointing stage's yes. */
  readonly delivered: boolean;
  /** Why a later stage did not decide: the previous stage's outcome stands. */
  readonly fallback?: 'timeout' | 'error' | 'malformed';
  readonly stages: readonly ClassifyStageTrace[];
  /** The first stage failed or answered out of shape (`malformed`). */
  readonly error?: string;
  readonly malformed?: true;
  /** The first stage was never admitted. */
  readonly notStarted?: string;
}

/** A run as the journal keeps it: its outcome, whether it reached the thread, why not, and every stage. */
export interface ClassifiedSummary {
  readonly outcome?: ClassifyOutcome;
  readonly delivered: boolean;
  readonly finalStage?: number;
  readonly fallback?: ClassifyResult['fallback'];
  readonly stages: readonly ClassifyStageTrace[];
}

export function classifiedSummary(result: ClassifyResult): ClassifiedSummary {
  return {
    ...(result.outcome ? { outcome: result.outcome } : {}),
    delivered: result.delivered,
    ...(result.finalStage !== undefined ? { finalStage: result.finalStage } : {}),
    ...(result.fallback ? { fallback: result.fallback } : {}),
    stages: result.stages,
  };
}

/** The section a later stage's input carries: what the earlier stage said, and how much it settles. */
export function carriedSection(carried: Carried): string {
  const who = `Stage ${carried.stage + 1}${carried.model ? ` (${carried.model})` : ''}`;
  const why = carried.why ? `: ${carried.why}` : '.';
  return carried.outcome === 'unsure'
    ? `\n## An earlier stage\n${who} was unsure this moment is in your region${why}\nTreat that as no until your own knowledge shows otherwise.`
    : `\n## An earlier stage\n${who} read this moment as in your region${why}\nIt is a reading, not a finding: check it against your own knowledge.`;
}

/** The charter, protocol and spec of each stage, as the run will send them. */
export function stageRuns(
  options: Pick<ClassifyRunOptions, 'stages' | 'envelope' | 'trigger' | 'role' | 'charters'>,
): Omit<StageRun, 'carried' | 'timeoutMs'>[] {
  return options.stages.map((stage, index) => {
    const spec: ProtocolSpec = {
      envelope: options.envelope,
      trigger: options.trigger,
      task: stage.task,
      outcomes: stage.outcomes,
      reason: stage.reason,
    };
    const override = options.charters?.[index];
    return {
      index,
      stage,
      charter:
        override !== undefined
          ? { text: override, version: charterVersion(override) }
          : charterFor(stage.task, options.role ?? 'warden', stage.pointer),
      spec,
      protocol: responseProtocol(spec),
    };
  });
}

const TIMED_OUT = Symbol('timed-out');

/** `work`, or TIMED_OUT once `ms` pass; the timer is cleared either way. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), Math.max(1, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What a multi-stage run keeps back from the trigger's deadline, so the caller's own deadline (the
 * same one) never fires before a fallback is returned.
 */
const deadlineMargin = (deadlineMs: number) => Math.min(250, deadlineMs * 0.05);

/** Run the stages. A single stage with no deadline split behaves exactly as one call does. */
export async function runStages(options: ClassifyRunOptions): Promise<ClassifyResult> {
  const runs = stageRuns(options);
  const shares = deadlineShares(options.stages);
  const multi = options.stages.length > 1;
  const end =
    options.deadlineMs === undefined
      ? undefined
      : Date.now() + options.deadlineMs - (multi ? deadlineMargin(options.deadlineMs) : 0);
  const traces: ClassifyStageTrace[] = [];
  let carried = options.from?.carried;
  // A fan-out starts past its recogniser: what that stage said is the outcome a failure falls back to.
  let previous: { reading: StageReading; index: number; delivered: boolean } | undefined =
    options.from
      ? {
          reading: { outcome: options.from.carried.outcome, remarks: [] },
          index: options.from.carried.stage,
          delivered: false,
        }
      : undefined;
  for (let index = options.from?.index ?? 0; index < runs.length; index++) {
    const base = runs[index]!;
    // A stage gets its share of the trigger's deadline, never more than the run has left; the last
    // gets all that is left, so time an earlier stage did not use is not thrown away.
    const timeoutMs =
      options.deadlineMs === undefined
        ? undefined
        : !multi
          ? options.deadlineMs
          : index === runs.length - 1
            ? Math.max(0, end! - Date.now())
            : Math.max(0, Math.min(options.deadlineMs * shares[index]!, end! - Date.now()));
    const run: StageRun = {
      ...base,
      ...(carried ? { carried } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };
    const started = Date.now();
    // No time left for this stage: it is not asked, and the run keeps what it has.
    if (multi && timeoutMs !== undefined && timeoutMs < 1 && previous) {
      traces.push({
        stage: index,
        task: base.stage.task,
        doc: base.stage.doc,
        elapsedMs: 0,
        timedOut: true,
        error: 'no time left in the deadline',
      });
      return {
        outcome: previous.reading.outcome,
        final: previous.reading,
        finalStage: previous.index,
        delivered: previous.delivered,
        fallback: 'timeout',
        stages: traces,
      };
    }
    const pending = options.ask(run);
    // A single stage keeps the provider's own deadline; stages share the trigger's, each its part.
    const call =
      multi && timeoutMs !== undefined ? await within(pending, timeoutMs) : await pending;
    const trace = (rest: Partial<ClassifyStageTrace>): ClassifyStageTrace => ({
      stage: index,
      task: base.stage.task,
      doc: base.stage.doc,
      elapsedMs: Date.now() - started,
      ...rest,
    });
    const stop = (fallback: ClassifyResult['fallback'], failure: Partial<ClassifyResult>) => {
      if (previous)
        return {
          outcome: previous.reading.outcome,
          final: previous.reading,
          finalStage: previous.index,
          delivered: previous.delivered,
          fallback,
          stages: traces,
        };
      return { delivered: false, stages: traces, ...failure };
    };
    if (call === TIMED_OUT) {
      void pending.catch(() => undefined);
      traces.push(trace({ timedOut: true, error: `no answer within ${Math.round(timeoutMs!)}ms` }));
      return stop('timeout', { error: `stage ${index + 1} timed out` });
    }
    if ('notStarted' in call) {
      traces.push(trace({ error: `not started: ${call.notStarted}` }));
      return stop('error', { notStarted: call.notStarted });
    }
    if ('error' in call) {
      traces.push(trace({ error: call.error, ...(call.docHash ? { docHash: call.docHash } : {}) }));
      return stop('error', { error: call.error });
    }
    const meta = {
      ...(call.docHash ? { docHash: call.docHash } : {}),
      ...(call.served?.model ? { model: call.served.model } : {}),
      ...(call.served?.effort ? { effort: call.served.effort } : {}),
      ...(call.tokens ? { tokens: call.tokens } : {}),
    };
    const read = readStageAnswer(call.content, base.spec, base.stage.pointer);
    if ('error' in read) {
      traces.push(trace({ ...meta, malformed: true, error: read.error }));
      return stop('malformed', { error: read.error, malformed: true });
    }
    let reading = read;
    let unknown: string[] = [];
    if (reading.regions && options.holds) {
      const held = new Set(options.holds);
      unknown = reading.regions.filter((r) => !held.has(r.regionId)).map((r) => r.regionId);
      const kept = reading.regions.filter((r) => held.has(r.regionId));
      if (!kept.length) {
        traces.push(
          trace({
            ...meta,
            malformed: true,
            error: 'the recogniser named only regions it does not hold',
            unknownRegions: unknown,
          }),
        );
        return stop('malformed', {
          error: 'the recogniser named only regions it does not hold',
          malformed: true,
        });
      }
      reading = {
        ...reading,
        regions: kept,
        outcome: kept.some((r) => r.outcome === 'yes') ? 'yes' : 'unsure',
      };
    }
    let followup: Partial<ClassifyStageTrace> = {};
    if (base.stage.reason === 'followup' && call.followUp) {
      try {
        // The follow-up stays inside the run's deadline: past it, the answer stands without its why.
        const asked = call.followUp(FOLLOWUP_QUESTION);
        const answer = end === undefined ? await asked : await within(asked, end - Date.now());
        if (answer === TIMED_OUT) {
          void asked.catch(() => undefined);
          throw Error('the follow-up had no time left in the deadline');
        }
        const parsed = parseFollowup(answer.content);
        followup = {
          ...(parsed.why ? { why: parsed.why } : {}),
          ...(parsed.revised ? { revised: parsed.revised } : {}),
        };
      } catch (err) {
        followup = { followupError: (err as Error)?.message ?? String(err) };
      }
    }
    const why =
      reading.why ?? reading.regions?.map((r) => r.why).join('; ') ?? reading.pointer?.why;
    traces.push(
      trace({
        ...meta,
        outcome: reading.outcome,
        ...(reading.why ? { why: reading.why } : {}),
        ...followup,
        ...(reading.remarks.length ? { remarks: reading.remarks } : {}),
        ...(reading.regions ? { regions: reading.regions } : {}),
        ...(unknown.length ? { unknownRegions: unknown } : {}),
      }),
    );
    const delivered = reading.outcome === 'yes' && base.stage.task === 'point';
    const escalate =
      index < runs.length - 1 &&
      reading.outcome !== 'no' &&
      (base.stage.escalate ?? []).includes(reading.outcome);
    if (!escalate)
      return {
        outcome: reading.outcome,
        final: reading,
        finalStage: index,
        delivered,
        stages: traces,
      };
    previous = { reading, index, delivered };
    carried = {
      stage: index,
      outcome: reading.outcome as Exclude<ClassifyOutcome, 'no'>,
      ...(why ? { why } : {}),
      ...(call.served?.model ? { model: call.served.model } : {}),
    };
  }
  // Unreachable: the last stage never escalates.
  return { delivered: false, stages: traces, error: 'no stage answered' };
}
