# Subagents: wrapped and inspectable

> **PROPOSAL — needs Aron's yes before build.** Nothing here is built. It changes what a subagent *is* in Foundry (a child thread with its own middleware), so it follows the "talk the plan through before changing what something means" rule.

**Basis:**
- Foundry origin/main `5ad3fb3` (the `feat/acp-host-mode` branch, since merged).
- agent-session main `fbd3207` (0.6.0).
- Archive main.
- Paseo `1939ee79e`, T3 Code `f23d0084b6`.
- ACP SDK 1.8.0.
- The composition-view config shape from `feat/composition-view`, since merged to main (`02fbc5c`, `f040582`); re-check against main.

**Path prefixes:** as in [FOUNDRY-ACP.md](FOUNDRY-ACP.md):
- `pf/` = `foundry/packages/foundry/src`
- `pc/` = `foundry/packages/core/src`
- `pa/` = `foundry/packages/acp/src`
- `as/` = `agent-session/src`
- `ar/` = `archive/src`
- `paseo:` and `t3:` are the read-only clones.

Anything not checked in code is marked **[unverified]**.

---

## 1. Intent

Aron, 2026-10-12: *"We need to make sure sub-agents also have the same thing and that they're inspectable. I want to be able to see the sub-agents and their runs and all this stuff. All this stuff needs to be interrogatable if we want this process to be able to be improved. The handoff needs enough context, which is the thing we're trying to figure out. This is the bet."*

**The bet:** the main thread stays small because work is handed to specialised agents. That only works if each handoff carries enough context, so the child does not redo, contradict, or re-earn a correction the parent already had.

Today that cannot be measured. A subagent's turn:
- gets none of Foundry's middleware: no composed context, no Cartographer routing, no Warden chorus;
- runs under the tool gate, but anonymously;
- leaves no record of what it was handed.

"The same thing" means four parts:
- the **composition view**: one ladder per role and slot;
- the **middleware**: Cartographer routing, the Warden chorus, the structural tool gate;
- the **journal**;
- **Oracle evidence**.

"Inspectable" means a live tree in the viewer, plus records that Archive and Oracle can query.

---

## 2. How subagents arise today

