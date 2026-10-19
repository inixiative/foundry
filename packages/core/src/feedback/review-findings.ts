/**
 * @atlas
 * @kind service
 * @partOf feature:feedback
 */
import {
  type Authorship,
  CONCEPT_CLUSTERS,
  type CorrectionTarget,
  MISS_KINDS,
  type MissKind,
} from './warden-probes';

// The Prospector's reading of written review: PR reviews and ticket comments where the person said the
// work should have used, extended or ported something that already existed. Data and pure functions
// only: callers fetch the text and make the model call.

/** One piece of written review, with what it was about. */
export interface ReviewMoment {
  readonly id: string;
  /** Where it was written, e.g. `PR #2116 (CHANGES_REQUESTED review, inline)` or `ZLT-4321 comment`. */
  readonly where: string;
  /** What the work was: PR title and description, or the issue's title and description. */
  readonly work: string;
  /** The code it was written on, when inline (path, line, diff hunk). */
  readonly code?: string;
  /** The message it replies to, when it is a reply. */
  readonly replyTo?: string;
  readonly text: string;
  /** `directive`: a description the person wrote of work still to do (a ticket, a project), not a review of done work. */
  readonly mode?: 'review' | 'directive';
}

export type FindingScope = 'architectural' | 'code';

/** How much a finding counts in scoring: generic code-correctness findings are lightly down-weighted (Aron, 2026-10-15). */
export const SCOPE_WEIGHT: Readonly<Record<FindingScope, number>> = {
  architectural: 1,
  code: 0.75,
};

/** One place the reviewer pushed toward something that already existed. */
export interface ReviewFinding {
  readonly target: CorrectionTarget;
  /** The reviewer's own words that say it, verbatim, at most 300 characters. */
  readonly excerpt: string;
  /** `architectural`: about which system, primitive or boundary to build on; `code`: a generic code-correctness fix. */
  readonly scope?: FindingScope;
}

export interface ReviewReading {
  readonly findings: readonly ReviewFinding[];
  /** The model's read of the voice: typed by a person, or written by an AI agent. A weak signal. */
  readonly voice?: 'human' | 'agent';
}

/**
 * Words a reuse finding almost always carries. A change-request review is read whole; everything else
 * is read only when it matches (the method of Zealot's core-primitives findings, ZLT-5638).
 */
export const REUSE_HINT =
  /\b(?:already (?:exists?|have|has|does|handles?|in|imported|installed|there)|existing|exists|re-?use|reimplement\w*|re-implement\w*|hand-?roll\w*|hand-?written|duplicat\w*|copy|copies|copied|parallel|second (?:copy|version|implementation)|third (?:copy|type system)|instead of|port(?:ed|ing)? (?:from|it|this|the)|from (?:the )?template|template'?s|primitive|extend(?:ing)? (?:the|it)|use (?:the |our )?[`\w]|we have|there'?s (?:a|an|already)|same (?:shape|thing|as)|like \w+ does|convention|pattern|wrapper|shared|generic|lodash|helper|util|registry|consolidate|fold (?:into|it)|one place|single source)\b/i;

