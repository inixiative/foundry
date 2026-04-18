# Harness Lifecycle — Thread, Session, Process, Message

> **Status: target architecture + migration plan.** Parts are already on disk (the `HarnessSession` interface, the long-lived `ClaudeCodeSession` with validated stream-json wire format). Other parts are still ahead of the code — the message tree, the three-hook injection surface, archive/restore, warm-pool management, and thread integration. Each section below marks current-vs-target where they diverge. The Pick-Up Plan at the end is the ground truth for what actually lands when.
>
> How Foundry wraps an agent runtime (Claude Code, Codex, Cursor, or a bare API)
> as a long-lived, introspectable, resumable unit of work.

Foundry is a harness. A harness is not a prompt wrapper. The minimum contract:

1. Own the conversation structure (tree, branching, revert).
2. Capture every emission from the underlying runtime — tool calls, results, thinking, hooks, final output — not just the final text.
3. Track the runtime's session identity on every branch; Foundry is the source of truth, the runtime is the mirror.
4. Own process lifecycle: start, resume, fork, archive, restore, terminate.

Until these hold, Foundry is a shim. FLOW.md (Cartographer, Librarians, Herald, guards) is what you build *on top of* this substrate — it cannot compensate for the substrate missing.

---

## Why This Exists

The initial `ClaudeCodeProvider` treated the CLI as a stateless completion API: spawn `claude -p "…"`, parse the final result, let the process die. Every message paid full CLI startup cost. Every tool call, tool result, and intermediate reasoning step was discarded. There was no artifact for Oracle to evaluate, no conversation tree for revert or fork, no way to distinguish "the agent thought about X" from "the agent actually did X."

This document defines the primitives that replace that model.

---

## The Four Primitives

Each is independently controllable. Lifecycles are decoupled.

### Thread — the orchestration container

The Foundry object. Owns:

- Context layers (docs, convention, memory, architecture, `__thread-state`)
- Middleware (FlowOrchestrator, Cartographer, Domain Librarians, Herald, guards)
- Worktree association
- Signals, trust, injection ledger
- Exactly one executor Session

A Thread outlives restarts of its Session's process. It survives executor swaps (move from Claude Code to Codex without rebuilding the Thread). It owns everything the Session shouldn't know about.

**All middleware calls live at the Thread layer**, not the Session layer. When Cartographer classifies a message or a guard evaluates a tool call, those are stateless `LLMProvider.complete()` calls issued by Thread middleware. They are not Sessions.

### Session — the conversation substrate

Lives *inside* a Thread. Owns:

- The message tree (branching conversation, not a flat list) — **target**
- The event log (every emission from the runtime, classified) — current
- The artifact (full record for Oracle evaluation) — current
- The `session_id` pinned per branch (sync handle to the runtime) — **target** (current: one active sessionId on the Session)

A Session is provider-agnostic. It may or may not have a `HarnessProcess` backing it — if the executor is Claude Code, yes; if it's a stateless API, no. Either way, the Session's interface (messages, events, fork, artifact) is the same.

**Current state on disk**: `HarnessSession` is a flat event log with one active `sessionId`. The tree model (`Message` nodes with parent pointers, per-branch `session_id` pinning) is the migration target, not yet implemented.

### HarnessProcess — the swappable backend

The subprocess wrapper. Present only when the executor is a wrapped runtime. Owns:

- Process spawn / kill / resume
- stdin / stdout pipes
- Session-ID discovery from the runtime
- Crash recovery

For API-backed executors this primitive is absent. The Session dispatches via `LLMProvider` instead.

### Message — one turn, immutable once sealed

Owns:

- Role, content
- Parent pointer (anchors it in the tree)
- Event stream captured during the turn
- Token usage
- The `session_id` it was produced under

Once sealed, a Message is append-only. Fork creates a sibling (same parent, new branch), not a mutation.

---

## Lifecycles

Each primitive has an independent state machine. Transitions in one do not cascade except where explicit.

### Thread

```
created → active → idle → archived
                      ↘         ↓
                       ← restored
```

- **created** — instantiated, context layers attached, executor Session spawned warm.
- **active** — at least one in-flight or recent message.
- **idle** — no activity for some window. Process may still be warm (LRU policy).
- **archived** — artifact persisted to Foundry's durable store. Process killed. Tree retained.
- **restored** — re-spawned from archive. Returns to active on next interaction.

### Session

```
open → sealed
  ↑       ↓
   ← reopened (on restore)
```

- **open** — accepting messages, events streaming in.
- **sealed** — thread archived; session no longer accepts new messages but its artifact is queryable.
- **reopened** — sealed session restored; fresh process attached, event log rehydrated, new messages append to the same tree.

