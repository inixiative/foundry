// The point charter for Wardens: how every Warden works when it points
//
// One fixed meta-instruction set, part of Foundry and never settings: it is not edited per project,
// org or Warden. It heads the system message of every Warden call, above that Warden's own composed
// instructions; the phase's response protocol follows the input. Iterate on its wording against
// real sessions (`scripts/evals/warden-charter.ts`), never by hand-tuning one Warden.
//
// One wording ships: the classifier charter region Wardens run under (one Warden per concept region
// of a project). The hand-named roster and its advise-style charter ("Name the rule, then say what to
// do instead") were retired on 2026-10-17 (Aron: "We're just doing the region wardens"): region
// Wardens anticipated 23% of corrections to the roster's 3% (finding 2026-10-15-region-wardens-vs-roster),
// and two charters with opposite rules (advise vs. point only) invited confusion.

import { computeHash } from '@inixiative/foundry-core';
import type { PointerSettings } from '../stages';
import { assemblePrompt } from './sections';

/**
 * The point charter for a pointer set, assembled from its sections (`point/<section>.md`, in the
 * order `PROMPT_SECTIONS.point` gives): ranked, class and all-of always, choose-one when `any` is on.
 * Turning `any` off removes its paragraph, so a Warden is never invited to answer in a shape the
 * parser then refuses.
 */
export function pointCharter(pointer: PointerSettings): string {
  return assemblePrompt('point', undefined, {
    where: 'point',
    ...(pointer.any ? {} : { omit: ['choose-one'] }),
  }).text;
}

/**
 * The Warden charter, the classifier wording every region Warden (a project's chorus) runs under by
 * default (`pointer.any` on). Its first principle (Aron, 2026-10-17): an instruction to build something
 * new is a reason to look, so an existing system that does the job is pointed at even when the
 * instruction says "build a new X" or "don't use X". It judges only relevance and likelihood:
 * NO_COMMENT, or a ranked pointer (`Look over here: …`, then `Less likely: …`), an all-of set (`All of
 * these: …`), a sibling set (`Choose one: …`) or a class, at most three names, each with its doc section
 * and one line that tells it apart. The main thread follows the pointer and decides; the Warden never
 * judges whether to use anything. (The wording measured in Foundry #81 and #85-87 was the one-pointer
 * predecessor; those numbers do not describe this text.)
 */
export const WARDEN_CHARTER = pointCharter({ any: true });

/** The charter's version: a hash of its text, journalled with every Warden decision and eval run. */
export const WARDEN_CHARTER_VERSION = `charter-${computeHash(WARDEN_CHARTER).slice(0, 12)}`;

/**
 * A Warden call's system message: the charter, then the Warden's own instructions. `charter` is the
 * shipped WARDEN_CHARTER, or a candidate wording under evaluation.
 */
export function chartered(instructions: string, charter = WARDEN_CHARTER): string {
  return `${charter}\n\n# Your instructions\n\n${instructions}`;
}
