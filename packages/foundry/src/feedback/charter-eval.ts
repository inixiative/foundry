// The Warden charter eval: run a chorus over real-session probes with one charter wording and score
// how quiet, how right and how in-scope it is. Same code path as live (DomainLibrarian with the
// charter composed above each Warden's instructions), at both trigger points: `user-message` advises
// on the user's ask, `agent-action` guards the agent's turn. No thread, no writes. Scoring and the
// probe contract live in foundry-core (`feedback/warden-probes`), so Oracle scores runs the same way.

import { RUN_ENV, stampRunDirectory } from '@inixiative/archive/exemption';
import {
  ContextLayer,
  type LLMMessage,
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
  DomainLibrarian,
  domainCachePrefix,
  oneCall,
  threadSection,
} from '../agents/domain-librarian';
import { adviceResponseProtocol } from '../classify';

/** Mark this process and its state directory as an eval run: Archive and the repeat report leave its sessions out. */
export function markEvalRun(state: string): void {
  process.env[RUN_ENV] = 'oracle';
  stampRunDirectory(state, 'oracle');
}

/** One Warden as the eval composes it: its own instructions and domain knowledge. */
export interface EvalWarden {
  readonly domain: string;
  readonly instructions: string;
  readonly domainKnowledge: string;
  /** The role's composition budget, as live (`roleComposition(...).budget`). */
  readonly budget?: number;
  /**
   * The logical session its calls run under, as a live thread's Warden runs under its thread: its
   * knowledge is primed once and read from the prompt cache after. One-shot calls when omitted.
   */
  readonly session?: string;
  /**
   * Text this Warden sees as thread context on top of the probe's own (the v1 chain's picker gets the
   * recogniser's "why" line here). Per call, never cached with the knowledge.
   */
  readonly context?: string;
}

/** The tool name a probe's moment arrives under: the agent's finished turn, before the user answers. */
const PROBE_MOMENT_TOOL = 'AgentTurn';

export interface CharterEvalOptions {
  readonly probes: readonly WardenProbe[];
  /** The Wardens that may see a probe (its context's ladder); a chain's second stage picks them per trigger. */
  readonly wardensFor: (probe: WardenProbe, trigger: WardenProbeTrigger) => readonly EvalWarden[];
  /** Haiku on the subscription, as live Wardens run. */
  readonly warden: LLMProvider;
  /** The grader of remarks; remarks are left unjudged when omitted (graded later, e.g. as pointers). */
  readonly judge?: LLMProvider;
  /** The wording under test; the shipped WARDEN_CHARTER when omitted. */
  readonly charter?: string;
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
   * Diagnostic runs only (`--diagnose`): after each `user-message` answer, ask the same Warden, on the
   * same composed prompt and under the same bar, three more readings: `bare` (the protocol swapped for
   * one word, YES or NO: isolates the protocol swap), `oneshot` (YES or NO, the name it would point
   * at, and why: against `bare`, whether producing a reason moves the decision), and `followup` (the
   * live exchange quoted back, then "why?"). Rows reach `onDiagnosis` once their turn is recorded, so
   * a run stopped mid-turn leaves none behind. Live Wardens never do this.
   */
  readonly diagnose?: boolean;
  readonly onDiagnosis?: (diagnosis: WardenDiagnosis) => void;
}

type Tokens = WardenProbeAnswer['tokens'];

/** One cell's diagnostic: the live answer and three readings of the same prompt. */
export interface WardenDiagnosis {
  readonly probeId: string;
  readonly domain: string;
  readonly trigger: WardenProbeTrigger;
  /** The live answer: true when the Warden pointed, false on NO_COMMENT. */
  readonly answered: boolean;
  readonly bare: {
    readonly decision?: 'yes' | 'no';
    readonly error?: string;
    readonly tokens?: Tokens;
  };
  readonly oneshot: {
    readonly decision?: 'yes' | 'no';
    /** The name it would point at; absent when it said none. */
    readonly name?: string;
    readonly why?: string;
    readonly error?: string;
    readonly tokens?: Tokens;
  };
  /**
   * A quoted-answer review, not the Warden's own turn: on the primed transport the live answer
   * reaches it as text inside one user message. Descriptive only.
   */
  readonly followup: {
    readonly why?: string;
    /** `keep`, or the answer the Warden now says is right. */
    readonly revised?: 'keep' | 'yes' | 'no';
    readonly error?: string;
    readonly tokens?: Tokens;
  };
}