### HarnessProcess

```
spawned → ready → dispatching → quiesced → killed
                ↑            ↓
                 ← completed ←
```

- **spawned** — `Bun.spawn` returned a handle.
- **ready** — background stdout reader running, waiting for work.
- **dispatching** — a turn is in-flight.
- **quiesced** — idle, stdin open, no turn running.
- **killed** — process exited; session may still exist in archive.

### Message

```
pending → inflight → complete
                  ↘
                    failed
```

Forking a message = creating a sibling with the same parent. The original stays `complete`; the new branch starts from `pending`.

---

## Foundry as Source of Truth

Both Foundry and the runtime (Claude Code's `~/.claude/projects/`) maintain state. They must be kept in sync. **Foundry is authoritative.**

- **Foundry owns:** tree structure, classification, signals, cross-thread metadata, artifact, the archive.
- **Claude Code owns:** session tape — what literally went over the wire, model responses, its own turn state.
- **Sync point:** `session_id` per branch. Each tree node carries the runtime's session_id under which it was produced.

Fork: `--resume <base_session> --fork-session`, capture the new session_id, attach it to the new branch.

Revert: spawn a new process with `--resume` from the ancestor being kept.

Invariant: **one logical conversation (Foundry's tree), many physical sessions (one per branch)**. If that holds, sync is self-maintaining — you cannot fork in Foundry without spawning a new runtime session, and you cannot obtain a new runtime session_id without attaching it to a tree node.

Claude Code's `~/.claude/projects/` is a fast path for restore, not a dependency. If it's been garbage-collected, Foundry replays from its own archive.

---

## Archive and Restore

Thread close triggers archive. Archive is a durable Foundry store (DB-backed per the Foundry tech stack — Postgres).

**What's in the archive:**

- Thread metadata (id, worktree, config, creation time, close time)
- Context layer snapshots (so restore reconstructs the same working cache)
- Session: message tree, full event log, all session_ids used across branches
- Token totals, tool call counts, error counts

**Close path:**

1. Drain any in-flight turn (or cancel).
2. Seal the Session.
3. Persist artifact.
4. Kill the HarnessProcess.
5. Thread transitions `idle → archived`.

**Restore path:**

1. Read archive.
2. Rehydrate Thread (layers, config, worktree association).
3. Create a new HarnessProcess with `--resume <session_id>` for the current branch head.
4. Rehydrate Session (event log replayed into memory).
5. Re-register all middleware hooks.
6. Thread transitions `archived → active` on first new message.

A restored Session must be indistinguishable from a continuously-live one. That is the sync contract.

---

## Warm Start and Resource Management

**Cold start is a latency tax.** Spawning `claude` on first message costs hundreds of ms to seconds. Foundry removes it by spawning the HarnessProcess at Thread create time, not at first message.

But unbounded warm processes don't scale — N threads means N live `claude` processes. Policy:

- **LRU pool** with a configurable size cap. Over the cap, the least-recently-used Thread is auto-archived (process killed, artifact persisted, Thread becomes restorable).
- **Idle timeout** as a second dimension. A Thread idle for longer than the timeout is auto-archived even if under the cap.
- Both are config-driven, with sensible defaults.

Auto-archive is indistinguishable from explicit archive from the user's perspective — next interaction triggers transparent restore.

---

## Injection Channels

Three distinct hooks, matching the three Foundry→Session directions from FLOW.md:

1. **Spawn-time** (HarnessProcess only) — `--append-system-prompt` or equivalent. Stable base context: project identity, conventions, architecture. Pinned for process lifetime. Survives across `--resume`.

2. **Pre-send** — middleware wraps or prefixes the next message before it hits the Session. This is how delta-aware hydration works: Librarian computes "what's new since last injection," and the delta rides along on `send()`. Works for both HarnessProcess-backed and API-backed Sessions.

3. **Mid-turn push** — interrupts an in-flight turn (MCP channel 4). Used by guards for urgent feedback, by Herald for cross-thread signals. Best-effort; may be ignored by the model. Only some runtimes support this natively.

The Session interface exposes all three as composable hooks. Middleware registers for the channel it owns:

- FlowOrchestrator owns pre-send (delta hydration).
- Domain Librarians in guard mode own mid-turn push (critical violations).
- Spawn-time injection is set once by whoever builds the Session.

**Current vs target.** Today `HarnessSession` exposes `start / send / fork / interrupt / kill / onEvent / artifact`. Spawn-time injection works (via `baseContext` → `--append-system-prompt`). Pre-send and mid-turn hooks are not yet first-class on the interface — middleware that wants to prefix a message does it by wrapping the argument to `send()`, and mid-turn push doesn't exist. The three-hook surface is a target; the migration step is adding `onBeforeSend(handler)` and `push(payload)` (or equivalent) to `HarnessSession`, then rewiring FlowOrchestrator and the guard path onto them.

---

## Base vs Delta — What Goes Where

Spawn-time base context should be **stable across the thread's lifetime**. Per-turn delta should be **volatile or situational**.

**Base (spawn-time):**

- Project identity (name, language, architecture style)
- Conventions (persistent rules the project has accumulated)
- Architecture map (major modules, boundaries)
- Memory summaries (durable learned facts)

**Delta (per-turn):**

- `__thread-state` (what the agent is currently working on)
- Fresh memory hits (retrievals relevant to this specific message)
- Guard signals from the previous turn
- Cross-thread signals from Herald
- Anything the Cartographer routes based on the message content

Rule of thumb: if the context would be the same at message 1 and message 50 of a thread, it's base. Otherwise it's delta.

---

## Pick-Up Plan

Current state on disk:

- ✅ `providers/harness-session.ts` — interface with event taxonomy (`session_start`, `text`, `tool_use`, `tool_result`, `thinking`, `result`, `error`). Surface is `start / send / fork / interrupt / kill / onEvent / artifact` — pre-send and mid-turn-push hooks still to come.
- ✅ `providers/claude-code-session.ts` — long-lived wrapper. Spawns once with validated flags: `--print --verbose --input-format stream-json --output-format stream-json --include-hook-events`. Wire format validated empirically: `{type:"user", message:{role:"user", content:[{type:"text",text}]}}`. Background stdout reader, turn queue, `--resume` only for fork and recovery, base context via `--append-system-prompt`.
- ✅ Exports wired through barrels.

What's missing, in order:

1. ✅ **Validate the stdin wire format empirically** — done 2026-04-18. Bugs fixed: missing `--print`, missing `--verbose`, wrong payload shape (`{type:"user_message"}` → `{type:"user", message:{...}}`).
2. **Tests for the Session wrapper.** Lifecycle, fork, classification, queue ordering, interrupt, crash recovery. Mock the subprocess with a fake stdout stream emitting the real event shapes captured during wire validation.
3. **Wire into thread lifecycle.** Replace `ClaudeCodeProvider` usage in `start.ts:95` and `research/cli.ts:89`. Thread.start() spawns the Session warm; Thread.close() archives it.
4. **Reconcile `RuntimeAdapter` with `HarnessSession`.** Today there are two abstractions: `providers/runtime.ts` (file-based context injection + event subscription) and `providers/harness-session.ts` (persistent process + event capture). They overlap. Decide: either (a) `RuntimeAdapter` becomes the injection-format strategy plugged into `HarnessSession`, or (b) `RuntimeAdapter` is absorbed entirely. The Session owns the process and events; the adapter only formats injections. This must resolve before step 5 to avoid two parallel injection paths.
5. **Add pre-send and mid-turn-push hooks to `HarnessSession`.** `onBeforeSend(handler)` returns a transformed message; `push(payload)` writes an out-of-band event to stdin. Route FlowOrchestrator's delta hydration through `onBeforeSend`; route guard critical-signal feedback through `push`.
6. **Decide and implement the base-vs-delta split** per the rules above. Update the layer assembly code to tag layers as `scope: "base" | "delta"` and feed them into the right channel.
7. **Archive store** in the persistence layer. Schema for thread metadata, session tree, event log, token totals. Restore path.
8. **LRU pool + idle timeout** for warm-process management.
9. **Message-tree data model.** Introduce `Message` nodes with parent pointers. Pin `session_id` per branch. Fork produces a sibling branch; revert walks to an ancestor and spawns a new process with `--resume`. This is the load-bearing step for true "one logical conversation, many physical sessions" discipline — archive + fork only become correct once this lands.
10. **Decommission `ClaudeCodeProvider`.** Per "no backwards compat cruft" — once HarnessSession is live on every call site, the old provider is deleted.

Step 1 was the protocol blocker and is now cleared. Steps 2 → 3 get the new model onto the production path. Step 4 removes the abstraction overlap the Codex review flagged. Steps 5 → 6 deliver the composable injection surface the doc promises. Steps 7 → 9 deliver archive/restore and the tree model.

Later, not in this pick-up:

- Oracle artifact format (events are captured; what Oracle consumes is still undefined).
- CodexSession / CursorSession implementations.
