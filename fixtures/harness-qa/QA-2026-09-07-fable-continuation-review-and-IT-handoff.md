# Fable: two-admission native continuation evidence review, and I/T integration handoff (2026-09-07, ~04:15-04:20Z)

Read-only. No source, test, ledger, fixture or dependency was edited. No probe, capture,
restart or credential action. Astra provisional lead count 5, next checkpoint 6.
Supervisor decides acceptance.

## Task A: review of the two disposable two-admission recordings

Reviewed only the sanitized recordings under
`../agent-session/fixtures/s0/s1-continuation-20260907T041000Z/`, their provenance
fields, the normalized events and the sanitized wire frames. No hidden reasoning,
unsanitized tapes, environment or secrets were opened. Hashes recomputed locally
match the request exactly:
`36932ab6…c08ed2` (claude-continuation/recording.json),
`5f6d23a1…10ded7` (codex-mcp-continuation/recording.json).

### Verified facts (both engines unless noted)
- Format 4, sibling checkout revision `4336603026fa…`, package name/version
  `@inixiative/agent-session 0.1.0` marked "sibling checkout, not installed in Foundry".
- Preflight: Bun `1.3.14`; Claude `2.1.258 (Claude Code)`; Codex `codex-cli 0.153.4`.
- `stop: complete`, `spawnCount 1`, `sendCalls 2`, `admittedSends 2`,
  `observedTurnWrites 2`, `admissionClosed: null`, both turns `localSend resolved`,
  `nativeWait known`, `verified true`, attempts `nativeOutcome completed`,
  `dispatch attempted`, `transportOutcome open` at verification.
- Same native binding across both admissions: Claude `nativeSessionId ref-3` on
  both attempts with `correlation ordered-stream` and distinct result event ids
  (`ref-25`, `ref-44`); MCP `threadId ref-3` on both attempts with distinct native
  turn ids (`ref-6`, `ref-19`), `correlation native-turn`, `rpcOutcome resolved`,
  terminals `task_complete` joined by turn id. Admission ids distinct
  (Claude `ref-12`/`ref-30`; MCP `ref-5`/`ref-21`).
- Tool joins by call id, one begin and one result per admission, commands exactly
  `bun --version` then `cat sentinel-<n>.txt`, outputs `1.3.14` plus the expected
  sentinel; final content carries the expected marker. Sentinel manifest
  unchanged before and after (same directory and manifest hashes, 2 entries).
- Owned exit: `cleanup-outcome-established { nativeTerminal: completed, exited: false }`
  followed by `owned-process-kill-requested` and `process-exited { code: 143 }`;
  no observer errors, diagnostics 0/0. Lifecycle events are the typed set, argv
  sanitized via the allowlist (Claude includes `--model claude-fable-5-1 --effort max
  --max-turns 8`; Codex includes `model_reasoning_effort="xhigh"`).
- Observed configuration: Claude `system/init` frames report `model claude-fable-5-1`,
  effort absent (unknown, as the supervisor states); MCP `session_configured`
  reports `gpt-6-astra` and `xhigh`. MCP `codex` first call carried `model`; the
  `codex-reply` continuation carried only prompt and threadId, so the second MCP
  admission's model is inferred from same-process continuation, not re-stated.
- Sanitization: 189 and 303 string leaves respectively; no filesystem paths,
  emails, key-like or bearer strings; the only long strings are the controlled
  prompts and plan-limit sentences. The single "suspicious" regex hit is the
  literal event type name `token_count`.
- Account identity, capacity and subscription continuity are recorded `unknown`
  and are not inferred here. The tasks were independent by design and do not
  test remembered context.

### Findings
1. **Medium, integration hazard, not a capture defect.** Claude emitted a second
   `system/init` for the same session id at the start of the second admission
   (frames 2 and 17, both `session_id ref-3`). The engine's compaction heuristic
   ("a second init means the session restarted") classified it as a
   `session_compact` event (present in the normalized log, no admission id). For a
   two-turn print-mode session with an unchanged binding this is a per-turn init
   re-emission, not evidence of compaction. Foundry's flow invalidates the
   injection ledger on `session_compacted`; adopting the sibling as-is would
   invalidate the ledger on every native turn. Needs a real-versus-repeat init
   distinction (compare init payload fields beyond model/session id, or require a
   `compact_boundary`) before I adoption. Recorded now so it is not lost.
