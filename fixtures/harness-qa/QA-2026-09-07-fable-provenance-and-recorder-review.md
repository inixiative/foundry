Privately: nothing further is needed for either task. Task A's correction is verified with stable reports and the handoff is updated. Task B's review has the preparation document, the runner, the CLI, the sanitizer changes and the test list in hand. Report follows, with the two verdicts kept separate.

## Task A: provider correction, complete, not self-accepted

| Check | Result |
|---|---|
| Supervisor provenance file before edits | 4 fail, 1 pass |
| Both independent model files via G5, unchanged | 9 pass, typecheck, diff check |
| Independent files plus my offline tests | 16 pass |
| Existing provider, adapter, providers, agent-selection, failure and session suites | 81 pass |
| Full baseline | pass |
| Foundry typecheck | exit 0 |

Reports: `.foundry/qa/2026-09-07T03-33-54.637Z-G5/report.json` and `.foundry/qa/2026-09-07T03-33-06.909Z-baseline/report.json`. Handoff: `fixtures/harness-qa/QA-2026-09-07-fable-native-model-profile.md`, new "Correction 2" section.

What changed, in the provider file and my own tests only:

- Acknowledgment now comes only from a supported configuration envelope that names this session's own native binding: the Claude init line with a matching session id, or the Codex session-configured notification with a matching thread id. A model field on a tool, unknown or foreign-binding event is not evidence. The positive capability is kept.
- The warm profile carries the binding lookup state. The synchronous reservation is pending and unknown, a resolved lookup is fresh or unknown, and a rejected lookup is retained as failed with its message. Nothing is rewritten as fresh. Profile-mismatch refusal before send, including concurrent creation, is unchanged.
- My earlier test that treated an arbitrary result model as acknowledgment was replaced by a synthetic supported-envelope case, labelled as such. The installed engine still drops the real Claude init line; nothing claims otherwise.
- Astra's concurrent edits elsewhere can make the baseline stale after this timestamp. Rerun before acceptance.

## Task B: read-only review of Astra's offline recorder preparation

Verdict: accept the preparation as offline work, with two concrete preconditions before any real capture is authorized. No sibling file was edited and no probe was launched.

Verified in source and tests:

- **One owned process, at most two sends.** The spawn hook throws on a second spawn, the run loop admits exactly two tasks, and a capture object can run once. Startup and pre-send hook failures cannot borrow a previous admission id.
- **Exact native joins.** Verification requires local resolution, native completion, an open transport, a live session, the same binding as the session, and no observer or diagnostic failures. Claude terminals join by result UUID and session id; Codex joins task-started, task-complete and the owning RPC result by turn id and request id. Tool begins and results join by call id, commands are compared before redaction against an exact allowlist, and sentinel content and markers must appear in output.
- **First failure or unknown blocks the second.** Task one is verified before and again after the checkpoint. Any rejection, timeout or unknown outcome stops admission, retains ownership, and waits for the owned terminal or process exit before cleanup. The recorded cleanup outcome distinguishes unknown from failed, and the kill request is a separate lifecycle event. Unknown timeout is never recorded as cancellation.
- **No replay, exclusive outputs, immutable history.** Output directories are reserved before any process with exclusive-create writes, collisions never overwrite, the 13 historical recordings are hash-checked unchanged, and plan mode launches nothing and writes nothing.
- **Redaction.** The continuation sanitizer profile is opt-in and preserves only the controlled prompts, file names, contents and markers plus terminal fields; the single-turn policy is unchanged. Versions and argv go through the existing allowlists.
- **Checkpoint failure and attached cleanup.** The CLI checkpoint rewrites the sample manifest check and throws on any artifact change, which stops further admission. Cleanup is attached in a finally block and waits for the owned outcome; a rejected evidence write never abandons the process.

Preconditions before authorizing real capture:

1. **Hard-coded runtime version.** Both the CLI preflight and the tool-output guard require the literal Bun version string 1.3.14. A different installed version would make an otherwise correct capture read as evidence-incomplete or fail preflight. Compare against the recorded version probe instead of a literal.
2. **Fixed 50 ms settle before verification.** On the MCP path, local resolution can precede the task-complete notification. If the terminal arrives after the settle window, the capture stops as evidence-incomplete with no second send. That is safe but yields false negatives. Wait until the owned terminal is known or the send deadline passes before verifying.

Neither precondition weakens a guard. A passing source pass proves the recorder's contracts, not native continuation, retention, cancellation or capacity. Astra remains provisional lead at count 4, next checkpoint 6, with Fable as reviewer; the supervisor decides acceptance for both items.