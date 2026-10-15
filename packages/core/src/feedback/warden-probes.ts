// Warden probes: the offline measurement of how well a Warden charter keeps the chorus quiet, in
// scope and right. Data and pure functions only, so Oracle can score runs on a core-only dependency;
// callers bring the probes, the Warden calls and the judge call.
//
// A probe is one moment of a real session. A positive probe is a moment that drew the user's sharp
// correction; a negative probe is one the user let pass. Each trigger point asks about its own part
// of the moment: `user-message` about the user's ask (advise), `agent-action` about the agent's turn
// (guard). A Warden anticipated a correction when it said it first, at either trigger.

/** The trigger points a probe is asked at (live: `user-message` advises, `agent-action` guards). */
export type WardenProbeTrigger = 'user-message' | 'agent-action';

/** One real moment a chorus is asked about. Never commit probes: they hold session text. */
export interface WardenProbe {
  readonly id: string;
  readonly kind: 'positive' | 'negative';
  /** Which context's Wardens may see it (UserEvidence probes only ever see the UserEvidence ladder). */
  readonly ctx: string;
  readonly project?: string;
  /** What the agent just did or said, as the Warden sees it ('' when only the user's ask was recorded). */
  readonly moment: string;
  /** The user's message the agent was answering: what the `user-message` trigger advises on. */
  readonly ask?: string;
  /** When the user answered (ISO), and the period it falls in, so a backtest trains on earlier probes only. */
  readonly at?: string;
  readonly period?: 'train' | 'test';
  /** Positive probes: the Warden domains that own the rule the user enforced next (when known), and its one-line statements. */
  readonly gold?: { readonly domains: readonly string[]; readonly statements: readonly string[] };
  /** The user's actual next message. The judge sees it; Wardens never do. */
  readonly hidden?: string;
}

/** The trigger points that can ask about a probe: those whose input it recorded. */
export function probeTriggers(probe: WardenProbe): WardenProbeTrigger[] {
  return [
    ...(probe.ask?.trim() ? (['user-message'] as const) : []),
    ...(probe.moment.trim() ? (['agent-action'] as const) : []),
  ];
}

/** One Warden's answer on one probe, and the judge's verdict when it spoke. */
export interface WardenProbeAnswer {
  readonly probeId: string;
  readonly domain: string;
  /** The trigger point that asked; `agent-action` when unrecorded. */
  readonly trigger?: WardenProbeTrigger;
  readonly noComment: boolean;
  /** The protocol was broken; counted apart, never as silence or speech. */
  readonly error?: string;
  readonly text?: string;
  readonly elapsedMs?: number;
  readonly judged?: WardenJudgement;
}

/** One probe run as a turn: every Warden asked at once, as the live chorus is. */
export interface WardenProbeTurn {
  readonly probeId: string;
  readonly trigger?: WardenProbeTrigger;
  /** Warden calls made for this probe. */
  readonly calls: number;
  /** Wall clock from the first ask to the last answer. */
  readonly wallMs: number;
  /** Calls the decision queue never admitted. */
  readonly notAdmitted: number;
}

export interface WardenJudgement {
  /** The remark says what the user's next message enforced (the same rule or the same fix). */
  readonly matches: boolean;
  /** The remark stays inside the speaking Warden's domain. */
  readonly inDomain: boolean;
  readonly reason?: string;
}

