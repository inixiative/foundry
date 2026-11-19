/**
 * @atlas
 * @kind helper
 * @partOf primitive:decisions
 */
/** CompletionOpts.priority for decision roles. A turn waiting to start outranks guards on
 * completed actions, which outrank background learning review, which outranks a debug reason asked
 * after its decision. */
export const DECISION_PRIORITY = { turn: 0, guard: -1, review: -2, debug: -3 } as const;
