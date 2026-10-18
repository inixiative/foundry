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
  adviceResponseProtocol,
  DomainLibrarian,
  domainCachePrefix,
  oneCall,
  threadSection,
} from '../agents/domain-librarian';

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
   * same composed prompt, twice more: once with the protocol replaced by "YES or NO, then why"
   * (does asking for a reason change the decision?), and once as a follow-up to its real answer
   * (why did it answer that, and does it stand by it?). Live Wardens never do this.
   */
  readonly diagnose?: boolean;
  readonly onDiagnosis?: (diagnosis: WardenDiagnosis) => void;
}

/** One cell's diagnostic: the real answer, the one-shot "yes/no + why", and the follow-up "why?". */
export interface WardenDiagnosis {
  readonly probeId: string;
  readonly domain: string;
  readonly trigger: WardenProbeTrigger;
  /** The real answer: true when the Warden pointed, false on NO_COMMENT. */
  readonly answered: boolean;
  readonly oneshot: {
    readonly decision?: 'yes' | 'no';
    readonly why?: string;
    readonly error?: string;
    readonly tokens?: WardenProbeAnswer['tokens'];
  };
  readonly followup: {
    readonly why?: string;
    /** `keep`, or the answer the Warden now says is right. */
    readonly revised?: 'keep' | 'yes' | 'no';
    readonly error?: string;
    readonly tokens?: WardenProbeAnswer['tokens'];
  };
}

export const DIAGNOSE_ONESHOT_PROTOCOL = `This is a diagnostic run, not a live turn. Answer in exactly this shape and nothing else:
Line 1: YES or NO. YES means you would point at something in your domain for this message; NO means you would answer ${'NO_COMMENT'}.
Line 2: WHY: one or two sentences: what the message asks for, and which part of your domain it does or does not touch.`;

export const DIAGNOSE_FOLLOWUP = `This is a diagnostic question, not a live turn; your answer above stands as given. In at most two short lines, explain it:
1. What the message asks for, in your words.
2. Which part of your domain it does or does not touch, and why.
Then one last line, exactly \`REVISED: KEEP\` if you stand by your answer, or \`REVISED: YES\` / \`REVISED: NO\` if on reflection the other answer is right.`;

/** Line 1 of a one-shot answer: YES or NO (markdown and punctuation tolerated); anything else is unparsed. */
export function parseOneshot(text: string): { decision?: 'yes' | 'no'; why?: string } {
  const lines = text
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const first = lines[0]
    ?.replace(/[*_`#:.]/g, '')
    .trim()
    .toUpperCase();
  const decision = first === 'YES' ? 'yes' : first === 'NO' ? 'no' : undefined;
  const why = lines
    .slice(decision ? 1 : 0)
    .join(' ')
    .replace(/^\**WHY\**:?\s*/i, '')
    .trim();
  return { ...(decision ? { decision } : {}), ...(why ? { why } : {}) };
}

/** The follow-up's explanation and its last `REVISED:` line. */
export function parseFollowup(text: string): { why?: string; revised?: 'keep' | 'yes' | 'no' } {
  const lines = text
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const last = /REVISED:\s*(KEEP|YES|NO)\b/i.exec(lines.at(-1) ?? '');
  const why = (last ? lines.slice(0, -1) : lines).join(' ').replace(/`/g, '').trim();
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
      let next = 0;
      await Promise.all(
        Array.from(
          { length: Math.max(1, Math.min(options.concurrency ?? 16, wardens.length)) },
          async () => {
            while (next < wardens.length) {
              const index = next++;
              asked[index] = await askWithRetries(options, probe, wardens[index]!, trigger);
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
 * The two diagnostic calls for one cell, on the Warden's own composed prompt (same system, same
 * primed prefix, so the knowledge is read from the cache): the protocol swapped for "YES or NO, then
 * why", and the real exchange followed by "why?". Failures are recorded, never retried into a guess.
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
  const call = async (msgs: LLMMessage[]) => {
    try {
      const result = await provider.complete(msgs, opts);
      if (!result.tokens) return { content: result.content };
      const { providerUsage: _usage, ...tokens } = result.tokens;
      return { content: result.content, tokens };
    } catch (err) {
      return { error: (err as Error)?.message ?? String(err) };
    }
  };
  const oneshotCall = last.content.endsWith(protocol)
    ? await call([
        ...messages.slice(0, -1),
        {
          ...last,
          content: `${last.content.slice(0, -protocol.length)}${DIAGNOSE_ONESHOT_PROTOCOL}`,
        },
      ])
    : { error: 'the advice message does not end with its protocol' };
  const followupCall = await call([
    ...messages,
    { role: 'assistant', content: raw },
    { role: 'user', content: DIAGNOSE_FOLLOWUP },
  ]);
  return {
    probeId: probe.id,
    domain: warden.domain,
    trigger,
    answered,
    oneshot:
      'error' in oneshotCall
        ? { error: oneshotCall.error! }
        : {
            ...parseOneshot(oneshotCall.content),
            ...(oneshotCall.tokens ? { tokens: oneshotCall.tokens } : {}),
          },
    followup:
      'error' in followupCall
        ? { error: followupCall.error! }
        : {
            ...parseFollowup(followupCall.content),
            ...(followupCall.tokens ? { tokens: followupCall.tokens } : {}),
          },
  };
}
