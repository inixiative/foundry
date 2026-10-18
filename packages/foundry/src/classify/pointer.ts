// The pointer a Warden's remarks make under the point charter: ranked, a choose-one sibling set, or a
// class, at most three names. Read off the remarks in order; whatever fits no line of the shape is
// counted, never guessed.

/** The caveat that opens every sibling set: the same line each time, so the main thread knows the shape. */
export const CHOOSE_ONE_CAVEAT = 'Related systems; pick the one whose job matches.';

/** How specific a region Warden's pointer is (the pointer ladder of the size test). */
export type PointerLevel = 'exact' | 'candidates' | 'class';

/** A ranked pointer (one most likely, fallbacks after it) or a sibling set the main thread chooses from. */
export type PointerShape = 'ranked' | 'choose-one';

/** One named thing in a pointer: a less likely candidate, or a member of a sibling set. */
export interface PointerCandidate {
  readonly name: string;
  readonly where?: string;
  /** What tells it apart: from the first candidate (ranked), or from its siblings (choose-one). */
  readonly note?: string;
}

/**
 * The classifier charter's output contract, read off a Warden's remarks in order. It says only what
 * the moment touches and how likely each is; nothing in it says whether to use anything.
 */
export interface WardenPointer {
  /** Whether the remarks are a pointer (`Look over here: …` or `Choose one: …`). A NO_COMMENT never reaches here. */
  readonly relevant: boolean;
  readonly shape?: PointerShape;
  /** What to look at: the top name(s) or class, or a sibling set's names, without the location. */
  readonly pointer?: string;
  /** Where it is written, when the remark gave it. */
  readonly where?: string;
  /** Ranked: the one-line why the top one is the likely one. */
  readonly why?: string;
  readonly level?: PointerLevel;
  /** Ranked: the less likely ones, in order. Choose-one: every sibling. */
  readonly candidates?: readonly PointerCandidate[];
  /** Remarks that fit no line of the shape, and names past the cap: counted, so a parse failure is visible. */
  readonly unparsed?: number;
}

const POINTER_PREFIX = /^\s*look over here:\s*/i;
const LESS_LIKELY_PREFIX = /^\s*less likely:\s*/i;
const CHOOSE_ONE_PREFIX = /^\s*choose one:\s*/i;
const CLASS_WORDS =
  /\b(?:listed under|the primitives|the patterns|the rules|the class of|everything under|anything under|the helpers)\b/i;
/** `<name> (<where>) — <note>`: the location may hold one level of parentheses; the note follows a dash. */
const LOCATED = /^(.*?)\s*\(([^()]+(?:\([^()]*\)[^()]*)*)\)\s*(?:[—–]|--?)?\s*(.*)$/s;
const NOTE_DASH = /\s+(?:[—–]|--?)\s+/;

function candidate(text: string): PointerCandidate | undefined {
  const body = text.trim();
  if (!body) return undefined;
  const located = LOCATED.exec(body);
  const [rawName, rawNote] = located
    ? [located[1]!, located[3]]
    : (() => {
        const dash = NOTE_DASH.exec(body);
        return dash ? [body.slice(0, dash.index), body.slice(dash.index + dash[0].length)] : [body];
      })();
  const name = rawName.trim().replace(/[.;,:]+$/, '');
  const where = located?.[2]?.trim() || undefined;
  const note = rawNote?.trim().replace(/^[.;,]\s*/, '') || undefined;
  if (!name) return undefined;
  return { name, ...(where ? { where } : {}), ...(note ? { note } : {}) };
}

function levelOf(pointer: string): PointerLevel {
  const alternatives = pointer
    .split(/\s*(?:,|;|\bor\b|\/)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
  return CLASS_WORDS.test(pointer)
    ? 'class'
    : alternatives.length <= 1
      ? 'exact'
      : alternatives.length <= 3
        ? 'candidates'
        : 'class';
}

/** A pointer names at most this many things: the pointer ladder's candidates rung holds at most three. */
export const MAX_POINTER_NAMES = 3;

/**
 * Parse a Warden's remarks under the classifier charter, in order (advice snippets, or guard finding
 * descriptions). Ranked: `Look over here: <name> (<where>) — <why>`, then `Less likely: <name>
 * (<where>) — <distinction>` lines. A sibling set: `Choose one: <caveat>`, then one `<name> (<where>)
 * — <distinction>` line per sibling; it sits on the candidates rung. The shape is the first remark
 * that opens one; with none, the remarks are not a pointer (`relevant: false`). A ranked pointer's
 * level is read off its top name(s): one name is exact, two or three alternatives are candidates,
 * more or a class phrase is a class. Remarks that fit no line of the shape, and names past three, are
 * counted in `unparsed`, never silently dropped; a sibling set with no members has no level.
 */
export function parseWardenPointer(remarks: string | readonly string[]): WardenPointer {
  const list = typeof remarks === 'string' ? [remarks] : remarks;
  const at = list.findIndex((r) => CHOOSE_ONE_PREFIX.test(r) || POINTER_PREFIX.test(r));
  if (at < 0) return { relevant: false };
  const before = at;
  const rest = list.slice(at + 1);
  if (CHOOSE_ONE_PREFIX.test(list[at]!)) {
    const parsed = rest.map(candidate);
    const members = parsed.filter((c): c is PointerCandidate => !!c);
    const kept = members.slice(0, MAX_POINTER_NAMES);
    const unparsed = before + (parsed.length - members.length) + (members.length - kept.length);
    return {
      relevant: true,
      shape: 'choose-one',
      ...(kept.length
        ? { pointer: kept.map((m) => m.name).join(', '), level: 'candidates' as const }
        : {}),
      candidates: kept,
      ...(unparsed ? { unparsed } : {}),
    };
  }
  const top = candidate(list[at]!.replace(POINTER_PREFIX, ''));
  const lessLikely = rest.filter((remark) => LESS_LIKELY_PREFIX.test(remark));
  const parsed = lessLikely.map((remark) => candidate(remark.replace(LESS_LIKELY_PREFIX, '')));
  const fallbacks = parsed.filter((c): c is PointerCandidate => !!c);
  const kept = fallbacks.slice(0, MAX_POINTER_NAMES - 1);
  const unparsed =
    before +
    (rest.length - lessLikely.length) +
    (parsed.length - fallbacks.length) +
    (fallbacks.length - kept.length);
  if (!top) return { relevant: true, shape: 'ranked', ...(unparsed ? { unparsed } : {}) };
  return {
    relevant: true,
    shape: 'ranked',
    pointer: top.name,
    ...(top.where ? { where: top.where } : {}),
    ...(top.note ? { why: top.note } : {}),
    level: levelOf(top.name),
    ...(kept.length ? { candidates: kept } : {}),
    ...(unparsed ? { unparsed } : {}),
  };
}