2. **Low.** MCP stderr carried 576 bytes that are recorded as a byte count only.
   That is the intended redaction, but nothing in the recording says whether it
   was benign; the supervisor's live inspection is the only source for that.
3. **Low.** 17 Claude and 95 Codex frames are retained as `native_status`
   `unrecognized-event` (Claude `system` hook events under `--include-hook-events`;
   Codex `raw_response_item`, `token_count` and unknown types). Correct retention,
   but it means usage (`token_count`) is present in the wire yet not surfaced as
   evidence, which is the known S4 gap.

### Verdict
Accept the bounded two-admission continuation evidence for what it proves: one
owned process per engine, two independently admitted and verified sends on the
same native binding, distinct native turn identity on MCP, ordered-stream
correlation on Claude, exact tool joins with unchanged controlled artifacts, owned
exit. It does not prove native context retention, model/effort acknowledgment
beyond the observed init/configured frames (Claude effort unknown), account
identity, capacity, subscription continuity, cancellation, usage or fork/rewind.
Finding 1 is a prerequisite fix for I adoption, not a reopen of this evidence.

## Task B: concrete I/T integration handoff (read-only preparation)

### What Foundry uses today
- Dependency: `packages/foundry/package.json` `@inixiative/agent-session ^0.1.0`;
  `bun.lock` pins `0.1.0` from the registry with an integrity hash. The sibling
  checkout is version `0.1.0` too, with `main`/`types` pointing at `src/index.ts`.
- Import sites: `packages/foundry/src/providers/session-adapter.ts`,
  `providers/session-backed.ts`, `providers/index.ts`, `src/index.ts`, plus
  `scripts/decision-qa.ts` and `scripts/start-harness-lead.ts`. Startup wires
  `ClaudeCodeSessionAdapter`/`CodexSessionAdapter` into `SessionBackedProvider`
  (`start.ts` ~160-190) and registers `MemoryToolAdapter` instances for the API
  tool loop (`start.ts` 285, 437, 468).
- Native providers bypass `toolUseLoop`: `thread-factory.ts` 377-406 only runs
  the loop for API providers; for native sessions the tool summary is appended to
  the prompt text (a prompt list, not callable tools).
- Foundry already has an MCP server with five tools (`foundry_query`,
  `foundry_conventions`, `foundry_memory`, `foundry_threads`, `foundry_signal`) and
  a stdio launcher `packages/foundry/src/mcp/cli.ts` that loads `.foundry/settings.json`
  from cwd and builds its own thread. It is not thread- or project-scoped by the
  caller and it is not passed to native sessions today: the restricted Claude
  spawn passes an empty `--mcp-config '{"mcpServers":{}}'`.

### What the sibling now offers (public, additive)
`harness-session.ts` exports `SessionIdentity`, `NativeOutcome`, `NativeTerminal`,
`SessionAttempt`, `SessionTurnError`, `SessionEvent` (with `nativeOutcome`,
`terminal`, `unattributedReason`), `SessionResult` (optional `admissionId`,
`nativeOutcome`, `terminal`, `rpcOutcome`, `localOutcome`, `transportOutcome`),
`SessionDiagnostics`, `SessionArtifact.attempts`, `HarnessSession.attempts?` and
`diagnostics?`. All new fields are optional, so existing Foundry callers compile
unchanged; behavior changes are: interrupt no longer nulls the in-flight turn,
unknown outcomes block new sends until resolved, and unowned events are retained
as `native_status`.

### Smallest adoption mechanism (I)
1. Publish or file-link the sibling at a new version (`0.2.0`) and change only the
   Foundry dependency spec plus lockfile in a dedicated change; no code edits are
   required for compilation. Do this in an isolated fixture checkout first.