/** The live bar, restated for the diagnostic readings so they decide on the same terms. */
const DIAGNOSE_BAR = `Apply your usual bar: YES only when the message touches something your domain says already exists, something you can name from your knowledge (a pointer you cannot source is a guess, so NO); otherwise NO, whatever the message says to build or not to use.`;

export const DIAGNOSE_BARE_PROTOCOL = `This is a diagnostic run, not a live turn. ${DIAGNOSE_BAR}
Answer with one word and nothing else: YES or NO.`;

export const DIAGNOSE_ONESHOT_PROTOCOL = `This is a diagnostic run, not a live turn. ${DIAGNOSE_BAR}
Answer in exactly this shape and nothing else:
Line 1: YES or NO.
Line 2: NAME: the exact name from your knowledge you would point at, or none.
Line 3: WHY: one or two sentences: what the message asks for, and which part of your domain it does or does not touch.`;

export const DIAGNOSE_FOLLOWUP = `This is a diagnostic question, not a live turn. Above is the answer given to this message. In at most two short lines, explain it:
1. What the message asks for, in your words.
2. Which part of your domain it does or does not touch, and why.
Then one last line: \`REVISED: KEEP\` if that answer stands, or \`REVISED: YES\` / \`REVISED: NO\` if on reflection the other answer is right.`;

const lines = (text: string) =>
  text
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
/** The answer's leading YES or NO (markdown and punctuation tolerated) and whatever follows it. */
const leading = (text: string) => {
  // NO_COMMENT, the live protocol's no, still answers NO.
  const m = /^[\W_]*(YES|NO)(?:_COMMENT)?\b[\W_]*(.*)$/is.exec(text.trim());
  return m ? { decision: m[1]!.toLowerCase() as 'yes' | 'no', rest: m[2]!.trim() } : undefined;
};

/** A bare reading: YES or NO, alone. */
export function parseBare(text: string): { decision?: 'yes' | 'no' } {
  const lead = leading(text);
  return lead ? { decision: lead.decision } : {};
}

