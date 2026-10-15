import type { WardenProbe } from './warden-probes';

/** One Warden of the roster as the labeler sees it. */
export interface WardenRosterEntry {
  readonly id: string;
  readonly domain: string;
  readonly prompt: string;
  readonly enabled: boolean;
}

/** Whether a Warden had something of its own to add at the moment, and what it should have known. */
export interface WardenLabel {
  readonly relevant: boolean;
  readonly shouldKnow?: string;
}

export type WardenTriggerKind = 'user-message' | 'agent-action' | 'agent-plan' | 'subagent-spawn';

/**
 * A labelled moment for the Warden prefilter: which Warden domains the trigger touches. Never commit
 * fixtures: they hold session text and company code excerpts.
 */
export interface WardenFixture {
  readonly id: string;
  /** Which context's Wardens may see it (UserEvidence fixtures only ever see the UserEvidence ladder). */
  readonly ctx: string;
  readonly project?: string;
  readonly source: 'git' | 'session' | 'history';
  /** The moment before the mistake, as a Warden would see it. */
  readonly trigger: { readonly kind: WardenTriggerKind; readonly text: string };
  /** The thread or change up to the moment; never what happened next. */
  readonly context: string;
  /** What happened next (the correction, the fix, the review). The labeler sees it; Wardens never do. */
  readonly hidden?: string;
  /** Every Warden of the roster, keyed by agent id. */
  readonly labels: Readonly<Record<string, WardenLabel>>;
  /** The FEEDBACK-LOG rule numbers the moment's mistake repeats, when any. */
  readonly feedbackRules?: readonly number[];
  readonly provenance: Readonly<Record<string, string | number | null>>;
  readonly labeler?: { readonly model: string; readonly run: string; readonly promptHash: string };
}

export type UnlabelledFixture = Omit<WardenFixture, 'labels' | 'labeler' | 'feedbackRules'> & {
  /** Earlier asks or commits in the same thread, for the labeler to summarize into `context`. */
  readonly precedingRaw?: string;
};

export const WARDEN_LABEL_PROMPT = `You label moments from AI coding sessions and code changes for a reviewer-routing experiment.

A roster of Wardens advises a coding agent. Each Warden owns one narrow domain (given below with its charter). At each moment (a user's message to the agent, or an agent's action or plan), a router must decide which Wardens to wake. You produce the ground truth for that router.

For each moment you get: the thread context, the trigger (the moment itself), and WHAT HAPPENED NEXT (the person's correction, a later fix, a review comment, or nothing notable). Use what happened next to understand what was wrong or what was needed, but judge each Warden by the moment: would a competent Warden of that domain, seeing the trigger and context, have had something true, specific and useful to say inside its own domain? That includes the Warden that would have prevented the mistake, and any other Warden whose domain the moment genuinely touches (for example a schema change touches Schema even when the correction was about reuse). It does NOT include a Warden that could only say something generic, or whose domain the moment merely mentions in passing.

Most Wardens are irrelevant to most moments. A moment where nothing went wrong can still be relevant to a Warden (a plan heading to merge without the full check touches Ship), but plain chatter, a status question, or an answer to the agent's question usually touches none.

For each relevant Warden, write shouldKnow: the specific thing it should have known or said, at most 200 characters, naming the existing primitive, file, symbol, rule or check when there is one (e.g. "Use the existing debounce wrapper in packages/shared/debounce.ts instead of a new timer"). Never quote secrets.

Also write context: 1-3 sentences summarizing the thread or change UP TO the moment (what is being worked on, where), without revealing what happened next. And feedbackRules: the numbers of the recurring rules (list given) that the moment's mistake repeats, or [].

Respond with JSON only:
{ "results": { "<fixture id>": { "context": string, "relevant": { "<domain>": "<shouldKnow>" }, "feedbackRules": number[] } } }
List only relevant domains under "relevant" (an empty object when none). Use the domain names exactly as given.`;

/** The stable start of every label input: the roster and the rule list, so primed sessions reuse it. */
export function wardenLabelPrefix(
  roster: readonly WardenRosterEntry[],
  rules: readonly { n: number; rule: string; count: string }[],
): string {
  const wardens = roster.map((w) => `- ${w.domain}: ${w.prompt.replace(/\s+/g, ' ')}`).join('\n');
  const recurring = rules.map((r) => `${r.n}. ${r.rule} (said ${r.count}×)`).join('\n');
  return `## Wardens\n${wardens}\n\n## Recurring rules (FEEDBACK-LOG)\n${recurring}\n\nLabel each moment below.\n\n`;
}

export function wardenLabelMessages(
  prefix: string,
  fixtures: readonly UnlabelledFixture[],
  limits: { trigger?: number; context?: number; hidden?: number } = {},
): { role: 'system' | 'user'; content: string }[] {
  const body = fixtures
    .map(
      (f) =>
        `## ${f.id} (${f.ctx}${f.project ? `/${f.project}` : ''}, ${f.source}, trigger: ${f.trigger.kind})\n### Context\n${
          [f.context, f.precedingRaw]
            .filter(Boolean)
            .join('\n')
            .slice(-(limits.context ?? 1500)) || '(none)'
        }\n\n### Trigger\n${f.trigger.text.slice(-(limits.trigger ?? 3000))}\n\n### What happened next\n${f.hidden?.slice(0, limits.hidden ?? 1500) || '(nothing notable)'}`,
    )
    .join('\n\n');
  return [
    { role: 'system', content: WARDEN_LABEL_PROMPT },
    { role: 'user', content: `${prefix}${body}` },
  ];
}