| Source | How it arises | What Foundry **sees** | What Foundry **controls** |
|---|---|---|---|
| **Claude native `Task` / `Agent`** | The executor calls the tool. Claude runs the child in-process and streams the child's messages with `parent_tool_use_id` set. It writes `~/.claude/projects/<p>/<session>/subagents/agent-<id>.jsonl` (first line: `isSidechain: true, agentId, sessionId = parent`) and `agent-<id>.meta.json` (`agentType, description, toolUseId, spawnDepth`). | **Merged into the parent turn, unmarked.** agent-session never reads `parent_tool_use_id`. `_classify` (`as/claude-code-session.ts:1341-1449`) turns every envelope into the in-flight parent turn's text, tool_use and tool_result events, and child text can overwrite the turn's content until `result` arrives (`as/turn-state.ts:66`). No normalized `SessionEvent` carries a parent id (`as/harness-session.ts:82-178`). `projectNative` (`pf/providers/native-evidence.ts:23`) keeps an allow-list without one. The `Task` call shows as an ordinary tool (`tool:Task`). | **Partial.** The PreToolUse callback carries `agent_id`, which becomes `ToolRequest.agentId` (`as/claude-code-session.ts:1197,1211`; `as/harness-session.ts:261`), so structural rules apply to the child's tools **[unverified live for subagent calls]**. But `pf/turns/tool-gate.ts` drops `agentId` and journals every ask as `agentId: 'artificer'` (`:181`). A rule on `tool:Task` / `tool:Agent` can deny or ask before a spawn. No middleware runs on the child. |
| **Codex native** (multi-agent / collab items) | Codex's own sub-threads **[unverified: which Codex versions emit them and in what shape]**. | **Nothing.** App-server items other than agentMessage, commandExecution, reasoning and mcpToolCall become `itemType: 'unsupported'` (`as/codex-session.ts:1803-1806`). Other-thread notifications are `foreign-session` (`:1814`). Both are discarded at `projectNative`. | **Refusal only.** An approval request from another thread fails the match and gets -32601 (`:1377-1383, 1450-1458`). Codex has no pre-use stage. |
| **Paseo `create_agent`** (MCP) | The agent calls Paseo's tool. Paseo creates a sibling agent: `parentAgentId` and the label `paseo.parent-agent-id` (`paseo:…/create-agent/intent.ts:30-35`); the same-provider mode is inherited (`create-agent-mode.ts:64-65`); the parent's `systemPrompt` and cwd are inherited (`paseo-tools.ts:750,775`). The finish is steered back into the parent turn as a `<paseo-system>` envelope (`agent-prompt.ts:467`). | If the child's provider is Foundry, it is **a new, unlinked Foundry thread**. Paseo does not tell the agent its parent. The parent's call shows as an MCP tool call. | None over the child beyond its own turn path. A rule on `mcp__paseo__create_agent` can deny the spawn. |
| **T3 `delegate_task`** (MCP) | The agent calls T3's tool. T3 creates a child thread (lineage `subagent`, an `app_owned` Subagent) that gets **only the task prompt**, "without copying parent conversation history" (`t3:apps/server/src/mcp/toolkits/orchestrator/tools.ts:66-68`). There is a mode ceiling (`DispatchModeLimit`) and a result mailbox. T3's ACP instructions tell agents to prefer it (`orchestrationInstructions.ts`). | The same as Paseo: an unlinked Foundry thread when the child's provider is Foundry. | The same: a rule on the tool. |
| **Foundry's own pieces** | `ThreadMeta.parentThreadId` ("subagent spawned by another", `pc/thread.ts:72`) is accepted by `POST /api/threads` (`pf/viewer/routes/runtime.ts:479-565`) and nested by the viewer's thread tree (`thread-tree.js:346`, `flow-graph.js:162`). Unwired, as INIXIATIVE.md says: Herald (`split` would spawn), Planner, SessionManager (`thread:spawned`). Fork returns 501 with a local store. There is no `delegate` tool. | Child threads exist as metadata only, with no parent turn or dispatch link. Archive capture drops `parentThreadId` (`pf/archives/capture.ts`). | Full, but nothing spawns a child. |
| **agent-session** | No child-session concept. The nearest is `fork()` (`as/harness-session.ts:319`). `routing.ts` selects accounts only. | — | — |
| **Archive** | The collector walks `subagents/*.jsonl` (`ar/collector.ts:20-29`) and imports each as archive `${sessionId}/agent-${agentId}` (`ar/import.ts:88-93`). | The id prefix is the only link. `meta.json` (`toolUseId`, `agentType`) is not read. | — |

**Net:** the only subagents that exist in practice (Claude `Task`) are invisible as subagents and unwrapped. The bet cannot be tested today.

---

## 3. Options for wrapping

### (a) Foundry owns spawning

**What it is:**
- A `foundry_delegate` tool on Foundry's MCP bridge, next to `foundry_query` and friends (`pf/mcp/server.ts`).
- Each call creates a **child Foundry thread** that runs on the one turn path: `TurnService` → `Harness.send` → classify ∥ route ∥ `flow.prepare` → executor → gate → Wardens → journal.
- The child composes its own context as role `subagent-<kind>`, with its own middleware and journal.
- The harness's native `Task`/`Agent` is redirected to it (below).

