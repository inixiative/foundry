// The Warden charter eval: run a chorus over real-session probes under one classify configuration and
// score how quiet, how right and how in-scope it is. Same code path as live (DomainLibrarian running
// classify's stages, each charter composed above the Warden's instructions), at both trigger points:
// `user-message` advises on the user's ask, `agent-action` guards the agent's turn. No thread, no
// writes. Scoring and the probe contract live in foundry-core (`feedback/warden-probes`), so Oracle
// scores runs the same way.

import { createHash } from 'node:crypto';
import { RUN_ENV, stampRunDirectory } from '@inixiative/archive/exemption';
import {
  type ClassifyStageTrace,
  ContextLayer,
  type LLMProvider,
  parseWardenJudgement,
  probeTriggers,
  SignalBus,
  WARDEN_JUDGE_PROMPT,
  type WardenProbe,
  type WardenProbeAnswer,
  type WardenProbeTrigger,
  type WardenProbeTurn,
  wardenJudgeMessage,
} from '@inixiative/foundry-core';
import {
  type AdviseResult,
  DomainLibrarian,
  type GuardResult,
  oneCall,
  type WardenStage,
} from '../agents/domain-librarian';
import {
  type Carried,
  type ClassifyResult,
  DEFAULT_STAGES,
  isDefaultStages,
  KNOWLEDGE_DOC,
  type Recognition,
  type StageConfig,
  type StageDebug,
} from '../classify';

/** Mark this process and its state directory as an eval run: Archive and the repeat report leave its sessions out. */
export function markEvalRun(state: string): void {
  process.env[RUN_ENV] = 'oracle';
  stampRunDirectory(state, 'oracle');
}

/** One Warden as the eval composes it: its own instructions and domain knowledge. */
export interface EvalWarden {
  readonly domain: string;
  readonly instructions: string;
  /** Its knowledge slot: the region's knowledge.md as the role composes it. */
  readonly domainKnowledge: string;
  /** Every other doc a stage reads, by name, composed the same way. */
  readonly docs?: Readonly<Record<string, string>>;
  /** A group recogniser: the region ids it holds. Its first stage's yeses fan out to those regions. */
  readonly members?: readonly string[];
  /** The role's composition budget, as live (`roleComposition(...).budget`). */
  readonly budget?: number;
  /**
   * The logical session its calls run under, as a live thread's Warden runs under its thread: its
   * knowledge is primed once and read from the prompt cache after. One-shot calls when omitted.
   */
  readonly session?: string;
  /** Text this Warden sees as thread context on top of the probe's own. Per call, never cached with the knowledge. */
  readonly context?: string;
}

/** The tool name a probe's moment arrives under: the agent's finished turn, before the user answers. */
const PROBE_MOMENT_TOOL = 'AgentTurn';

export interface CharterEvalOptions {
  readonly probes: readonly WardenProbe[];
  /** The Wardens (regions, or group recognisers) that may see a probe: its context's ladder. */
  readonly wardensFor: (probe: WardenProbe, trigger: WardenProbeTrigger) => readonly EvalWarden[];
  /** A group recogniser's member, as the region Warden its later stages run as. */
  readonly memberWarden?: (probe: WardenProbe, regionId: string) => EvalWarden | undefined;
  /** Haiku on the subscription, as live Wardens run: every stage's provider without `stageProviders`. */
  readonly warden: LLMProvider;
  /** One provider per stage (one host per model and effort); a stage without one uses `warden`. */
  readonly stageProviders?: readonly (LLMProvider | undefined)[];
  /** The classify stages under test; the shipped single stage when omitted. */
  readonly stages?: readonly StageConfig[];
  /** Candidate charter text per stage (eval only); a stage without one runs its fixed charter. */
  readonly charters?: readonly (string | undefined)[];
  /**
   * The region Warden's instruction line per stage (its `region-instructions` section; empty leaves
   * it out); a stage without one sends the Warden's composed instructions unchanged.
   */
  readonly regionInstructions?: readonly (string | undefined)[];
  /** The grader of remarks; remarks are left unjudged when omitted (graded later, e.g. as pointers). */
  readonly judge?: LLMProvider;
  /** Wardens in flight at once: the decision queue's size. */
  readonly concurrency?: number;
  /** The trigger points to ask at, where a probe recorded their input; `agent-action` when omitted. */
  readonly triggers?: readonly WardenProbeTrigger[];
  /**
   * Re-asks of a Warden call the transport failed or never admitted (a loaded machine, a rate
   * limit). Live never retries; the eval measures what Wardens say, so a lost call is asked again
   * and only a call still failing after these counts as an error. Default 2.
   */
  readonly retries?: number;
  /** Wait before the first re-ask, growing per attempt. Default 5 s. */
  readonly retryDelayMs?: number;
  /** Turns an earlier run already finished (`--resume`): skipped. */
  readonly done?: (probeId: string, trigger: WardenProbeTrigger) => boolean;
  /** Awaited before each turn is asked: a long run waits out the subscription's window here. */
  readonly beforeTurn?: (probeId: string, trigger: WardenProbeTrigger) => Promise<void>;
  readonly onAnswer?: (answer: WardenProbeAnswer) => void;
  /** Called once a turn's answers are all judged and passed to `onAnswer`. */
  readonly onTurn?: (turn: WardenProbeTurn) => void;
  /**
   * Debug runs only (a run config's `"debug": true`): every stage of every cell also takes its two
   * debug readings (classify `StageDebug`: the why inline, and the why asked after the real answer),
   * on the same session and prefix. Rows reach `onDebug` once their turn is recorded (after
   * `onTurn`), so a run stopped mid-turn leaves none behind; answers are unchanged by it.
   */
  readonly onDebug?: (row: WardenDebug) => void;
  /** Which cells take debug readings (the Warden asked: a group recogniser, else the region); all when omitted. */
  readonly debugCell?: (probeId: string, domain: string) => boolean;
}

