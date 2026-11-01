# FEAT-004: Delegated threads are top-level, with provenance

**Status**: 📝 Proposed (not built). Aron's 2026-11-01 answers are marked **Aron**; the rest is proposed and needs his yes.
**Assignee**: TBD
**Priority**: Medium
**Created**: 2026-11-01
**Updated**: 2026-11-01

---

## Overview

**Aron: a thread an agent hands work to is a top-level thread.** "Even if it's really dedicated, let's just have it be top-level. That way, there are just mostly top-level things. When you expand things, it's for subagents." Nesting a delegated thread under its spawner is dropped: "the concept is a mess." The attention board shows what's active, all top level.

So there are two things, not three placements:

| | What it is | Where it shows | Link to its source |
|---|---|---|---|
| **Thread** | A first-class thread, whoever started it: you, or an agent in another thread | Top level: the sidebar, the attention board and the project Archive list | **Provenance only**: "spawned from <thread>", a lookup in its Context tab. Aron: "it's mostly just an attribution and provenance thing" |
| **Subagent** | Work inside a thread's own session (Claude Agent/Task, Codex sub-agents, later `foundry_delegate`) | Nested under its thread, expanded on demand | Part of the thread's tree (`handoff` / `handoff-return` rows) |

- **Aron, Archive:** "only the top level gets shown in the project archive… It'll show it has stuff underneath it." What's underneath is subagents. A spawned thread is its own top-level entry.
- **Aron, depth:** threads can go arbitrarily deep; nesting is bookkeeping, "almost like a linked list". "Subagents are already normally limited" by the harness, so Foundry enforces no depth limit. Threads are flat (provenance only).
- **Hidden work** (Aron's third kind, work he won't look in on) is a subagent, collapsed by default. **Proposed**, since this reading of his "there's only top-level" isn't confirmed.

**The provenance link already exists:** `ThreadMeta.parentThreadId` and `ThreadSpawn` (`packages/core/src/thread.ts:53-65`, `via: 'foundry' | 'native-claude' | 'native-codex' | 'host-paseo' | 'host-t3'`, `toolCallId`, `handoffId`). `POST /api/threads` accepts `parentThreadId` (`viewer/routes/runtime.ts:738`). **Proposed:** for a top-level thread these fields mean provenance.
- **One new `via` value, `launch`**, for a thread an agent launched top-level with no host. `'foundry'` stays for `foundry_delegate` subagents, so the two are never confused. Nothing sets `'foundry'` today.
- **The viewer** (`thread-tree.js:147-158`, which nests by `parentThreadId` alone today) nests only subagents: `via` `native-*` or `foundry`.
- **Archive capture** (`archives/capture.ts:71-95`, `lineageOf`) turns any `parentThreadId` into `lineage.kind: 'subagent'` with a `rootSessionId`, and Archive groups by root (`archive/src/parts.ts:95`). For a top-level thread it must send provenance only, with no subagent lineage and no root grouping. That is a capture change, and it may need an Archive lineage kind (Archive has `subagent | fork | part`, `archive/src/index.ts:50`).
- The `ThreadMeta` doc comments ("Parent thread when this thread is a subagent") are updated to say this.

## Access

**Aron:** a spawned thread "has its own access needs, and it should still ask for access." It is granted one of three ways:
1. **Fresh** (the default): the thread starts with no grants beyond what any new thread in that project has, and asks for what it needs.
2. **Granted by the instructions:** the spawner's instructions name specific access, and the thread gets exactly that.
3. **Carried over:** the instructions say to carry over the spawner's access, and the thread gets the spawner's.

**Aron (11-01): "each thread just spawns w/ the access agreed to or default."** No ceiling tied to the spawner. The grant is whatever was agreed for the thread, or the default. **Proposed:** the choice and what was granted are recorded on the spawn, so the Context tab shows where each grant came from. In a host, the host's own mode rules still apply: T3 refuses a launch broader than the caller's modes.

## Inside a host

**Aron:** a top-level thread invisible inside a host is the big problem, and two things are created: the host's thread and Foundry's wrapper. **Proposed:** launch it through the host's own tool. Both hosts inject their tool server into an ACP agent's `session/new` (T3 `provider-acp/src/server/adapter.ts:652-700`; Paseo `runtime-mcp-config.ts:41-56`), and Foundry forwards it to the harness (`packages/acp/src/agent.ts:776`, `packages/foundry/src/providers/native-launch.ts:189`).

