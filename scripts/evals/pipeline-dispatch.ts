/**
 * The two-stage experiment's hand-off (eval-only; `warden-charter.ts --pipeline`): parse a stage-1
 * recogniser's remark into region ids, validate them against the recogniser's members (a group
 * recogniser holds several regions; a one-region recogniser holds itself), and dispatch each named
 * region to its stage-2 picker by id. Same semantics as `warden-groups.ts expand`: an id outside the
 * recogniser's members is counted, never guessed; a line in no shape is a parse error.
 */

/** One region a recogniser named for a moment, with its line why. */
export interface Recognition {
  readonly regionId: string;
  readonly why: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
const LINE =
  /^\s*(?:in my domain:\s*)?(?:regions?\s+)?`?([A-Za-z0-9][A-Za-z0-9_.,\s`/-]*?)`?\s*:\s*(.+?)\s*$/i;

/**
 * One `<id>: <why>` (or `region <id>: <why>`) per line. Several ids before one colon share the line
 * (a collapse, counted); a line in no shape is an error.
 */
export function parseRecognition(remark: string): {
  regions: Recognition[];
  errors: string[];
  collapses: number;
} {
  const regions: Recognition[] = [];
  const errors: string[] = [];
  let collapses = 0;
  for (const line of remark.split('\n')) {
    if (!line.trim()) continue;
    const m = LINE.exec(line);
    const ids = m
      ? m[1]!
          .split(/\s*(?:,|\band\b|\/)\s*/i)
          .map((s) => s.trim().replace(/^`|`$/g, ''))
          .filter((s) => ID.test(s))
      : [];
    if (!m || !ids.length) {
      errors.push(line.trim());
      continue;
    }
    if (ids.length > 1) collapses++;
    for (const id of ids) regions.push({ regionId: id, why: m[2]! });
  }
  return { regions, errors, collapses };
}

/** A stage-1 answer as dispatch reads it. */
export interface StageOneAnswer {
  readonly probeId: string;
  readonly trigger?: string;
  readonly domain: string;
  readonly noComment: boolean;
  readonly error?: string;
  readonly text?: string;
}

export interface DispatchCounts {
  remarks: number;
  regionsNamed: number;
  parseErrorLines: number;
  remarksWithErrors: number;
  collapses: number;
  /** Ids the recogniser does not hold (outside its group's members). */
  unknownRegions: number;
  /** Ids the recogniser holds but the pick regions have no picker for. */
  missingPickers: number;
  dispatched: number;
}

/**
 * For each stage-1 remark: parse it, keep the ids among `membersOf(recogniser)`, keep those
 * `hasPicker(id)` says stage 2 can ask, and return them per moment (`<probeId>|<trigger>`), first why
 * line kept per region, with the counts.
 */
export function dispatch(
  answers: readonly StageOneAnswer[],
  membersOf: (recogniser: string) => readonly string[],
  hasPicker: (regionId: string) => boolean,
): { fired: Map<string, { domain: string; why: string }[]>; counts: DispatchCounts } {
  const fired = new Map<string, { domain: string; why: string }[]>();
  const counts: DispatchCounts = {
    remarks: 0,
    regionsNamed: 0,
    parseErrorLines: 0,
    remarksWithErrors: 0,
    collapses: 0,
    unknownRegions: 0,
    missingPickers: 0,
    dispatched: 0,
  };
  for (const a of answers) {
    if (a.noComment || a.error || !a.text) continue;
    counts.remarks++;
    const key = `${a.probeId}|${a.trigger ?? 'agent-action'}`;
    const { regions, errors, collapses } = parseRecognition(a.text);
    counts.parseErrorLines += errors.length;
    if (errors.length) counts.remarksWithErrors++;
    counts.collapses += collapses;
    const members = new Set(membersOf(a.domain));
    for (const r of regions) {
      counts.regionsNamed++;
      if (!members.has(r.regionId)) {
        counts.unknownRegions++;
        continue;
      }
      if (!hasPicker(r.regionId)) {
        counts.missingPickers++;
        continue;
      }
      const list = fired.get(key) ?? [];
      if (!list.some((x) => x.domain === r.regionId)) {
        list.push({ domain: r.regionId, why: r.why });
        counts.dispatched++;
      }
      fired.set(key, list);
    }
  }
  return { fired, counts };
}