/** One stage's debug readings for one cell (`debug.jsonl`). */
export interface WardenDebug extends StageDebug {
  readonly probeId: string;
  /** The Warden asked at that stage: a group recogniser at its first stage, the member after. */
  readonly domain: string;
  readonly trigger: WardenProbeTrigger;
}

type DebugSink = (domain: string, reading: StageDebug) => void;

/**
 * Run each probe as one turn per trigger point: every Warden is asked at once, as the live chorus is,
 * bounded by `concurrency`: through the advice phase on the user's ask (`user-message`), and through
 * the guard phase on the agent's turn (`agent-action`). Probes run one after another, so each turn's
 * wall clock is what a live turn would wait. A group recogniser's answer becomes one row per member.
 * Every remark is then judged against the user's real next message.
 */
export async function runCharterEval(
  options: CharterEvalOptions,
): Promise<{ answers: WardenProbeAnswer[]; turns: WardenProbeTurn[] }> {
  const answers: WardenProbeAnswer[] = [];
  const turns: WardenProbeTurn[] = [];
  const wanted = options.triggers ?? ['agent-action'];
  for (const probe of options.probes) {
    for (const trigger of probeTriggers(probe).filter(
      (t) => wanted.includes(t) && !options.done?.(probe.id, t),
    )) {
      const wardens = options.wardensFor(probe, trigger);
      if (!wardens.length) continue;
      await options.beforeTurn?.(probe.id, trigger);
      // The gate may have closed the run (a quota stop): a turn it closed is not asked.
      if (options.done?.(probe.id, trigger)) continue;
      const started = Date.now();
      const asked: WardenProbeAnswer[][] = new Array(wardens.length);
      // Debug rows wait for their turn to be recorded, so a stopped turn leaves none behind.
      const debugged: WardenDebug[][] = new Array(wardens.length);
      let next = 0;
      await Promise.all(
        Array.from(
          { length: Math.max(1, Math.min(options.concurrency ?? 16, wardens.length)) },
          async () => {
            while (next < wardens.length) {
              const index = next++;
              const cell = await askWithRetries(options, probe, wardens[index]!, trigger);
              asked[index] = cell.rows;
              debugged[index] = cell.debug;
            }
          },
        ),
      );
      const rows = asked.flat();
      turns.push({
        probeId: probe.id,
        trigger,
        calls: rows.length,
        wallMs: Date.now() - started,
        notAdmitted: rows.filter((a) => a.error === 'not-admitted').length,
      });
      const describe = (domain: string) =>
        (
          wardens.find((w) => w.domain === domain) ?? options.memberWarden?.(probe, domain)
        )?.instructions.slice(0, 1200) ?? '';
      for (const answer of rows) {
        const judged =
          options.judge && !answer.noComment && !answer.error && answer.text
            ? await judge(options.judge, {
                domain: answer.domain,
                domainDescription: describe(answer.domain),
                moment: probe.moment,
                ...(probe.ask ? { ask: probe.ask } : {}),
                trigger,
                ...(probe.gold?.target ? { target: probe.gold.target } : {}),
                remark: answer.text,
                hidden: probe.hidden ?? '',
              })
            : undefined;
        const final = judged ? { ...answer, judged } : answer;
        answers.push(final);
        options.onAnswer?.(final);
      }
      options.onTurn?.(turns.at(-1)!);
      for (const row of debugged.flat()) options.onDebug?.(row);
    }
  }
  return { answers, turns };
}