export const REVIEW_FINDINGS_PROMPT = `You read code review written by one reviewer, Aron, on pull requests and tickets. For each item, find every place where he says the work should have USED, EXTENDED or PORTED something that ALREADY EXISTS instead of what was built: a primitive (helper, wrapper, hook, component, class, module, package export, library already installed), a system (an existing subsystem or flow), a pattern (an established way the codebase does a thing, e.g. a route template or a module convention), or a rule (a standing convention or ruling, e.g. "no select on internal reads").

A finding needs both: the existing thing, and what was done instead. Not findings: bug reports, missing tests, style nits, new requirements, questions, praise, status updates, an author's replies about what they fixed, and anything that points at something not yet built.

For each finding:
- name: the existing thing as the codebase names it, at most 80 characters (e.g. "paginate() + filterLens", "Skeleton component", "lodash omit", "PolymorphismRegistry"). Name the thing, not the advice.
- kind: "primitive" | "system" | "pattern" | "rule"
- concept: its concept cluster; use one of the given clusters when one fits, else a new short kebab-case cluster.
- where: the file, package or doc it lives in, only when the item says so.
- builtInstead: what the work did instead, one line, at most 160 characters. For a directive item, what the work would otherwise have built, or "" when the item doesn't say.
- miss: why it was missed, judged from the item: "unaware" (didn't know it existed), "misfit" (knew it, worked around a gap instead of extending it), "wrapper" (wrapped it under a new name), "unclear".
- excerpt: Aron's words that say it, verbatim, at most 300 characters.
- scope: "architectural" when it is about which system, primitive, module boundary or pattern to build on; "code" when it is a generic code-correctness fix (a library call, a small helper, an idiom).

Items marked "Mode: directive" are descriptions Aron wrote of work still to be done (a ticket, a project). There a finding is a place where he directs the work to use, extend or port something that already exists, by name.

Also judge the voice of each item: "human" when it reads as typed by a person (terse, informal, lowercase, typos, first-person asides), "agent" when it reads as written by an AI coding agent (headed sections, bold labels, numbered findings, dense backticked citations, "Fixed in <sha>" replies, polished em-dash prose).

Respond with JSON only: { "results": { "<id>": { "voice": "human" | "agent", "findings": [ { "name": string, "kind": string, "concept": string, "where"?: string, "builtInstead": string, "miss": string, "excerpt": string, "scope": "architectural" | "code" } ] } } } with "findings": [] when there are none.`;

/** The reader's input for a batch of review moments. */
export function reviewFindingMessages(
  moments: readonly ReviewMoment[],
): { role: 'system' | 'user'; content: string }[] {
  const body = moments
    .map((m) =>
      [
        `## ${m.id}`,
        `Where: ${m.where}`,
        ...(m.mode === 'directive' ? ['Mode: directive'] : []),
        `### The work\n${m.work.slice(0, 1200)}`,
        ...(m.code ? [`### Code it was written on\n${m.code.slice(-1500)}`] : []),
        ...(m.replyTo ? [`### Replying to\n${m.replyTo.slice(0, 800)}`] : []),
        `### Aron wrote\n${m.text.slice(0, 4000)}`,
      ].join('\n'),
    )
    .join('\n\n');
  return [
    { role: 'system', content: REVIEW_FINDINGS_PROMPT },
    {
      role: 'user',
      content: `Concept clusters: ${CONCEPT_CLUSTERS.join(', ')}\n\nRead each item below.\n\n${body}`,
    },
  ];
}

const KINDS = new Set(['primitive', 'system', 'pattern', 'rule']);
const kebab = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** One reading per id; undefined when missing or malformed (the caller retries it alone). */
export function parseReviewFindings(
  content: string,
  ids: readonly string[],
): (ReviewReading | undefined)[] {
  let results: Record<string, { voice?: unknown; findings?: unknown }> = {};
  try {
    results =
      (
        JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)) as {
          results?: typeof results;
        }
      ).results ?? {};
  } catch {
    return ids.map(() => undefined);
  }
  return ids.map((id) => {
    const item = results[id];
    if (!item || !Array.isArray(item.findings)) return undefined;
    const findings: ReviewFinding[] = [];
    for (const raw of item.findings as Record<string, unknown>[]) {
      if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) continue;
      if (typeof raw.concept !== 'string' || !kebab(raw.concept)) continue;
      const miss = MISS_KINDS.includes(raw.miss as MissKind) ? (raw.miss as MissKind) : 'unclear';
      findings.push({
        target: {
          name: raw.name.trim().slice(0, 120),
          kind: (KINDS.has(String(raw.kind)) ? raw.kind : 'pattern') as CorrectionTarget['kind'],
          concept: kebab(raw.concept),
          ...(typeof raw.where === 'string' && raw.where.trim()
            ? { where: raw.where.trim().slice(0, 160) }
            : {}),
          ...(typeof raw.builtInstead === 'string' && raw.builtInstead.trim()
            ? { builtInstead: raw.builtInstead.trim().slice(0, 240) }
            : {}),
          miss,
        },
        excerpt: typeof raw.excerpt === 'string' ? raw.excerpt.trim().slice(0, 300) : '',
        ...(raw.scope === 'architectural' || raw.scope === 'code' ? { scope: raw.scope } : {}),
      });
    }
    return {
      findings,
      ...(item.voice === 'human' || item.voice === 'agent' ? { voice: item.voice } : {}),
    };
  });
}