export interface ParsedWardenLabels {
  readonly context: string;
  readonly labels: Record<string, WardenLabel>;
  readonly feedbackRules: number[];
}

/** One answer per fixture id; undefined where the answer is missing or malformed. Unknown domains are dropped. */
export function parseWardenLabels(
  content: string,
  roster: readonly WardenRosterEntry[],
  ids: readonly string[],
): (ParsedWardenLabels | undefined)[] {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  let raw: unknown;
  try {
    raw = JSON.parse(content.slice(start, end + 1));
  } catch {
    return ids.map(() => undefined);
  }
  const results = (raw as { results?: Record<string, unknown> } | null)?.results ?? {};
  const byDomain = new Map(roster.map((w) => [w.domain, w.id]));
  return ids.map((id) => {
    const item = results[id] as
      | { context?: unknown; relevant?: unknown; feedbackRules?: unknown }
      | undefined;
    if (!item || typeof item.relevant !== 'object' || item.relevant === null) return undefined;
    const relevant = item.relevant as Record<string, unknown>;
    const labels: Record<string, WardenLabel> = {};
    for (const w of roster) labels[w.id] = { relevant: false };
    for (const [domain, know] of Object.entries(relevant)) {
      const wardenId = byDomain.get(domain);
      if (!wardenId) continue;
      labels[wardenId] = {
        relevant: true,
        ...(typeof know === 'string' && know.trim()
          ? { shouldKnow: know.trim().slice(0, 300) }
          : {}),
      };
    }
    return {
      context: typeof item.context === 'string' ? item.context.trim() : '',
      labels,
      feedbackRules: Array.isArray(item.feedbackRules)
        ? item.feedbackRules.filter((n): n is number => Number.isInteger(n))
        : [],
    };
  });
}

export interface DomainAgreement {
  readonly wardenId: string;
  /** Fixtures both sides labelled. */
  readonly n: number;
  readonly agree: number;
  readonly positivesA: number;
  readonly positivesB: number;
  readonly bothPositive: number;
  /** Cohen's kappa; null when chance agreement is total (one class on both sides). */
  readonly kappa: number | null;
}

/** Per-Warden agreement between two labelings of the same fixtures, plus the pooled figures. */
export function labelAgreement(
  a: ReadonlyMap<string, Readonly<Record<string, WardenLabel>>>,
  b: ReadonlyMap<string, Readonly<Record<string, WardenLabel>>>,
  wardenIds: readonly string[],
): {
  perWarden: DomainAgreement[];
  pooled: DomainAgreement;
  exactFixtures: number;
  fixtures: number;
} {
  const shared = [...a.keys()].filter((id) => b.has(id));
  const tally = (wardenId: string, ids: readonly string[], wardens: readonly string[]) => {
    let n = 0;
    let agree = 0;
    let positivesA = 0;
    let positivesB = 0;
    let bothPositive = 0;
    for (const id of ids)
      for (const w of wardens) {
        const x = a.get(id)?.[w]?.relevant ?? false;
        const y = b.get(id)?.[w]?.relevant ?? false;
        n++;
        if (x === y) agree++;
        if (x) positivesA++;
        if (y) positivesB++;
        if (x && y) bothPositive++;
      }
    const observed = n ? agree / n : 0;
    const chance = n
      ? (positivesA / n) * (positivesB / n) + (1 - positivesA / n) * (1 - positivesB / n)
      : 1;
    const kappa =
      chance >= 1 ? null : Math.round(((observed - chance) / (1 - chance)) * 1000) / 1000;
    return { wardenId, n, agree, positivesA, positivesB, bothPositive, kappa };
  };
  const exactFixtures = shared.filter((id) =>
    wardenIds.every(
      (w) => (a.get(id)?.[w]?.relevant ?? false) === (b.get(id)?.[w]?.relevant ?? false),
    ),
  ).length;
  return {
    perWarden: wardenIds.map((w) => tally(w, shared, [w])),
    pooled: tally('*', shared, wardenIds),
    exactFixtures,
    fixtures: shared.length,
  };
}

/** The charter eval's probe shape, so `warden-charter.ts` runs on fixtures too. */
export function fixtureProbe(
  fixture: WardenFixture,
  domainOf: (wardenId: string) => string,
): WardenProbe {
  const relevant = Object.entries(fixture.labels).filter(([, l]) => l.relevant);
  return {
    id: fixture.id,
    kind: relevant.length ? 'positive' : 'negative',
    ctx: fixture.ctx,
    ...(fixture.project ? { project: fixture.project } : {}),
    // A user-message fixture is asked at the user-message trigger; the others are the agent's turn.
    ...(fixture.trigger.kind === 'user-message'
      ? { moment: '', ask: fixture.trigger.text }
      : { moment: fixture.trigger.text }),
    ...(relevant.length
      ? {
          gold: {
            domains: relevant.map(([id]) => domainOf(id)),
            statements: relevant.map(([, l]) => l.shouldKnow).filter((s): s is string => !!s),
          },
        }
      : {}),
    ...(fixture.hidden ? { hidden: fixture.hidden } : {}),
  };
}
