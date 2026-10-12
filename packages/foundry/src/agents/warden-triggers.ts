// ---------------------------------------------------------------------------
// Warden trigger points — the moments a Warden is asked
//
// Every Warden a trigger point reaches is asked, and decides under the fixed charter
// (`warden-charter.ts`) whether it has anything to add. NO_COMMENT is the default answer and adds
// nothing to the thread. There is no relevance prefilter: deciding what is in a domain is the
// Warden's job, for any system, language or preference, and a missed ask would fail silently. Load is
// handled by sizing the decision queue, not by asking fewer Wardens.
//
// Implemented:
//   - `user-message` (advice phase): every Warden, on every user message;
//   - `agent-action` (guard phase): every Warden whose `guardTriggers` names the tool.
// Next, each with its own input, protocol text and NO_COMMENT default:
//   - `subagent-spawn`: brief the handoff when the agent delegates;
//   - `agent-question`: answer on the user's behalf when confident and backed by a recorded ruling;
//   - `hand-back`: process Wardens review the final message before it lands (one extra pass at most).
// ---------------------------------------------------------------------------

/** The points in a thread where Wardens are asked: user-message → advice, agent-action → guard. */
export type TriggerPoint = 'user-message' | 'agent-action';
