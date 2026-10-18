// A recognise stage's remarks name regions, one per line: `<region id>: <why>`, and in a ternary
// stage `<region id>: YES — <why>` or `<region id>: UNSURE — <why>`. A recogniser may hold one region
// or a group of them (`members` in a group's region.json): an id outside what it holds is counted,
// never guessed, and a line in no shape is an error.

import type { ClassifyOutcome } from '@inixiative/foundry-core';
import type { StageOutcomes } from './stages';

/** One region a recogniser named for a moment, with its line why and its outcome. */
export interface Recognition {
  readonly regionId: string;
  readonly why: string;
  readonly outcome: Exclude<ClassifyOutcome, 'no'>;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
const LINE =
  /^\s*(?:in my domain:\s*)?(?:regions?\s+)?`?([A-Za-z0-9][A-Za-z0-9_.,\s`/-]*?)`?\s*:\s*(.+?)\s*$/i;
const TAG = /^\**(YES|UNSURE)\**\s*(?:[—–:-]+\s*|$)/i;

/**
 * Read a recogniser's remark lines. Several ids before one colon share the line (a collapse,
 * counted). In a ternary stage every line carries its tag; in a binary stage a line is a yes, and an
 * UNSURE tag there is an error.
 */
export function parseRecognition(
  remark: string,
  outcomes: StageOutcomes = 'binary',
): { regions: Recognition[]; errors: string[]; collapses: number } {
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
    const tag = TAG.exec(m[2]!);
    const outcome = tag ? (tag[1]!.toLowerCase() as 'yes' | 'unsure') : 'yes';
    const why = tag ? m[2]!.slice(tag[0].length).trim() : m[2]!;
    if ((outcomes === 'ternary' && !tag) || (outcomes === 'binary' && outcome === 'unsure')) {
      errors.push(line.trim());
      continue;
    }
    if (ids.length > 1) collapses++;
    for (const id of ids) regions.push({ regionId: id, why, outcome });
  }
  return { regions, errors, collapses };
}
