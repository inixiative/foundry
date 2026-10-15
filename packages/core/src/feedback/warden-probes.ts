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
  readonly gold?: {
    readonly domains: readonly string[];
    readonly statements: readonly string[];
    /** What the user pushed the agent toward: the existing rule, primitive, system or pattern. */
    readonly target?: CorrectionTarget;
  };
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

/** What a correction pushed the agent toward. Absent when it pushed toward nothing that already existed. */
export interface CorrectionTarget {
  /** The thing itself, named as the codebase names it (e.g. "Inquiry handler autoApprove"). */
  readonly name: string;
  readonly kind: 'primitive' | 'system' | 'pattern' | 'rule';
  /** The concept cluster it belongs to (kebab-case, e.g. "concurrency-locking"): the routing label. */
  readonly concept: string;
  /** Where it lives, when the moment says (file, package, doc). */
  readonly where?: string;
  /** The canonical name shared by every correction that pushed toward the same thing. */
  readonly canonical?: string;
}

/** Concept clusters the labeler starts from; it may add one when none fits. */
export const CONCEPT_CLUSTERS = [
  'concurrency-locking',
  'requests-inquiry',
  'access-signets-permissions',
  'audit-log',
  'errors-responses',
  'data-schema-db',
  'queries-db-client',
  'jobs-queues-cron',
  'caching',
  'http-routes-api',
  'validation-types',
  'testing-fixtures-vcr',
  'frontend-ui',
  'email-communications',
  'config-env-setup',
  'tooling-ci-lint',
  'naming',
  'docs-conventions',
  'shared-helpers-utils',
  'process-merge-ship',
  'process-communication',
] as const;

export const CORRECTION_TARGET_PROMPT = `You label corrections a developer gave an AI coding agent. Each item shows the developer's request, the agent's turn when recorded, and the developer's correction.

Most corrections push the agent toward something that ALREADY EXISTS: a primitive (a helper, wrapper, class, module, package export), a system (an existing subsystem or flow, e.g. the inquiry system, the audit log), a pattern (an established way the codebase does a thing), or a rule (a standing convention or process rule, e.g. "merge yourself once green", "no backwards compatibility"). Name that target.

For each item:
- target: null when the correction pushes toward nothing that already existed (a new requirement, a bug report, a fact about the world, a scope change). Otherwise an object:
  - name: the thing itself, as the codebase would name it, at most 80 characters (e.g. "Inquiry handler autoApprove", "shared VCR utilities", "SELECT FOR UPDATE lock helper", "audit log records the actor"). Name the thing, not the advice.
  - kind: "primitive" | "system" | "pattern" | "rule"
  - concept: the concept cluster it belongs to; use one of the given clusters when one fits, else a new short kebab-case cluster.
  - where: the file, package or doc it lives in, only when the item says so; else omit.

Respond with JSON only: { "results": { "<id>": { "target": null | { "name": string, "kind": string, "concept": string, "where"?: string } } } }`;

/** The labeler's input for a batch of positive probes. */
export function correctionTargetMessages(
  probes: readonly Pick<WardenProbe, 'id' | 'ask' | 'moment' | 'hidden'>[],
): { role: 'system' | 'user'; content: string }[] {
  const body = probes
    .map(
      (p) =>
        `## ${p.id}\n### Request\n${p.ask?.slice(0, 1500) || '(not recorded)'}\n\n### Agent turn\n${p.moment.slice(-1500) || '(not recorded)'}\n\n### Correction\n${(p.hidden ?? '').slice(0, 1500)}`,
    )
    .join('\n\n');
  return [
    { role: 'system', content: CORRECTION_TARGET_PROMPT },
    {
      role: 'user',
      content: `Concept clusters: ${CONCEPT_CLUSTERS.join(', ')}\n\nLabel each item below.\n\n${body}`,
    },
  ];
}

const TARGET_KINDS = new Set(['primitive', 'system', 'pattern', 'rule']);

/** One answer per id: a target, null for no existing target, undefined when missing or malformed. */
export function parseCorrectionTargets(
  content: string,
  ids: readonly string[],
): (CorrectionTarget | null | undefined)[] {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  let results: Record<string, { target?: unknown }> = {};
  try {
    results =
      (JSON.parse(content.slice(start, end + 1)) as { results?: typeof results }).results ?? {};
  } catch {
    return ids.map(() => undefined);
  }
  return ids.map((id) => {
    const item = results[id];
    if (!item || !('target' in item)) return undefined;
    if (item.target === null) return null;
    const t = item.target as Record<string, unknown>;
    if (typeof t.name !== 'string' || !t.name.trim() || typeof t.concept !== 'string')
      return undefined;
    return {
      name: t.name.trim().slice(0, 120),
      kind: (TARGET_KINDS.has(String(t.kind)) ? t.kind : 'pattern') as CorrectionTarget['kind'],
      concept: t.concept
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, ''),
      ...(typeof t.where === 'string' && t.where.trim()
        ? { where: t.where.trim().slice(0, 160) }
        : {}),
    };
  });
}

export const TARGET_CANONICAL_PROMPT = `You merge names of existing codebase things (primitives, systems, patterns, rules) that developers' corrections pointed to. All names given share one concept cluster. Names that refer to the same thing get the same canonical name; different things stay apart (when unsure, keep them apart). A canonical name is the clearest of the merged names, at most 80 characters.
Respond with JSON only: { "canonical": { "<N1>": "<canonical name>", ... } } with every given key.`;

/** The canonicalization input: one concept cluster's distinct target names, keyed N1..Nn. */
export function targetCanonicalMessages(
  concept: string,
  names: readonly string[],
): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: TARGET_CANONICAL_PROMPT },
    {
      role: 'user',
      content: `Cluster: ${concept}\n\n${names.map((n, i) => `N${i + 1}: ${n}`).join('\n')}`,
    },
  ];
}

/** Canonical names in order; a missing key keeps the name as given. */
export function parseTargetCanonical(content: string, names: readonly string[]): string[] {
  try {
    const parsed = JSON.parse(
      content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1),
    ) as {
      canonical?: Record<string, unknown>;
    };
    return names.map((name, i) => {
      const value = parsed.canonical?.[`N${i + 1}`];
      return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : name;
    });
  } catch {
    return [...names];
  }
}

/** The judge's instructions: one remark against the user's real next message. */
export const WARDEN_JUDGE_PROMPT = `You grade one remark a narrow expert reviewer (a "Warden") made during an AI coding session.
The Warden spoke either on the user's message, before the agent worked, or on the agent's turn, after it.
You see the Warden's domain, what the Warden saw, the remark, and what the user actually said next.
When a TARGET is given (the existing rule, primitive, system or pattern the user pushed the agent toward), the test is the target, not wording: the remark matches when it names that same target (or points the agent to it unmistakably), however differently it is phrased.
Answer two questions:
- matches: with a target, does the remark name the same target? Without one, does the remark say what the user's next message enforced: the same rule, or the same fix? A remark that is merely related, or generic, does not match.
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
  /** What the user pushed toward, when labelled. */
  target?: CorrectionTarget;
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
    ...(input.target
      ? [
          '## TARGET (what the user pushed the agent toward)',
          `${input.target.canonical ?? input.target.name} (${input.target.kind}, ${input.target.concept}${input.target.where ? `, ${input.target.where}` : ''})`,
        ]
      : []),
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