/** What the Warden knows of the thread for this call: the probe's own understanding, then the Warden's per-call context. */
function threadKnowledge(
  probe: WardenProbe,
  warden: EvalWarden,
): { threadKnowledge: string } | undefined {
  const text = [probe.threadKnowledge, warden.context].filter(Boolean).join('\n\n');
  return text ? { threadKnowledge: text } : undefined;
}

/** A failure of the call itself, not of the Warden's answer. */
const TRANSPORT_FAILURE = /not-admitted|decision (?:failed|rate limited)|timed? ?out|ECONN|exited/i;

async function askWithRetries(
  options: CharterEvalOptions,
  probe: WardenProbe,
  warden: EvalWarden,
  trigger: WardenProbeTrigger,
): Promise<{ rows: WardenProbeAnswer[]; debug: WardenDebug[] }> {
  const lost = (rows: WardenProbeAnswer[]) =>
    rows.length > 0 && rows.every((a) => a.error && TRANSPORT_FAILURE.test(a.error));
  // Each attempt keeps its own debug rows: only the attempt that stands reports them.
  const attempt = async () => {
    const debug: WardenDebug[] = [];
    const sink: DebugSink | undefined =
      options.onDebug && (options.debugCell?.(probe.id, warden.domain) ?? true)
        ? (domain, reading) => debug.push({ probeId: probe.id, domain, trigger, ...reading })
        : undefined;
    return { rows: await ask(options, probe, warden, trigger, sink), debug };
  };
  let cell = await attempt();
  const retried: string[] = [];
  for (let n = 0; n < (options.retries ?? 2) && lost(cell.rows); n++) {
    retried.push(cell.rows[0]!.error!);
    await Bun.sleep((options.retryDelayMs ?? 5_000) * (n + 1));
    cell = await attempt();
  }
  return retried.length ? { ...cell, rows: cell.rows.map((a) => ({ ...a, retried })) } : cell;
}

type Row = Omit<WardenProbeAnswer, 'probeId' | 'domain' | 'trigger' | 'elapsedMs'>;

/** A Warden's answer as a row: a yes speaks its final remarks; a no, or a final unsure, is silence. */
function rowOf(result: AdviseResult | GuardResult, classified?: ClassifyResult): Row {
  const staged = classified
    ? { ...(classified.outcome ? { outcome: classified.outcome } : {}), stages: classified.stages }
    : {};
  if ('status' in result) {
    if (result.status !== 'completed')
      return {
        noComment: false,
        error: result.status === 'not-admitted' ? 'not-admitted' : (result.error ?? result.status),
        ...staged,
      };
  } else if (result.notStarted) return { noComment: false, error: 'not-admitted', ...staged };
  else if (result.error || result.skipped)
    return { noComment: false, error: result.error ?? result.skipped!, ...staged };
  // A run that fell back is not the configuration's answer: its failed stage's error, counted apart
  // (and re-asked when the transport lost it), never a yes or a silence.
  if (classified?.fallback) {
    const failed = classified.stages.at(-1);
    return {
      noComment: false,
      error: `stage ${(failed?.stage ?? 0) + 1} ${classified.fallback}: ${failed?.error ?? 'no answer'}`,
      ...staged,
    };
  }
  if (classified?.final)
    return classified.outcome === 'yes' && classified.final.remarks.length
      ? { noComment: false, text: classified.final.remarks.join('\n'), ...staged }
      : { noComment: true, ...staged };
  if ('status' in result)
    return result.noComment
      ? { noComment: true }
      : {
          noComment: false,
          text: result.findings
            .map((f) => [f.description, f.suggestion].filter(Boolean).join(' '))
            .join('\n'),
        };
  // Advice without a snippet adds nothing a Warden would say to the thread.
  return result.noComment || !result.snippets.length
    ? { noComment: true }
    : { noComment: false, text: result.snippets.join('\n') };
}

