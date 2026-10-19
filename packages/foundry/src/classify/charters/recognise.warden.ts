/**
 * @atlas
 * @kind definition
 * @partOf primitive:classify
 */
// The recognise charter for Wardens: the first stage of a multi-stage run, which says only whether a
// moment is in its region(s) and why, from a short description of each. A later stage that holds the
// region's full catalogue points (Aron, 2026-10-15: recognition asks "what is this about, is it
// mine?", picking asks "how do we solve it?"). Fixed and owned by Foundry like the point charter; the
// answer's shape (yes, unsure, NO_COMMENT, the region lines) is the response protocol's, never stated here.

import { assemblePrompt } from './sections';

/** The recognise charter, assembled from its sections (`recognise/<section>.md`). */
export const RECOGNISE_CHARTER = assemblePrompt('recognise', undefined).text;
