Privately: nothing further is needed. The handoff, the supervisor's terminal review, both engine diffs, the new evidence modules, the S1 tests and the independent assertions are all in hand, so the review follows without more tool calls.

## Verification basis

| Check | Result |
|---|---|
| Handoff and final correction section | read in full |
| Production diff, three modified files plus two new modules | read line by line |
| Sibling S1 tests (ownership 30 cases, lifecycle 5) and the three independent Foundry files | assertions read |
| Supervisor reports cited in the request | accepted as stated; not rerun, per the read-only bound |

Nothing was edited, spawned, or probed.

## Findings, most severe first

**1. Medium. Transport failure retroactively relabels every earlier attempt, including completed ones.** In both engines `_transportFailure` runs `for (const a of this._attempts) if (a.dispatch === "attempted") a.transportOutcome = "failed"` (claude-code-session.ts hunk at new lines ~505-512, codex-session.ts hunk at ~470-478). Repro: send one, receive its terminal, then let stdout close. The first admission was completed over a healthy transport, but its snapshot now reads transport failed. This rewrites prior evidence, which is the exact property the slice claims to protect. Only the unresolved admission should carry the failure; resolved ones should keep their recorded state. Test gap: no case asserts a prior completed attempt's transport field is unchanged after a later transport failure. Note that a clean kill does not trigger this path, so a two-admission recording with a controlled exit would not expose it.

**2. Medium. Claude drops every out-of-turn native line from the session log; Codex keeps them.** New `_processLine` returns at `if (!turn) return;` before classification (claude-code-session.ts new line ~627). Previously all classified events were emitted to the event log. Startup init lines (model, tools, session id echo) and any late line arriving when no admission is in flight are now absent from `events` and `artifact()`. The goal "unowned events never enter a later turn" is right, but the Codex path achieves it by emitting unowned events to the log without attaching them to an admission (`if (!a) { this._emit(event); continue; }`). The two engines now disagree, and the Claude engine lost evidence. Foreign-session lines are also dropped silently, so a resume that lands in a different native session produces a timeout with no recorded reason. Recommend emitting unowned and foreign lines with `correlation: "unknown"` and no admission id.

**3. Low. Observer failures are swallowed with no trace.** `_emit` in both engines catches synchronous throws and async rejections and records nothing. The prior code warned. Observers must not affect evidence, agreed, but a counter or a diagnostic event would preserve the fact that an observer failed.

**4. Low. Blocked sends grow `_attempts` without bound.** Every refused `send` pushes a new `TurnState` marked blocked. A caller retrying in a loop grows the array indefinitely and `attempts` snapshots all of it on each read. Cap or coalesce blocked refusals, or document the growth.

**5. Low, naming.** A Claude result with an unrecognized subtype is rejected with `localFailure: "rpc"`. Claude stream-json is not RPC. A distinct reason such as `unrecognized-terminal` would keep the field honest.

**No blocking correctness defect found** in: admission and native identity separation, timeout and interrupt retaining ownership, late terminal reconciliation by admission id, refusal of queued and new sends while unknown, RPC settlement kept distinct from native terminal, error precedence matching Foundry's provider, duplicate result UUID and foreign turn id rejection, tool call join by call id, usage left undefined when absent, the retained-evidence freeze boundary, the argv and lifecycle allowlists, and the drain of buffered terminal evidence before interpreting exit.

## Verdict on the bounded S1 source slice

Reopen narrowly for finding 1, with finding 2 folded in. Both are small, need no new fixtures, and sit inside the slice's own contract on immutable historical evidence. The terminal-evidence correction itself is sound: the real 429 envelope and both synthetic flag variants are handled by the same precedence rule, and synthetic cases are labelled as such in tests. Broader gates stay open as the handoff states: MCP failed and cancelled terminals unrecorded, cancellation acknowledgment absent, streaming, accounting, fork and rewind, continuation, and Foundry adoption. Accepted count remains 3.

## Proposed two-admission disposable continuation recording

Reasonable next node, not yet ready. Preconditions before authorization:

- Land finding 1, since the recorder persists attempt snapshots and a transport hiccup during capture would record false transport failure on the first admission.
- Pseudonymize result UUIDs, native session and thread ids with stable refs across both admissions so first-to-second correlation survives sanitization. The allowlist tests cover single values; add a two-admission sanitizer case.
- Assert exactly two turn writes and one process per engine, same class and instance, disposable temp directories, time-boxed, no primary session.
- Keep the second sentinel independent of the first. If it asks the model to recall the first sentinel, it becomes a native retention claim (S6) and must be labelled as such or excluded.
- State explicitly that the recording proves per-process continuity of the binding, not subscription or account continuity.

## Leadership

Astra's corrections were precise and complete against the supervisor's cases, adopted the established Foundry precedence instead of inventing a new rule, and solved the immutability requirement without the transcript-copy shortcut the review warned against. The two Medium findings are over-corrections in the same direction as the contract, not truth defects in output. Continued Astra lead on S1 and the recording node is warranted, with Fable as reviewer. Scope should stay on the session package; no integration into Foundry until the recording node and the reopen items are independently accepted.
