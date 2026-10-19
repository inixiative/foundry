/**
 * @atlas
 * @kind service
 * @partOf feature:wardens
 */
// ---------------------------------------------------------------------------
// Warden trigger points — the moments a Warden is asked
//
// Every Warden a trigger point reaches is asked, unless the pre-filter (`prefilter` in settings, off
// by default; providers/warden-prefilter.ts) is on and confident the moment is outside its domain, and
// decides under the fixed charter (`warden-charter.ts`) whether it has anything to add. NO_COMMENT
// is the default answer and adds nothing to the thread. The pre-filter fails open: an unsure score,
// a failed call or a missing model asks the Warden, and every skip is journalled with its score, so a
// missed ask is auditable.
//
// Implemented:
//   - `user-message` (advice phase): every Warden, on every user message;
//   - `agent-action` (guard phase): once per turn, over the turn's tool activity in call order (every
//     write, edit and command a Warden's `guardTriggers` name), asked of every Warden whose triggers
//     name one of them when the turn's tool activity ends (Aron, 2026-10-15: one guard per turn, not
//     per tool call; `guard: "per-call"` in settings restores a guard per call). An observed subagent's
//     own turn is guarded the same way, on the subagent's node;
//   - `subagent-spawn` (brief): when the agent hands a task to a subagent, the chorus briefs the
//     handoff from the task text; the brief is journalled on the parent and delivered as a note;
//   - `consumed` (advice phase): when the agent takes in a work item (a ticket or spec file it reads,
//     a Linear issue or Notion page it fetches; `chorus.consumed` in a project's settings, off by
//     default), every Warden is asked what of its domain the work touches. Like a brief, what they
//     say is journalled and rides with the next turn as a note;
//   - after the work, every Warden's post-work review (pre-filtered as `post-turn`).
// Next, each with its own input, protocol text and NO_COMMENT default:
//   - `agent-question`: answer on the user's behalf when confident and backed by a recorded ruling;
//   - `hand-back`: process Wardens review the final message before it lands (one extra pass at most).
// ---------------------------------------------------------------------------

/**
 * The points in a thread where Wardens are asked: user-message → advice, consumed → advice on a work
 * item, agent-action → guard, subagent-spawn → brief.
 */
export type TriggerPoint = 'user-message' | 'consumed' | 'agent-action' | 'subagent-spawn';

/** The trigger points answered through the advice protocol (snippets, not findings). */
export type AdviceTrigger = Extract<TriggerPoint, 'user-message' | 'consumed' | 'subagent-spawn'>;

/** How often the guard fires: once over a turn's whole tool activity (default), or on each tool call. */
export type GuardMode = 'per-turn' | 'per-call';
