// The Warden charter eval: run a chorus over real-session probes with one charter wording and score
// how quiet, how right and how in-scope it is. Same code path as live (DomainLibrarian with the
// charter composed above each Warden's instructions), at both trigger points: `user-message` advises
// on the user's ask, `agent-action` guards the agent's turn. No thread, no writes. Scoring and the
// probe contract live in foundry-core (`feedback/warden-probes`), so Oracle scores runs the same way.

import { RUN_ENV, stampRunDirectory } from '@inixiative/archive/exemption';
import {
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
import { DomainLibrarian } from '../agents/domain-librarian';

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
}

/** The tool name a probe's moment arrives under: the agent's finished turn, before the user answers. */
const PROBE_MOMENT_TOOL = 'AgentTurn';

export interface CharterEvalOptions {
  readonly probes: readonly WardenProbe[];
  /** The Wardens that may see a probe (its context's ladder). */
  readonly wardensFor: (probe: WardenProbe) => readonly EvalWarden[];
  /** Haiku on the subscription, as live Wardens run. */
  readonly warden: LLMProvider;
  /** The grader of remarks. */
  readonly judge: LLMProvider;
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
  readonly onAnswer?: (answer: WardenProbeAnswer) => void;
  /** Called once a turn's answers are all judged and passed to `onAnswer`. */
  readonly onTurn?: (turn: WardenProbeTurn) => void;
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
    const wardens = options.wardensFor(probe);
    for (const trigger of probeTriggers(probe).filter(
      (t) => wanted.includes(t) && !options.done?.(probe.id, t),
    )) {
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
          !answer.noComment && !answer.error && answer.text
            ? await judge(options.judge, {
                domain: answer.domain,
                domainDescription: wardens
                  .find((w) => w.domain === answer.domain)!
                  .instructions.slice(0, 1200),
                moment: probe.moment,
                ...(probe.ask ? { ask: probe.ask } : {}),
                trigger,
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

/** A failure of the call itself, not of the Warden's answer. */
const TRANSPORT_FAILURE = /not-admitted|decision (?:failed|rate limited)|timed? ?out|ECONN|exited/i;

async function askWithRetries(
  options: CharterEvalOptions,
  probe: WardenProbe,
  warden: EvalWarden,
  trigger: WardenProbeTrigger,
): Promise<WardenProbeAnswer> {
  let answer = await ask(options, probe, warden, trigger);
  for (
    let attempt = 0;
    attempt < (options.retries ?? 2) && answer.error && TRANSPORT_FAILURE.test(answer.error);
    attempt++
  ) {
    await Bun.sleep((options.retryDelayMs ?? 5_000) * (attempt + 1));
    answer = await ask(options, probe, warden, trigger);
  }
  return answer;
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
  const lib = new DomainLibrarian({
    domain: warden.domain,
    cache,
    instructions,
    signals: new SignalBus(0),
    llm: options.warden,
    llmOpts: { maxTokens: 512, temperature: 0 },
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
    ...rest,
  });
  if (trigger === 'user-message') {
    const advice = await lib.advise(probe.ask ?? '');
    if (advice.notStarted) return answer({ noComment: false, error: 'not-admitted' });
    if (advice.error || advice.skipped)
      return answer({ noComment: false, error: advice.error ?? advice.skipped! });
    // Advice without a snippet adds nothing a Warden would say to the thread.
    if (advice.noComment || !advice.snippets.length) return answer({ noComment: true });
    return answer({ noComment: false, text: advice.snippets.join('\n') });
  }
  const result = await lib.guard({ tool: PROBE_MOMENT_TOOL, input: { turn: probe.moment } });
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
async function judge(provider: LLMProvider, input: Parameters<typeof wardenJudgeMessage>[0]) {
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