2. `session-backed.ts`: replace the completion-only heuristics with the typed
   result. Concretely: read `result.nativeOutcome`/`result.terminal` instead of
   scanning `raw.type === "result"`; on `SessionTurnError` read `error.attempt`
   and persist local, native, transport and journal outcomes separately (this is
   what CORE-004 asked for: the journal currently drops structured terminal fields).
   Keep the requested-versus-acknowledged split; read acknowledgment from the
   engine's now-retained `native_status` init/configured events for THIS binding.
3. `session-adapter.ts`: delete `attachEvidenceOwnership` and
   `observedConfiguration` once the sibling's `retainEvidence` freezing is in the
   installed package; keep `describeConstruction` (construction truth is not
   provided by the engine). Deletion criterion: the adopted engine exposes frozen
   `raw` on every event and retains unowned init as `native_status`. Until then the
   wrapper stays; it must not be duplicated inside the sibling.
4. Fix Finding 1 in the sibling before adoption (repeat-init versus compaction).
5. Persist `SessionArtifact.attempts` and `diagnostics` with each turn in the
   journal, keyed by admission id, as CORE-004 requires; reconcile late evidence by
   admission id, never by "latest turn".

Compatibility hazards: the S1 refusal semantics (`blocked` sends while an
outcome is unknown) will surface as new errors on threads whose native turn timed
out; the runtime must present these as unknown-outcome, not failure, and must not
retry. Existing persisted bindings are unaffected (store schema unchanged), but the
auxiliary text-only binding namespace and `describeConstruction` must stay.

Isolation and rollback: adopt on a disposable fixture server first (the same
production factory, executor and provider over the sibling), with the primary and
lead servers untouched and their journals, bindings and audit checkpointed;
rollback is the prior build plus the checkpoint, never a journal replay.

### Callable scoped tools (T)
Mechanism that exists today, no new bridge or protocol:
- Claude: pass a real `--mcp-config` JSON naming Foundry's existing stdio server
  (`bun run packages/foundry/src/mcp/cli.ts`, cwd = project) for central sessions
  only; keep `--strict-mcp-config` and the empty config for text-only auxiliaries.
  `--allowed-tools`/`--disallowed-tools` exist for restricting the native tool set.
- Codex: `codex mcp add <name> -- <command...>` or the equivalent `-c mcp_servers.…`
  config keys on the `mcp-server` spawn (both shown by the installed CLI help);
  the adapter already passes `-c` overrides at spawn.
Required changes before either is wired: (a) the Foundry MCP server must take an
explicit thread and project scope (ids or a per-session token in its launch
arguments) and enforce `entryVisibleTo` ownership on `foundry_memory`, instead of
building an unscoped thread from cwd; (b) tool calls must carry dispatch/call
provenance into the existing tool-evidence path (call id, thread, message id) so
the domain reviewers see real results, not prompt text; (c) the required-context
guard's block mode should be revisited once real retrieval exists, since
`oversizedPinned: "block"` currently assumes no retrieval.

### First executable integration tests (write before any dependency change)
1. `SessionBackedProvider` over a controlled session that returns the S1 typed
   result: `nativeOutcome` and `terminal` flow into the completion; a
   `SessionTurnError` with a completed attempt yields completed output plus a
   local failure, never "execution failed".
2. Unknown outcome: a timed-out send leaves the thread blocked; the runtime shows
   unknown, refuses a second dispatch, and reconciles when the late terminal
   arrives by admission id.
3. Repeat-init versus compaction: two Claude turns on one binding do not invalidate
   the injection ledger; a `compact_boundary` does.
4. Scoped MCP tool: a Claude session launched with the Foundry `--mcp-config` for
   thread A cannot read thread B's private memory; the call appears in tool
   evidence with call id and message id. Same for a Codex `mcp_servers` launch.
5. Wrapper retirement: with the adopted engine, mutating a returned event's raw
   throws and observers receive frozen events with no Foundry wrapper installed.

### Open, not claimed
Native retention (S6), account/usage/capacity, cancellation acknowledgment, fork
and rewind lineage, attachments, model/effort acknowledgment beyond the observed
init frames, and any latency or parity measurement.
