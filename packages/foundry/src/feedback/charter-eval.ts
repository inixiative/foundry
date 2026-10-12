// The Warden charter eval: run a chorus over real-session probes with one charter wording and score
// how quiet, how right and how in-scope it is. Same code path as live (DomainLibrarian with the
// charter composed above each Warden's instructions); no thread, no writes. Scoring and the probe
// contract live in foundry-core (`feedback/warden-probes`), so Oracle scores runs the same way.

import { RUN_ENV, stampRunDirectory } from '@inixiative/archive/exemption';
import {
  ContextLayer,
  type LLMProvider,
  parseWardenJudgement,
  SignalBus,
  WARDEN_JUDGE_PROMPT,
  type WardenProbe,
  type WardenProbeAnswer,
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
  readonly onAnswer?: (answer: WardenProbeAnswer) => void;
}

/**
 * Run each probe as one turn: every Warden is asked about its moment at once through the guard phase
 * (the agent just acted), as the live chorus is, bounded by `concurrency`. Probes run one after
 * another, so each turn's wall clock is what a live turn would wait. Every remark is then judged
 * against the user's real next message.
 */
export async function runCharterEval(
  options: CharterEvalOptions,
): Promise<{ answers: WardenProbeAnswer[]; turns: WardenProbeTurn[] }> {
  const answers: WardenProbeAnswer[] = [];
  const turns: WardenProbeTurn[] = [];
  for (const probe of options.probes) {
    const wardens = options.wardensFor(probe);
    const started = Date.now();
    const asked: WardenProbeAnswer[] = new Array(wardens.length);
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.max(1, Math.min(options.concurrency ?? 16, wardens.length)) },
        async () => {
          while (next < wardens.length) {
            const index = next++;
            asked[index] = await ask(options, probe, wardens[index]!);
          }
        },
      ),
    );
    turns.push({
      probeId: probe.id,
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
              remark: answer.text,
              hidden: probe.hidden ?? '',
            })
          : undefined;
      const final = judged ? { ...answer, judged } : answer;
      answers.push(final);
      options.onAnswer?.(final);
    }
  }
  return { answers, turns };
}

async function ask(
  options: CharterEvalOptions,
  probe: WardenProbe,
  warden: EvalWarden,
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
    ...(options.charter !== undefined ? { charter: options.charter } : {}),
  });
  const started = Date.now();
  const result = await lib.guard({ tool: PROBE_MOMENT_TOOL, input: { turn: probe.moment } });
  const elapsedMs = Date.now() - started;
  const base = { probeId: probe.id, domain: warden.domain, elapsedMs };
  if (result.status !== 'completed')
    return {
      ...base,
      noComment: false,
      error: result.status === 'not-admitted' ? 'not-admitted' : (result.error ?? result.status),
    };
  if (result.noComment) return { ...base, noComment: true };
  const text = result.findings
    .map((f) => [f.description, f.suggestion].filter(Boolean).join(' '))
    .join('\n');
  return { ...base, noComment: false, text };
}

async function judge(provider: LLMProvider, input: Parameters<typeof wardenJudgeMessage>[0]) {
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
    return undefined;
  }
}