/** Markers an agent leaves in what it posts, and the trace of text typed into a web form. */
export const AUTHORSHIP_MARKERS = {
  /** An agent's signature line. */
  footer:
    /(?:generated (?:by|with) \[?claude|🤖 generated|co-authored-by: claude|^_?generated by .{0,40}_?$)/im,
  /** Claude Code's terminal glyphs: an agent's output pasted in by hand. */
  pasted: /(?:^|\n)\s*[⏺⎿]/,
  /** CRLF line endings: typed (or edited) in the GitHub web UI; gh and the API post LF. */
  webForm: /\r\n/,
} as const;

/** What the person's own sessions say about a comment: an agent posted it, or the person typed it. */
export interface SessionEvidence {
  readonly posted?: boolean;
  /** The text appears in another tool call: a body file an agent drafted, or a quote. Weak. */
  readonly drafted?: boolean;
  readonly typed?: boolean;
}

/**
 * Who wrote a comment posted under the person's account. Strong evidence decides; a model's read of
 * the voice is the weak fallback, then plain style. A typed prompt outranks an agent posting it: the
 * person dictated the words.
 */
export function authorshipOf(
  text: string,
  evidence: SessionEvidence = {},
  voice?: 'human' | 'agent',
): Authorship {
  const signals: string[] = [];
  if (evidence.typed) signals.push('session:typed');
  if (evidence.posted) signals.push('session:posted');
  if (evidence.drafted) signals.push('session:drafted');
  if (AUTHORSHIP_MARKERS.footer.test(text)) signals.push('marker:footer');
  if (AUTHORSHIP_MARKERS.pasted.test(text)) signals.push('marker:pasted');
  if (AUTHORSHIP_MARKERS.webForm.test(text)) signals.push('marker:web-form');
  const style = styleOf(text);
  signals.push(`style:${style}`);
  if (voice) signals.push(`voice:${voice}`);
  if (evidence.typed) return { by: 'human', confidence: 'strong', signals };
  if (evidence.posted || signals.includes('marker:footer') || signals.includes('marker:pasted'))
    return { by: 'agent', confidence: 'strong', signals };
  if (signals.includes('marker:web-form')) return { by: 'human', confidence: 'strong', signals };
  // A draft can also be an agent quoting the person's comment back, so it only outweighs style.
  return { by: evidence.drafted ? 'agent' : (voice ?? style), confidence: 'weak', signals };
}

/** Plain style: an agent's headings, bold labels, numbered findings and dense citations. */
export function styleOf(text: string): 'human' | 'agent' {
  let agent = 0;
  if (/^#{1,4} /m.test(text)) agent += 2;
  if (/\*\*[^*\n]{2,60}\*\*/.test(text)) agent++;
  if (/^\s*\d+\. \*\*/m.test(text)) agent += 2;
  if ((text.match(/`[^`\n]+`/g) ?? []).length >= 4) agent++;
  if ((text.match(/—/g) ?? []).length >= 2) agent++;
  if (/^(?:Fixed in|Addressed in|Done in) [0-9a-f]{7}/im.test(text)) agent += 2;
  if (text.length > 900) agent++;
  let human = 0;
  if (/^[a-z]/.test(text.trim())) human += 2;
  if (!/[.!?:`)]\s*$/.test(text.trim())) human++;
  if (/\b(?:im|dont|cant|doesnt|isnt|wont|u|ur|pls|thx|lol|imo|tbh)\b/.test(text)) human += 2;
  if (text.length < 200) human++;
  return agent > human ? 'agent' : 'human';
}

/**
 * A distinctive run of a comment that survives JSON and shell quoting unchanged, to find the session
 * that posted it. Undefined when the text has no such run.
 */
export function evidenceSnippet(text: string, length = 48): string | undefined {
  let best = '';
  for (const run of text.split(/[^A-Za-z0-9 ,.;:()/_=+-]+/))
    if (run.trim().length > best.length) best = run.trim();
  if (best.length < Math.min(length, 32)) return undefined;
  const start = Math.max(0, Math.floor((best.length - length) / 2));
  return best.slice(start, start + length).trim();
}
