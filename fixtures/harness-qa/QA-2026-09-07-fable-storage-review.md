Privately: nothing else is needed. The diffs, helpers, tests, browser evidence, and the S0 request are all in hand, so the report follows without further tool calls.

## Verification

| Check | Result |
|---|---|
| focused browser-storage state tests | 7 pass |
| focused completion-persistence, both transports | 2 pass |
| failure-evidence, conversation-state, local-session-store | 24 pass |
| five independent acceptance cases, unchanged | 5 pass |
| typecheck, both packages | exit 0 |
| real headless browser storage and completion tests via the QA runtime | four storage scenarios passed, both completion transports passed, no page errors, two provider calls per scenario as designed |

Attribution: the storage snapshot lists three UI files, two test files, the fixture helper, and the ledger as owned changes, and records the supervisor's checker as an external change preserved. That matches what I diffed.

## Findings, most severe first

**1. Low. The rejected-write warning also renders on the user's own message row.** A new user message is appended without a storage status, so on a rejected write it becomes volatile and gets the generic notice, "Server persistence is unconfirmed." The user turn was accepted by the journal before the executor ran, so for that row the wording is more pessimistic than the facts. The agent row carries the accurate notice. Cosmetic duplication, not a truth defect.

**2. Low. The warning styling is inline rather than a stylesheet class.** The element has a class and a status role, which the tests rely on, but the colour and margin are inline. Readability of failure metadata is already an open G6 item; fold this in.

**3. Low, pre-existing, sharpened by this slice. The offline fallback path bypasses the new persistence helper.** When the history fetch fails, the merged local list is assigned directly without a write, so those rows keep the "saved" status they were loaded with. That is correct today because everything loaded from storage is by definition saved. If a later change adds mutation on that path, the status would drift. Note only.

No new blocking regressions. The prior medium finding is resolved: the persistence helper publishes saved status only after serialization and the write succeed, a rejected write leaves the previous snapshot untouched, changed rows become volatile with the error name, unchanged saved rows keep their status, and a later ordinary write clears volatility without touching server persistence or re-sending the turn. The notice distinguishes four cases truthfully: committed result with failed optional cache, committed record plus tab-only failure evidence, unsaved completion that exists only in this tab, and the generic unconfirmed case. Serialization failure of the trace snapshot is caught before any write and cannot blank the rendered output. Revert and fork now route through the same helper, and fork clears inherited status before the first write. Fork and rewind here are browser-history copies over the existing thread endpoints; nothing in this slice adds native fork or rewind support, and the ledger does not claim it.

## Acceptance

The bounded storage correction is accepted. The supervisor's real composer runs with forced quota and security errors, plus my rerun of the same headless scenarios, cover what the unit tests cannot: the warning survives rerender, thread navigation, and the transient toast window, and the prior browser snapshot is preserved byte for byte. This is not server-side durability of unsaved output and not native reconciliation. Those stay open.

## Leadership checkpoint

Recommend retaining Astra as provisional lead with Fable as reviewer and Codex as supervisor.

Evidence for: both corrections were test-first, bounded to the named files, preserved external concurrent changes, recorded honest limits, and did not creep into persistence or native rewrites. The first defect I found was fixed correctly in one pass with a dedicated fixture that also guards against a second failure write. The second was fixed with state tests and real browser scenarios. Ledger entries were accurate about what was and was not proven.

Evidence against, stated plainly: the first slice shipped a real high-severity defect that the lead's own tests did not catch, and the two review cycles are the cost of that. Elapsed times are not model-speed comparisons and I make no general model-quality claim from two small slices. The pattern in both defects was the same class, success followed by an infrastructure failure. The lead should add that class to its own test matrix before review on every slice that touches persistence or transport.

Reevaluate after two more accepted slices or on a serious regression, per the brief.

## S0 request scope check

The prepared request is bounded and safe: existing engines only, disposable directories, allowlisted sanitization with adversarial tests, no auto-retry of ambiguous probes, no self-acceptance. It correctly notes that Foundry still resolves the registry package, not the sibling.

Two scope adjustments before dispatch:

- **Record the Codex app-server path as well as the MCP path.** CORE-004 S1 through S3 depend on turn, item, and status identity that only the app-server protocol carries. The request confines Codex capture to the MCP tool-call path, so S1 would start with no fixture for the protocol it must implement. One additional bounded app-server recording, still not a default switch, keeps S0 from becoming a fixture detour that unblocks nothing.
- **Time-box it.** S0 is enabling work. Set an explicit boundary of one recording per runtime plus the sanitization and replay tests, then S1 begins. Anything beyond that is a separate node.

Pre-rollout blockers remain the same and are unchanged by this slice: live reconciliation of rows left active after a failed commit, raw memory amplification, and readability of failure metadata. Historical layer, tag, and artifact inspection and release parity stay open as release requirements, not as conditions for accepting this correction.