/** A one-shot reading: its YES or NO, the NAME line (`none` is no name) and the WHY. */
export function parseOneshot(text: string): {
  decision?: 'yes' | 'no';
  name?: string;
  why?: string;
} {
  const lead = leading(text);
  const body = lines(lead ? lead.rest : text);
  const field = (key: string) =>
    body
      .map((l) => new RegExp(`^[*_\\s]*${key}[*_\\s]*:\\s*(.*)$`, 'i').exec(l)?.[1]?.trim())
      .find((v) => v !== undefined);
  const name = field('NAME')?.replace(/[`*]/g, '').trim();
  const why =
    field('WHY') ??
    body
      .filter((l) => !/^[*_\s]*NAME[*_\s]*:/i.test(l))
      .join(' ')
      .trim();
  return {
    ...(lead ? { decision: lead.decision } : {}),
    ...(name && !/^none\b/i.test(name) ? { name } : {}),
    ...(why ? { why } : {}),
  };
}

/** The follow-up's explanation and its last `REVISED:` verdict, wherever it stands. */
export function parseFollowup(text: string): { why?: string; revised?: 'keep' | 'yes' | 'no' } {
  const all = [...text.matchAll(/REVISED:\s*\**\s*(KEEP|YES|NO)\b/gi)];
  const last = all.at(-1);
  const why = lines(text)
    .filter((l) => !/REVISED:/i.test(l))
    .join(' ')
    .replace(/`/g, '')
    .trim();
  return {
    ...(why ? { why } : {}),
    ...(last ? { revised: last[1]!.toLowerCase() as 'keep' | 'yes' | 'no' } : {}),
  };
}

/**
 * Run each probe as one turn per trigger point: every Warden is asked at once, as the live chorus is,
 * bounded by `concurrency`: through the advice phase on the user's ask (`user-message`), and through
 * the guard phase on the agent's turn (`agent-action`). Probes run one after another, so each turn's
 * wall clock is what a live turn would wait. Every remark is then judged against the user's real
 * next message.
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
      const asked: WardenProbeAnswer[] = new Array(wardens.length);
      // Diagnoses wait for their turn to be recorded, so a stopped turn leaves none behind.
      const diagnosed: WardenDiagnosis[] = [];
      const turnOptions = options.diagnose
        ? { ...options, onDiagnosis: (d: WardenDiagnosis) => diagnosed.push(d) }
        : options;
      let next = 0;
      await Promise.all(
        Array.from(
          { length: Math.max(1, Math.min(options.concurrency ?? 16, wardens.length)) },
          async () => {
            while (next < wardens.length) {
              const index = next++;
              asked[index] = await askWithRetries(turnOptions, probe, wardens[index]!, trigger);
            }
          },
        ),
      );
      turns.push({
        probeId: probe.id,
        trigger,
        calls: wardens.length,
        wallMs: Date.now() - started,
        notAdmitted: asked.filter((a) => a.error === 'not-admitted').length,
      });
      for (const answer of asked) {
        const judged =
          options.judge && !answer.noComment && !answer.error && answer.text
            ? await judge(options.judge, {
                domain: answer.domain,
                domainDescription: wardens
                  .find((w) => w.domain === answer.domain)!
                  .instructions.slice(0, 1200),
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
      for (const d of diagnosed) options.onDiagnosis?.(d);
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
): Promise<WardenProbeAnswer> {
  let answer = await ask(options, probe, warden, trigger);
  const retried: string[] = [];
  for (
    let attempt = 0;
    attempt < (options.retries ?? 2) && answer.error && TRANSPORT_FAILURE.test(answer.error);
    attempt++
  ) {
    retried.push(answer.error);
    await Bun.sleep((options.retryDelayMs ?? 5_000) * (attempt + 1));
    answer = await ask(options, probe, warden, trigger);
  }
  return retried.length ? { ...answer, retried } : answer;
}

async function ask(
  options: CharterEvalOptions,
  probe: WardenProbe,
  warden: EvalWarden,
  trigger: WardenProbeTrigger,
): Promise<WardenProbeAnswer> {
  const cache = new ContextLayer({ id: `eval:${warden.domain}` });
  cache.set(warden.domainKnowledge);
  const instructions = new ContextLayer({ id: `eval:${warden.domain}:instructions` });
  instructions.set(warden.instructions);
  // The provider's usage report for this call: cache reads show whether the primed prefix was warm.
  let tokens: WardenProbeAnswer['tokens'];
  // The real answer's text, as the model gave it: the follow-up quotes it back as its own turn.
  let raw: string | undefined;
  const llm: LLMProvider = Object.assign(Object.create(options.warden) as LLMProvider, {
    complete: async (...args: Parameters<LLMProvider['complete']>) => {
      const result = await options.warden.complete(...args);
      raw = result.content;
      if (result.tokens) {
        const { providerUsage: _usage, ...counts } = result.tokens;
        tokens = counts;
      }
      return result;
    },
  });
  const lib = new DomainLibrarian({
    domain: warden.domain,
    cache,
    instructions,
    signals: new SignalBus(0),
    llm,
    llmOpts: {
      maxTokens: 512,
      temperature: 0,
      ...(warden.session ? { threadId: warden.session } : {}),
    },
    guardTriggers: [PROBE_MOMENT_TOOL],
    ...(warden.budget !== undefined ? { budget: warden.budget } : {}),
    ...(options.charter !== undefined ? { charter: options.charter } : {}),
  });
  const started = Date.now();
  const answer = (
    rest: Omit<WardenProbeAnswer, 'probeId' | 'domain' | 'trigger' | 'elapsedMs'>,
  ) => ({
    probeId: probe.id,
    domain: warden.domain,
    trigger,
    elapsedMs: Date.now() - started,
    ...(tokens ? { tokens } : {}),
    ...rest,
  });
  if (trigger === 'user-message') {
    let request: readonly LLMMessage[] | undefined;
    const advice = await lib.advise(probe.ask ?? '', undefined, {
      ...threadKnowledge(probe, warden),
      observeRequest: (evidence) => {
        request = evidence.messages;
      },
    });
    if (advice.notStarted) return answer({ noComment: false, error: 'not-admitted' });
    if (advice.error || advice.skipped)
      return answer({ noComment: false, error: advice.error ?? advice.skipped! });
    // Advice without a snippet adds nothing a Warden would say to the thread.
    const final =
      advice.noComment || !advice.snippets.length
        ? answer({ noComment: true })
        : answer({ noComment: false, text: advice.snippets.join('\n') });
    if (options.diagnose && request && raw !== undefined)
      options.onDiagnosis?.(
        await diagnoseCell(options.warden, probe, warden, trigger, request, raw, !final.noComment),
      );
    return final;
  }
  const result = await lib.guard(
    oneCall({ tool: PROBE_MOMENT_TOOL, input: { turn: probe.moment } }),
    undefined,
    threadKnowledge(probe, warden),
  );
  if (result.status !== 'completed')
    return answer({
      noComment: false,
      error: result.status === 'not-admitted' ? 'not-admitted' : (result.error ?? result.status),
    });
  if (result.noComment) return answer({ noComment: true });
  const text = result.findings
    .map((f) => [f.description, f.suggestion].filter(Boolean).join(' '))
    .join('\n');
  return answer({ noComment: false, text });
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

/**
 * The three diagnostic readings for one cell, on the Warden's own composed prompt (same system, same
 * primed prefix, so the knowledge is read from the cache): the protocol swapped for one word, for
 * "YES or NO, NAME, WHY", and the live exchange followed by "why?". Failures are recorded, never
 * retried into a guess.
 */
async function diagnoseCell(
  provider: LLMProvider,
  probe: WardenProbe,
  warden: EvalWarden,
  trigger: WardenProbeTrigger,
  request: readonly LLMMessage[],
  raw: string,
  answered: boolean,
): Promise<WardenDiagnosis> {
  const tk = threadKnowledge(probe, warden)?.threadKnowledge;
  const opts = {
    maxTokens: 512,
    temperature: 0,
    ...(warden.session ? { threadId: warden.session } : {}),
    stablePrefix: domainCachePrefix(warden.domain, warden.domainKnowledge),
    threadPrefix: threadSection(tk),
  };
  const messages = request.map((m) => ({ role: m.role, content: m.content }));
  const last = messages.at(-1)!;
  // Diagnosis runs at the user's message only (see `ask`).
  const protocol = adviceResponseProtocol('user-message');
  const call = async (
    msgs: LLMMessage[],
  ): Promise<{ content?: string; tokens?: Tokens; error?: string }> => {
    try {
      const result = await provider.complete(msgs, opts);
      if (!result.tokens) return { content: result.content };
      const { providerUsage: _usage, ...tokens } = result.tokens;
      return { content: result.content, tokens };
    } catch (err) {
      return { error: (err as Error)?.message ?? String(err) };
    }
  };
  /** The live message with only its response protocol replaced. */
  const swapped = (replacement: string) =>
    last.content.endsWith(protocol)
      ? call([
          ...messages.slice(0, -1),
          { ...last, content: `${last.content.slice(0, -protocol.length)}${replacement}` },
        ])
      : Promise.resolve({ error: 'the advice message does not end with its protocol' });
  const read = <T>(
    result: { content?: string; tokens?: Tokens; error?: string },
    parse: (text: string) => T,
  ) =>
    result.error !== undefined
      ? { error: result.error }
      : { ...parse(result.content ?? ''), ...(result.tokens ? { tokens: result.tokens } : {}) };
  const bare = await swapped(DIAGNOSE_BARE_PROTOCOL);
  const oneshot = await swapped(DIAGNOSE_ONESHOT_PROTOCOL);
  const followup = await call([
    ...messages,
    { role: 'assistant', content: raw },
    { role: 'user', content: DIAGNOSE_FOLLOWUP },
  ]);
  return {
    probeId: probe.id,
    domain: warden.domain,
    trigger,
    answered,
    bare: read(bare, parseBare),
    oneshot: read(oneshot, parseOneshot),
    followup: read(followup, parseFollowup),
  };
}