**Why it fits:**
- It is "middleware in our own harness, agnostic": an MCP tool works the same under a Claude or a Codex executor.
- It needs no vendor hook.
- The redirect uses the structural gate that already exists (agent-session's control protocol, accepted in slice 2), not a Claude settings hook.

**Costs:**
- Each child turn pays Foundry's pre-turn middleware (median ~1.7 s warm, FOUNDRY-ACP §5.4).
- Each child is a separate native session on the subscription, so it adds capacity pressure. Claude's `Task` already uses the same subscription.
- Claude's native parallel-subagent UI is lost: children render as Foundry children and, in hosts, as tool cards (§6).
- We need a depth limit and a mode ceiling: a child may not run with broader access than its parent, as T3's `DispatchModeLimit` does.
- Redirecting `Task` changes the executor's habits. Its system prompt and tools still advertise `Task` unless the launch removes it.

### (b) Observe native subagents only

**What it is:**
- agent-session carries `parent_tool_use_id` / `agent_id` through to normalized events.
- Foundry records each native child as an **observed child run**: a child thread with no middleware, built from the stream and tied to Archive's `subagents/` transcript by `toolUseId`.

**Costs:**
- Cheap and complete for visibility.
- No control over what the child is handed: the handoff is whatever text the executor put in the `Task` prompt.
- No composition, routing or Wardens on the child.
- It measures the bet but cannot act on it: Oracle could show handoffs are thin, but nothing could make them thicker.
- Codex coverage depends on Codex exposing its sub-threads **[unverified]**.

### (c) Hybrid (recommended)

**(a) for spawning, (b) as the safety net for whatever still spawns natively.**

- `foundry_delegate` is the supported way to create a subagent.
- A per-project setting `subagents.native` controls native `Task`/`Agent`:
  - `observe`: allowed, recorded as observed child runs;
  - `redirect`: a structural rule denies `tool:Task` / `tool:Agent` with the message "use foundry_delegate (kind, task)". The model reads the deny reason and retries through the tool. Optionally the launch drops `Task` with `--disallowedTools` so it is never advertised **[unverified: Claude CLI flag behaviour with the stdio permission tool]**;
  - `deny`.
- Default: `observe` until `foundry_delegate` ships, then `redirect` (open question 1).
- Host-owned children (Paseo `create_agent`, T3 `delegate_task`) stay the host's. Foundry links them when the host tells it (§6) and otherwise records them as ordinary threads.

**Why not pure (a):** native spawns will keep happening: other harness versions, Codex, a user's own setting. Each one must still leave a record, or the bet's evidence has holes.

**Why not pure (b):** watching a handoff we can't shape cannot improve it.

---

## 4. Inspectability: the parent/child run record

**Rule:** no new store. A child run is a **Thread** in the same `LocalSessionStore`. The handoff is **two phase rows** in the parent's existing `session_phase` journal, and Archive capture carries both.

### 4.1 Child thread

`ThreadMeta` gains, next to the existing `parentThreadId`:

| Field | Meaning |
|---|---|
| `parentTurnId`, `parentDispatchId` | The parent turn and dispatch that spawned it. `session_phase` is already indexed by turn and dispatch. |
| `spawn` | `{ kind, via, toolCallId, nativeTaskId? }`. `via` is `foundry`, `native-claude`, `native-codex`, `host-paseo` or `host-t3`. |
| `depth` | 1 for a child of a main thread. Bounded by a setting. |

A `foundry` child has the full middleware journal of its own: `route`, `advice`, `gate-*` and `guard-*` rows, an `InjectionArtifact` per turn, native history and usage. An observed child (`native-*`) has native history and usage only. Its rows say `observed: true`, so a query never mistakes it for a wrapped run.

### 4.2 Handoff rows (in the parent's journal)

New phase kinds in the union (`pf/agents/thread-runtime.ts:327-339`), written through `appendPhase`:

**`handoff`** is sealed **before** the child's first turn starts:
- `childThreadId`, `kind`, `role` (`subagent-<kind>`), `mode`, `model`, `effort`, `depth`;
- `task`: the exact task text and its hash;
- `composition`: per slot (instructions, domain knowledge), the child's `SourceSelectionReport`. The composition view records it as `ContextLayer.selection`: selected and omitted with reasons (`excluded-by-role`, `hidden-from-audience`, `duplicate` + `duplicateOf`). Store it with the layer hashes and the role's opt-outs and budget as configured;
- `passedDown`: what the parent's thread knowledge contributed. Per Warden domain: `revision`, `hash`, and whether it was passed in full, summarised or withheld. Also the parent correction ids that were passed (§5);
- `omittedByBudget`: anything cut to fit.

For an observed native child, `handoff` is written when the `Task` tool_use is seen. It holds the `Task` input as `task` and has `composition: null` ("the harness composed this; we did not").

**`handoff-return`** is written when the child settles:
- `childThreadId`, `outcome` (`completed`, `failed`, `cancelled` or `denied`), and the returned text (hash plus a bounded excerpt);
- the child turn ids and duration;
- `usage` (summed native usage events);
- counts of the child's `gate-*` and `guard-*` rows and their non-allow outcomes;
- the child's corrections, if any.

The child's own middleware decisions, tool calls and usage stay in the **child's** rows. The return row summarises them and points at them, so nothing is copied.

The tool gate also stops dropping `ToolRequest.agentId`. It journals it on `gate-request`, which attributes observed native children's tool calls (`pf/turns/tool-gate.ts:135-144, 181`).

### 4.3 Live view (data streams)

**Existing streams, no new ones:**
- `threads` / `threads:<projectId>` already carry `meta`. With `parentTurnId` the viewer's thread tree nests children under the turn that spawned them.
- `flow:<parent>` appends the `handoff` and `handoff-return` rows as they are written (it already streams journal rows).
- `turnFlowGraph` (`pf/viewer/ui/flow-graph.js:398`) gains a **children** node after the executor, one chip per child with its status. A click opens the child's own `flow:<child>`.
- `thread:<child>` streams the child's live activity like any thread.

**Observed native children:** agent-session tags the events (parent id on `SessionEvent`), and the stream buffer files them under a per-child group instead of merging them into the parent's text. This also fixes today's bug where child text overwrites the parent turn's content.

### 4.4 Archive and Oracle ("interrogatable")

**Archive capture** (`pf/archives/capture.ts`):
- adds `parentThreadId`, `parentTurnId` and `spawn` to the snapshot;
- `phase:<id>` events already carry the handoff rows.

**Archive's Claude import:** read `agent-<id>.meta.json` and store `parentSessionId` plus `toolUseId`, so a native transcript joins to the `handoff` row by tool call id.

**Queries this enables**, as Oracle checks over Archive documents and the journal export (`oracle layer-cycle`, `oracle mine`):

| Question | How |
|---|---|
| Which handoffs lacked context X? | `handoff` rows whose `composition` selection does not include source X, or omitted it with reason R, grouped by `kind` and role config. |
| Did the child repeat a correction the parent already had? | A correction on the child thread (or a `guard` finding) matching a correction recorded on an ancestor **before** the `handoff` and not in `passedDown.corrections`. Matching uses the miner's classifier (`oracle session-miner.ts` `classifyCorrections`). |
| Which kinds come back failed or corrected most? | `handoff-return.outcome` and the child correction counts by `kind`, `role` and opt-outs. |
| Cost of delegation | `handoff-return.usage` and duration, wrapped versus observed. |

---

## 5. Handoff context

**Default:** a `foundry` child gets the composition view for its role, `subagent-<kind>`.

- **Slots:** instructions and domain knowledge from the ladder (computer → org → org personal → project → project personal). Everything that applies is on, plus role-specific sources at each rung (`.foundry/roles/subagent-<kind>/{instructions,domainKnowledge}.md` in the preset).
- **Opt-outs:** `composition.roles["subagent-<kind>"]: { instructions: {exclude: [...]}, domainKnowledge: {...}, budget }`. This uses the composition view's own shape.
- **Role ids:** the composition agent notes that `{role}` lands in a directory name, so role ids are path-safe: `subagent-review`, not `subagent:review`.

**Thread knowledge passed down.** The parent's knowledge is per domain (`session_knowledge`, keyed by thread). The child gets:
1. the parent's current Warden thread-knowledge snapshots, by revision, as a `parent-knowledge` layer, filtered to the domains the child's route selects;
2. the parent's corrections in this thread, as the correction text. Today they are thread-visible only (`pc/adapters/file-memory.ts:541-556`), so a child cannot read them unless they are handed down;
3. the task text the parent wrote.

The parent's transcript is **not** passed, the same stance as T3 and Claude's `Task`. The parent is expected to state the task.

Each item is recorded in `handoff.passedDown`, so Oracle can compare runs with an item and without it.

**How Oracle measures sufficiency.** Per handoff, a child *insufficiency* signal is any of:
- the child asks the parent a clarifying question;
- a child correction that matches an ancestor correction (§4.4);
- a child guard finding in a domain the parent's thread knowledge covered;
- a `handoff-return` failure followed by a re-delegation of the same task.

**Sufficiency rate** = handoffs with no insufficiency signal, grouped by `kind` × role config × `passedDown` shape. Composition opt-ins and pass-down variants become Oracle experiments: the same task kinds, A versus B, judged on this rate and on cost. This is the thesis's recurrence measure, applied across the handoff.

---

## 6. ACP and hosts

**Today's surface, which works in every host:**
- A `foundry` child appears in the parent session as one `tool_call`:
  - `toolCallId: foundry-child:<childThreadId>`, `kind: "think"`;
  - `title: "Foundry: subagent <kind>"`, `rawInput: {task}`;
  - status `in_progress` → `completed` / `failed`;
  - `content`: the returned summary;
  - `_meta.foundry.child: {threadId, kind, depth}`.
- Paseo's ACP adapter and T3's generic runtime render it as a tool card. Neither reads `_meta` for subagents.
- **Today, neither host shows a generic ACP agent's children in its subagents track.** Paseo's ACP adapter has no subagent handling (`paseo:…/acp-agent.ts:3017-3069`). T3 projects subagents only through per-flavor `extractSubagentUpdate` (Grok, Devin, Copilot).

**The spec route.** ACP 1.8 has an UNSTABLE `subagent_update` session update (`SubagentUpdate`, child `sessionId`, `StateUpdate` running/idle/requires_action, opt-in `cancel`) behind a client capability `subagents`.
- Foundry would send it only to a client that advertises `clientCapabilities.subagents`, then stream the child's updates under the child's session id, which is its thread id.
- Neither Paseo nor T3 advertises it today.
- Build it when a host does. Until then, the tool card is the surface.

**Asks from a child** reach the host as `request_permission` on the parent session. They carry `_meta.foundry.childThreadId`, so the first responder can still win. The child's mode is capped at the parent's.

**When the host drives subagents itself** (Paseo `create_agent`, T3 `delegate_task`), the child is a new ACP session, so a new Foundry thread with the full middleware. Foundry cannot see the lineage unless the host sends it. Proposal: accept `_meta.foundry.parent: {sessionId, toolCallId}` on `session/new` and set `parentThreadId` / `parentTurnId` from it. No host sends it yet; a Paseo plugin or T3 flavor would. Separately, T3 instructs the executor to prefer `delegate_task`, so under `redirect` the rule should cover `mcp__t3_code__delegate_task` too (open question 6).

---

## 7. Test cases

Conventions: a real `LocalSessionStore`, a real viewer, the controlled native fixture or VCR cassettes, no mocks of Foundry internals.

1. **Delegate creates a wrapped child.** `foundry_delegate {kind: "review", task}` from a parent turn:
   - a child thread with `parentThreadId`, `parentTurnId`, `spawn.via = foundry`, `depth = 1`;
   - the child's first turn has `route` and `advice` rows and an `InjectionArtifact`;
   - the parent's journal has `handoff` before the child's first native admission, and `handoff-return` after it settles;
   - the tool result is the child's answer.
2. **Composition is the role's.** With `composition.roles["subagent-review"].instructions.exclude = ["org"]`, the child's instruction layer selection omits org with reason `excluded-by-role`. The `handoff.composition` row matches the child's `InjectionArtifact` layer hashes exactly.
3. **Pass-down is recorded.** The parent has a correction and convention thread knowledge at revision 3. The child's context contains both. `handoff.passedDown` lists the correction id and `{convention: {revision: 3, hash}}`.
4. **Redirect.** With `subagents.native = redirect`, a native `Task` tool_use is denied by the structural gate in under 100 ms with the redirect message. There is a `gate-outcome` row and no model call. A follow-up `foundry_delegate` succeeds.
5. **Observe.** With `observe`, a Claude `Task` cassette whose child events carry `parent_tool_use_id`:
   - the parent turn's text is the parent's alone;
   - an observed child thread holds the child's tool calls;
   - `handoff` has `composition: null, observed: true`;
   - `gate-request` rows for the child's tools carry `agentId`.
6. **Mode ceiling and depth.** A parent in `plan` cannot delegate an `acceptEdits` child: the child runs in `plan`, or the call is refused, as decided under open question 4. A delegate at the depth limit is refused with a reason.
7. **Live tree.** The `threads` stream nests the child under the parent turn. `flow:<parent>` appends `handoff` and then `handoff-return`. A browser test clicks the children chip and lands on the child's flow.
8. **Archive.** The capture of the parent and child carries `parentThreadId`, `parentTurnId`, `spawn` and both handoff rows. An imported native `subagents/agent-<id>.jsonl` gets `parentSessionId` and `toolUseId` from its `meta.json`.
9. **Oracle query.** Fixture: two handoffs, one passing the parent's correction and one not. The child of the second repeats the corrected mistake. The "repeated ancestor correction" check flags only the second.
10. **ACP.** Over foundry-acp:
    - a delegated child appears as a `Foundry: subagent review` tool card that completes with the summary;
    - a child's ask arrives as `request_permission` with `_meta.foundry.childThreadId`;
    - with a test client advertising `subagents`, `subagent_update` precedes the child's updates.

---

## 8. Build order (smallest useful slice first)

> **Step 1 and the lineage part of step 2 are built** (2026-10-15, docs/THREAD-TREE.md §A.8): native subagents are observed child threads with `handoff` / `handoff-return` rows and lineage in Archive. The tool gate still journals `agentId: 'artificer'`.

1. **See native subagents** (option b's half, useful with no other change):
   - agent-session: `parentToolUseId` / `agentId` on normalized events (published through the agentic train);
   - `projectNative` keeps them;
   - the stream buffer groups child activity and stops the parent-text overwrite;
   - observed child threads plus `handoff` / `handoff-return` rows for `Task`;
   - the gate journals `agentId`.

   Tests 5 and 7 (observe part).
2. **Record lineage everywhere:** `ThreadMeta` fields, Archive capture fields, Archive reading `meta.json`. Test 8.
3. **`foundry_delegate`:**
   - child threads on `TurnService`;
   - role `subagent-<kind>` from the composition view, once that lands;
   - pass-down;
   - the mode ceiling and depth limit;
   - wait mode only.

   Tests 1, 2, 3 and 6.
4. **`subagents.native` setting with `redirect`.** Test 4.
5. **Viewer children chip and live nesting.** Test 7.
6. **Oracle checks:** the sufficiency rate and the repeated-ancestor-correction check. Test 9.
7. **ACP surfacing:** the tool card, then `subagent_update` once a host advertises it. Test 10.

Later: async delegation with a mailbox (T3-style), Codex native sub-threads once their shape is verified, host lineage via `_meta`.

---

## 9. Open questions for Aron

1. **Native `Task` default once `foundry_delegate` exists:** `redirect` (wrapped by default; the model is told to use our tool) or `observe` (the native UX is kept; we only record)?
2. **Pass-down default:** the parent's Warden thread knowledge for the routed domains plus its corrections, and never the transcript. Is that the right starting point, or should corrections stay withheld so Oracle can measure their absence first?
3. **Child corrections:** should a correction given on a child also count on the parent (it is the parent's handoff that was thin), or only on the child?
4. **Mode ceiling:** should a child that asks for broader access than its parent be **capped** (silently run at the parent's mode) or **refused**? T3 refuses broader modes; Paseo inherits.
5. **Depth limit:** 1 (children cannot delegate) to start, or 2?
6. **Host delegation tools under `redirect`:** should `redirect` also cover T3 `delegate_task` and Paseo `create_agent`, which T3's own instructions push the executor toward? Or are host-owned children fine as linked-if-told siblings?
7. **Role id format:** `subagent-<kind>` (path-safe, as the composition view needs) instead of `subagent:<kind>`. OK?
8. **Kinds:** a fixed set from settings (e.g. `review`, `explore`, `implement`, each with its own role sources), or free-form kinds that fall back to a generic `subagent` role?
