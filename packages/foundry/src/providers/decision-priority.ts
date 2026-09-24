/** CompletionOpts.priority for decision roles. A turn waiting to start outranks guards on
 * completed actions, which outrank background learning review. */
export const DECISION_PRIORITY = { turn: 0, guard: -1, review: -2 } as const;