/** A trace's tokens split evenly over a group's members, so per-region cost sums to the group's. */
function shared(trace: ClassifyStageTrace, members: number): ClassifyStageTrace {
  if (!trace.tokens) return trace;
  const part = (n: number) => Math.round(n / members);
  const t = trace.tokens;
  return {
    ...trace,
    tokens: {
      input: part(t.input),
      output: part(t.output),
      ...(t.cacheRead !== undefined ? { cacheRead: part(t.cacheRead) } : {}),
      ...(t.cacheWrite !== undefined ? { cacheWrite: part(t.cacheWrite) } : {}),
      ...(t.thinking !== undefined ? { thinking: part(t.thinking) } : {}),
    },
  };
}

async function ask(
  options: CharterEvalOptions,
  probe: WardenProbe,
  warden: EvalWarden,
  trigger: WardenProbeTrigger,
  sink?: DebugSink,
): Promise<WardenProbeAnswer[]> {
  const stages = options.stages ?? DEFAULT_STAGES;
  const staged =
    !isDefaultStages(stages) ||
    !!options.charters?.some((c) => c !== undefined) ||
    !!options.regionInstructions?.some((r) => r !== undefined);
  const started = Date.now();
  // A one-stage call's usage as the provider reported it: cache reads show a warm, primed prefix.
  let tokens: WardenProbeAnswer['tokens'];
  // An unstaged row's one call: its full system message's hash (a staged row has it per stage trace).
  let systemHash: string | undefined;
  const counted = (provider: LLMProvider): LLMProvider =>
    Object.assign(Object.create(provider) as LLMProvider, {
      complete: async (...args: Parameters<LLMProvider['complete']>) => {
        systemHash ??= createHash('sha256')
          .update(args[0][0]?.content ?? '')
          .digest('hex');
        const result = await provider.complete(...args);
        // The first call is the live one: debug readings that follow it never replace its count.
        if (result.tokens && !tokens) {
          const { providerUsage: _usage, ...counts } = result.tokens;
          tokens = counts;
        }
        return result;
      },
    });
  // Debug readings are timed apart, so a row's time is its live calls' with debug on or off. Each run
  // keeps its own count: a group's members run at once, so one shared count would mix them.
  const row = (domain: string, rest: Row, debugMs = 0): WardenProbeAnswer => ({
    probeId: probe.id,
    domain,
    trigger,
    elapsedMs: Date.now() - started - debugMs,
    ...(!staged && tokens ? { tokens } : {}),
    ...(!staged && systemHash ? { systemHash } : {}),
    ...rest,
  });
  const run = async (who: EvalWarden, holds?: readonly string[], from?: Carried) => {
    let debugMs = 0;
    const timed: DebugSink | undefined = sink
      ? (domain, reading) => {
          debugMs += reading.elapsedMs;
          sink(domain, reading);
        }
      : undefined;
    const lib = librarian(options, who, stages, counted, holds, timed);
    const fromOpts = from ? { from: { index: from.stage + 1, carried: from } } : {};
    if (trigger === 'user-message') {
      const advice = await lib.advise(probe.ask ?? '', undefined, {
        ...threadKnowledge(probe, who),
        ...fromOpts,
      });
      return {
        result: advice as AdviseResult | GuardResult,
        classified: advice.classified,
        debugMs,
      };
    }
    const guard = await lib.guard(
      oneCall({ tool: PROBE_MOMENT_TOOL, input: { turn: probe.moment } }),
      undefined,
      { ...threadKnowledge(probe, who), ...fromOpts },
    );
    return { result: guard as AdviseResult | GuardResult, classified: guard.classified, debugMs };
  };
  const group = warden.members;
  if (!group) {
    const { result, classified, debugMs } = await run(warden);
    return [row(warden.domain, rowOf(result, staged ? classified : undefined), debugMs)];
  }
  // A group recogniser asks its first stage once; each member it names goes on as that region's own
  // run from the next stage, carrying its line. Members it did not name are silent; its failure is theirs.
  const { result, classified, debugMs: groupMs } = await run(warden, group);
  const first = classified?.stages[0];
  const failed = rowOf(result, classified);
  if (failed.error || !first)
    return group.map((id) =>
      row(id, { ...failed, ...(first ? { stages: [shared(first, group.length)] } : {}) }, groupMs),
    );
  const mine = shared(first, group.length);
  const named = new Map<string, Recognition>(
    (classified!.final?.regions ?? []).map((r) => [r.regionId, r]),
  );
  return Promise.all(
    group.map(async (id): Promise<WardenProbeAnswer> => {
      const recognition = named.get(id);
      if (!recognition)
        return row(
          id,
          { noComment: true, outcome: 'no', stages: [{ ...mine, outcome: 'no' }] },
          groupMs,
        );
      const own: ClassifyStageTrace = {
        ...mine,
        outcome: recognition.outcome,
        why: recognition.why,
        regions: [recognition],
      };
      if (stages.length === 1 || !(stages[0]!.escalate ?? []).includes(recognition.outcome))
        return row(
          id,
          {
            noComment: recognition.outcome !== 'yes',
            ...(recognition.outcome === 'yes' ? { text: `${id}: ${recognition.why}` } : {}),
            outcome: recognition.outcome,
            stages: [own],
          },
          groupMs,
        );
      const member = options.memberWarden?.(probe, id);
      if (!member)
        return row(
          id,
          { noComment: false, error: `no member region ${id} for the later stages`, stages: [own] },
          groupMs,
        );
      const later = await run(member, undefined, {
        stage: 0,
        outcome: recognition.outcome,
        why: recognition.why,
        ...(first.model ? { model: first.model } : {}),
      });
      const rest = rowOf(later.result, later.classified);
      return row(
        id,
        { ...rest, stages: [own, ...(later.classified?.stages ?? [])] },
        groupMs + later.debugMs,
      );
    }),
  );
}