export interface CharterScore {
  readonly probes: number;
  readonly calls: number;
  readonly errors: number;
  /**
   * Of the Warden answers where nothing of theirs applied (a negative probe, or a positive one owned
   * by another domain, without a remark matched to the real correction), the share that were
   * NO_COMMENT. A protocol error there counts as a failed silence.
   */
  readonly silencePrecision: number | null;
  /** Of the remarks made, the share that matched the user's later real correction. */
  readonly speakPrecision: number | null;
  /** Remarks outside the speaking Warden's domain. */
  readonly scopeViolations: number;
  /** Of positive probes with gold domains, those where an owning Warden named the correction before the user did. */
  readonly recall: number | null;
  /** The primary measure: of all positive probes, those where any Warden, at any trigger, said the correction first. */
  readonly anticipated: number | null;
  /** Remarks the judge did not match to a real correction (on negative probes, or saying something else). */
  readonly wrongRemarks: number;
  /** Wrong remarks per probe asked: how often the chorus speaks when the user would not have. */
  readonly wrongPerProbe: number | null;
  /** The same measures per trigger point, over the probes that trigger could ask about. */
  readonly byTrigger: Partial<
    Record<
      WardenProbeTrigger,
      {
        readonly probes: number;
        readonly positives: number;
        readonly anticipated: number | null;
        readonly remarks: number;
        readonly speakPrecision: number | null;
        readonly wrongRemarks: number;
      }
    >
  >;
  readonly remarks: number;
  readonly silences: number;
  /** Remarks the judge could not grade: counted as unmatched, reported apart. */
  readonly unjudged: number;
  /** Per-turn load at roster scale: calls and wall clock, when the run recorded turns. */
  readonly turns?: {
    readonly count: number;
    readonly callsPerTurn: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly maxMs: number;
    readonly notAdmitted: number;
  };
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

const ratio = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : null);

/**
 * Score one charter run. "Nothing applied" means a negative probe, or a positive probe whose gold
 * domains do not include this Warden; a remark there that the judge matched to the real correction
 * is still a correct remark, not a broken silence.
 */
export function scoreCharterRun(
  probes: readonly WardenProbe[],
  answers: readonly WardenProbeAnswer[],
  turns: readonly WardenProbeTurn[] = [],
): CharterScore {
  const byId = new Map(probes.map((p) => [p.id, p]));
  let calls = 0,
    errors = 0,
    quietCases = 0,
    quietRight = 0,
    remarks = 0,
    remarksRight = 0,
    scope = 0,
    silences = 0,
    unjudged = 0;
  const recalled = new Set<string>();
  const anticipated = new Set<string>();
  const perTrigger = new Map<
    WardenProbeTrigger,
    { probes: Set<string>; anticipated: Set<string>; remarks: number; right: number }
  >();
  for (const a of answers) {
    calls++;
    const probe = byId.get(a.probeId);
    if (!probe) continue;
    const owned = probe.kind === 'positive' && (probe.gold?.domains ?? []).includes(a.domain);
    if (a.error) {
      // A broken answer is neither silence nor a remark; where nothing applied, it is a failed silence.
      errors++;
      perTrigger.get(a.trigger ?? 'agent-action')?.probes.add(probe.id);
      if (!owned) quietCases++;
      continue;
    }
    const trigger = a.trigger ?? 'agent-action';
    const tally = perTrigger.get(trigger) ?? {
      probes: new Set<string>(),
      anticipated: new Set<string>(),
      remarks: 0,
      right: 0,
    };
    perTrigger.set(trigger, tally);
    tally.probes.add(probe.id);
    if (a.noComment) silences++;
    else {
      remarks++;
      tally.remarks++;
      if (!a.judged) unjudged++;
      if (a.judged?.matches) {
        remarksRight++;
        tally.right++;
        if (owned) recalled.add(probe.id);
        if (probe.kind === 'positive') {
          anticipated.add(probe.id);
          tally.anticipated.add(probe.id);
        }
      }
      if (a.judged && !a.judged.inDomain) scope++;
    }
    if (!owned && !(a.judged?.matches ?? false)) {
      quietCases++;
      if (a.noComment) quietRight++;
    }
  }
  const positives = probes.filter((p) => p.kind === 'positive');
  const owners = positives.filter((p) => p.gold?.domains.length).length;
  const asked = new Set(answers.map((a) => a.probeId));
  const byTrigger: CharterScore['byTrigger'] = Object.fromEntries(
    [...perTrigger].map(([trigger, t]) => {
      const reached = probes.filter((p) => t.probes.has(p.id));
      return [
        trigger,
        {
          probes: reached.length,
          positives: reached.filter((p) => p.kind === 'positive').length,
          anticipated: ratio(
            t.anticipated.size,
            reached.filter((p) => p.kind === 'positive').length,
          ),
          remarks: t.remarks,
          speakPrecision: ratio(t.right, t.remarks),
          wrongRemarks: t.remarks - t.right,
        },
      ];
    }),
  );
  return {
    probes: probes.length,
    calls,
    errors,
    silencePrecision: ratio(quietRight, quietCases),
    speakPrecision: ratio(remarksRight, remarks),
    scopeViolations: scope,
    recall: ratio(recalled.size, owners),
    anticipated: ratio(anticipated.size, positives.length),
    wrongRemarks: remarks - remarksRight,
    wrongPerProbe: ratio(remarks - remarksRight, probes.filter((p) => asked.has(p.id)).length),
    byTrigger,
    remarks,
    silences,
    unjudged,
    ...(turns.length
      ? {
          turns: (() => {
            const walls = turns.map((t) => t.wallMs).sort((a, b) => a - b);
            return {
              count: turns.length,
              callsPerTurn:
                Math.round((turns.reduce((n, t) => n + t.calls, 0) / turns.length) * 10) / 10,
              p50Ms: percentile(walls, 50),
              p95Ms: percentile(walls, 95),
              maxMs: walls.at(-1) ?? 0,
              notAdmitted: turns.reduce((n, t) => n + t.notAdmitted, 0),
            };
          })(),
        }
      : {}),
  };
}