- **T3:** `t3_thread_launch` (`t3:apps/server/src/mcp/toolkits/project/tools.ts:123`) makes an ordinary top-level thread, which is exactly this model. Leaving `modelSelection` out inherits the caller's provider instance (`handlers.ts:184-187`). `workspaceStrategy: 'existing_worktree'` binds the FEAT-003 worktree (`handlers.ts:45-61`).
- **Paseo:** `create_agent` no longer places worktrees and never detaches an agent-scoped call (`paseo:packages/server/src/server/agent/tools/paseo-tools.ts:1717, 1737-1747`). So: `create_workspace {isolation: 'local', path}` (`:1381-1393`), then `create_agent {workspaceId}`. Paseo will record it as the caller's subagent in another workspace. That conflicts with "top-level only", so Paseo's display needs checking: does a cross-workspace child show in its own workspace's list?
- **Zed** has no launch tool: the viewer and attention board only.
- **No host:** Foundry creates the thread itself.

**Linking the new session to its source:** the FEAT-003 worktree path is unique per launch, so the `session/new` cwd matches the pending launch exactly. Without a fresh worktree, a handoff id goes into the launch message through a PreToolUse `updatedInput` rewrite (agent-session `src/claude-subagents.ts:1239-1244`), and Foundry strips it from the prompt. Gaps: no input rewrite for a Codex spawner, and the host's transcript keeps the id.

## What the new thread gets

- Everything Foundry gives any thread in its project.
- The handoff brief the spawner's Wardens wrote (`subagent-spawn` trigger).
- **Proposed:** the pointers already delivered in the spawner, so its Wardens skip them (**Aron**: "have the stuff that the wardens have weighed on so that they can skip their initial stuff"). It ships only after the repeat-chime measurement (INVENTORY §B) and the stage-one bar (CLAUDE.md, 2026-11-01).
- Not the spawner's transcript.

## Results

**Aron:** the spawner hears the result. **Proposed:** the host's notice wins where there is one (Paseo `notifyOnFinish`, default true, `paseo-tools.ts:1215-1221`; T3 `t3_thread_wait`). Otherwise Foundry delivers it, durable and at-least-once, as a steer into a running turn (CORE-001) or a note on the next turn. Check the signet commission (`report: 'post' | 'notify'`) before adding another result shape.

## Existing machinery to use

| Concern | Primitive |
|---|---|
| Provenance | `ThreadMeta.parentThreadId`, `ThreadSpawn` (`packages/core/src/thread.ts:53-65`); `POST /api/threads` (`viewer/routes/runtime.ts:738`); new `via: 'launch'` |
| Archive | `archives/capture.ts` `lineageOf` (changed: provenance, not `subagent` lineage, for top-level threads) |
| Subagent nesting | `turns/subagents.ts`; the viewer thread tree (`thread-tree.js`) |
| Handoff brief | the chorus's `subagent-spawn` trigger |
| Host tools in the harness | `packages/acp/src/agent.ts:776`; `native-launch.ts:189`, `:220` (Codex) |
| Tagging a spawn's input | PreToolUse `updatedInput` (agent-session `src/claude-subagents.ts:1239-1244`) |
| Worktree | FEAT-003 |
| Results | host notices first; CORE-001 steer; `queued` turns |
| Access | the project's permission and mode settings; Kingdom Signets for anything beyond the machine |

## Acceptance

- [ ] A thread an agent spawns is top-level in the sidebar, the attention board and the project Archive, with "spawned from" in its Context tab.
- [ ] The viewer nests only subagents.
- [ ] Archive capture of a spawned top-level thread carries provenance and no `subagent` lineage, so it is its own top-level Archive entry.
- [ ] A spawn with no access instructions starts fresh and asks. One with named access gets exactly that. One told to carry over gets the spawner's grants. Each case is recorded on the spawn.
- [ ] In T3, the launch creates a T3 sidebar thread running Foundry in the FEAT-003 worktree, linked to its source by the worktree path.
- [ ] In Paseo, the same through `create_workspace` and `create_agent`, once its display is checked.
- [ ] The spawner gets one finish notice, after a Foundry restart in between.

## Related

Oracle `docs/foundry/reference/SUBAGENTS.md` §0; COMPARISON §0.3 Q2; CORE-001; FEAT-003.