/** A Warden as live builds it, bound to the eval's providers: one stage per config, each its own doc. */
function librarian(
  options: CharterEvalOptions,
  warden: EvalWarden,
  stages: readonly StageConfig[],
  counted: (provider: LLMProvider) => LLMProvider,
  holds?: readonly string[],
  sink?: DebugSink,
): DomainLibrarian {
  const layer = (id: string, text: string) => {
    const l = new ContextLayer({ id });
    l.set(text);
    return l;
  };
  const session = (index: number) =>
    warden.session ? { threadId: index ? `${warden.session}:stage:${index}` : warden.session } : {};
  const llmOpts = (index: number) => ({ maxTokens: 512, temperature: 0, ...session(index) });
  const provider = (index: number) => counted(options.stageProviders?.[index] ?? options.warden);
  // A group recogniser runs its first stage alone: its yeses fan out to its members' own runs.
  const asked = holds ? stages.slice(0, 1) : stages;
  const bound: WardenStage[] = asked.map((config, index) => {
    const charter = options.charters?.[index];
    const regionInstructions = options.regionInstructions?.[index];
    const doc =
      warden.docs?.[config.doc] ??
      (config.doc === KNOWLEDGE_DOC ? warden.domainKnowledge : undefined);
    return {
      config,
      ...(index ? { llm: provider(index), llmOpts: llmOpts(index) } : {}),
      // Live composes a stage's own doc only when it is not the knowledge slot.
      ...(index || config.doc !== KNOWLEDGE_DOC
        ? { cache: layer(`eval:${warden.domain}:${config.doc}`, doc ?? '') }
        : {}),
      ...(charter !== undefined ? { charter } : {}),
      ...(regionInstructions !== undefined ? { regionInstructions } : {}),
    };
  });
  return new DomainLibrarian({
    domain: warden.domain,
    cache: layer(`eval:${warden.domain}`, warden.domainKnowledge),
    instructions: layer(`eval:${warden.domain}:instructions`, warden.instructions),
    signals: new SignalBus(0),
    llm: provider(0),
    llmOpts: llmOpts(0),
    guardTriggers: [PROBE_MOMENT_TOOL],
    ...(warden.budget !== undefined ? { budget: warden.budget } : {}),
    stages: bound,
    ...(holds ? { holds } : {}),
    ...(sink ? { debug: (reading: StageDebug) => sink(warden.domain, reading) } : {}),
  });
}

/** A judge call that fails (not one that answers out of shape) is asked again, up to twice. */
export async function judge(
  provider: LLMProvider,
  input: Parameters<typeof wardenJudgeMessage>[0],
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await provider.complete(
        [
          { role: 'system', content: WARDEN_JUDGE_PROMPT },
          { role: 'user', content: wardenJudgeMessage(input) },
        ],
        { maxTokens: 300, temperature: 0, tools: false, maxTurns: 1 },
      );
      return parseWardenJudgement(result.content);
    } catch {
      await Bun.sleep(5_000 * (attempt + 1));
    }
  }
  return undefined;
}
