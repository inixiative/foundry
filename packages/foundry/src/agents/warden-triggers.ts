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
//   - `agent-action` (guard phase): every Warden whose `guardTriggers` names the tool;
//   - after the work, every Warden's post-work review (pre-filtered as `post-turn`).
// Next, each with its own input, protocol text and NO_COMMENT default:
//   - `subagent-spawn`: brief the handoff when the agent delegates;
//   - `agent-question`: answer on the user's behalf when confident and backed by a recorded ruling;
//   - `hand-back`: process Wardens review the final message before it lands (one extra pass at most).
// ---------------------------------------------------------------------------

/** The points in a thread where Wardens are asked: user-message → advice, agent-action → guard. */
export type TriggerPoint = 'user-message' | 'agent-action';