/** The judge's instructions: one remark against the user's real next message. */
export const WARDEN_JUDGE_PROMPT = `You grade one remark a narrow expert reviewer (a "Warden") made during an AI coding session.
The Warden spoke either on the user's message, before the agent worked, or on the agent's turn, after it.
You see the Warden's domain, what the Warden saw, the remark, and what the user actually said next.
Answer two questions:
- matches: does the remark say what the user's next message enforced: the same rule, or the same fix? A remark that is merely related, or generic, does not match.
- inDomain: does the remark stay inside the Warden's stated domain?
Respond with JSON only: { "matches": boolean, "inDomain": boolean, "reason": string } where reason is one short sentence.`;

/** The judge's input for one remark: what the Warden saw at its trigger point, and what came next. */
export function wardenJudgeMessage(input: {
  domain: string;
  domainDescription: string;
  /** The agent's turn; '' when the Warden spoke on the user's message only. */
  moment: string;
  /** The user's message the agent was answering, when recorded. */
  ask?: string;
  trigger?: WardenProbeTrigger;
  remark: string;
  hidden: string;
}): string {
  const before = input.trigger === 'user-message';
  return [
    `## Warden domain: ${input.domain}`,
    input.domainDescription,
    ...(input.ask ? ["## The user's message", input.ask] : []),
    ...(input.moment
      ? [
          before ? '## Agent turn (after the remark; the Warden did not see it)' : '## Agent turn',
          input.moment,
        ]
      : []),
    before
      ? "## Remark (made on the user's message, before the agent worked)"
      : '## Remark (made on the agent turn)',
    input.remark,
    "## The user's actual next message",
    input.hidden || '(the user let the turn pass without correcting it)',
  ].join('\n\n');
}

/** Parse a judge answer strictly; undefined when it is not the shape. */
export function parseWardenJudgement(text: string): WardenJudgement | undefined {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?\s*```$/.exec(trimmed);
  try {
    const value = JSON.parse(fenced ? fenced[1]! : trimmed) as Record<string, unknown>;
    if (typeof value.matches !== 'boolean' || typeof value.inDomain !== 'boolean') return undefined;
    return {
      matches: value.matches,
      inDomain: value.inDomain,
      ...(typeof value.reason === 'string' ? { reason: value.reason.slice(0, 300) } : {}),
    };
  } catch {
    return undefined;
  }
}
