# FEAT-004: Delegation placements: primary, child or hidden, with one parent link

**Status**: 📝 Proposed (not built). Aron's 2026-11-01 answers are marked **Aron**; the rest is proposed and needs his yes.
**Assignee**: TBD
**Priority**: Medium
**Created**: 2026-11-01
**Updated**: 2026-11-01

---

## Overview

An agent hands work to another agent in three ways (Aron, 2026-11-01):

1. **Primary**: a new top-level thread, shown in the sidebar like one you started.
2. **Child**: a subagent shown under the main thread in the nav.
3. **Hidden**: work you don't want to look in on.

**Proposed: placement is an attribute of one mechanism, not three.** The parent link already exists: `ThreadMeta.parentThreadId` and `ThreadSpawn` (`packages/core/src/thread.ts:53-65`, with `via: 'host-t3' | 'host-paseo'`, `toolCallId` and `handoffId`), and `POST /api/threads` accepts `parentThreadId` (`viewer/routes/runtime.ts:738`). This ticket adds only `placement`, which decides where a thread shows:

| Placement | Sidebar / nav | Project Archive list | Parent's view |
|---|---|---|---|
| `primary` | top level, with a "spawned by" link in its Context tab | its own top-level entry | a link to it |
| `child` | nested under the parent | inside the parent's entry (the parent shows that it has children) | live child chip |
| `hidden` | not listed | inside the parent's entry, collapsed | collapsed row |

**Aron, the rule for choosing:** "if it's related to the task and part of the task, [it's] a child. Otherwise, it's a primary." Provenance on a primary is a lookup, not a hierarchy: "Maybe I can have a way to find the thread that spawned it, but plenty of things need me to do a top-level task."

**Aron, Archive:** "only the top level gets shown in the project archive… It'll show it has stuff underneath it." A primary spawned by another thread is itself top level.

## Primary threads inside a host

**Aron:** a primary thread invisible inside a host is the big problem. **Proposed:** launch it through the host. Both hosts inject their own tool server into an ACP agent's `session/new` (T3 `provider-acp/src/server/adapter.ts:652-700`; Paseo `runtime-mcp-config.ts:41-56`), and Foundry forwards a host's tool servers to the harness (`packages/acp/src/agent.ts:776`, `packages/foundry/src/providers/native-launch.ts:189`).

- **T3:** `t3_thread_launch` on the `t3-code` server (`t3:apps/server/src/mcp/toolkits/project/tools.ts:123`). Leaving `modelSelection` out inherits the caller's provider instance (`handlers.ts:184-187`), so a Foundry thread launches a Foundry thread. `workspaceStrategy: 'existing_worktree'` binds the worktree FEAT-003 made (any git worktree of the project, `handlers.ts:45-61`). Its modes cannot exceed the caller's.
- **Paseo:** `create_agent` no longer places worktrees, and an agent-scoped call never detaches (`paseo:packages/server/src/server/agent/tools/paseo-tools.ts:1717, 1737-1747`). So: `create_workspace {isolation: 'local', path: <the worktree>}` (`:1381-1393`), then `create_agent {provider: <foundry provider>/<model>, workspaceId}`. The new agent is the caller's subagent in another workspace. Paseo detaches it when the parent is archived (`agent-manager.ts:715-728`). **To check:** whether Paseo shows it as its own workspace's agent while it still has a parent.
- **Zed** has no launch tool. A primary there is visible in Foundry's viewer and the attention board only.
- **No host** (the viewer, the CLI): Foundry creates the thread itself.

In every case two things are created (**Aron**): the host's thread, and Foundry's thread wrapping it. The host starts Foundry for the new thread with `session/new`. **Proposed: linking it to the spawner.**
- **The worktree path is the key.** FEAT-003 creates a fresh worktree per launch, so the `session/new` cwd matches the pending launch exactly. This is not a guess.
- **With no fresh worktree**, a handoff id goes into the launch message through a PreToolUse `updatedInput` rewrite of the host tool call. That is the primitive agent-session already uses to tag subagent spawns (`src/claude-subagents.ts:1239-1244`). Foundry strips the id from the prompt before the harness sees it.
- **Gaps:** a Codex parent has no input rewrite, so it has only the worktree key. The host stores the raw message, so the id is visible in the host's transcript.

## What the new thread gets

- **Everything Foundry normally gives a thread:** its project's composition and chorus, on its own session.
- **The handoff brief** the parent's Wardens already wrote at the spawn (`subagent-spawn` trigger, `turns/subagents.ts`), on its first turn.
- **The pointers already delivered** in the parent (**proposed**), so the new thread's Wardens skip what was said already. Two gates first, because this changes Warden behaviour: measure the repeat-chime rate (INVENTORY §B), and pass the stage-one bar (CLAUDE.md, 2026-11-01). Aron: "have the stuff that the wardens have weighed on so that they can skip their initial stuff because of the split-off." This is the first use of the "ledger of pointers already delivered" from the thread-context proposal (CLAUDE.md, Thread context), which isn't built.
- **Not the parent's transcript.** T3 and Paseo don't pass it either. The task and the brief are the handoff.

## Results and limits

- **The spawner hears the result** (**Aron**: "yes, sure"). **Proposed:** the host's notice wins where there is one. Paseo's `notifyOnFinish` defaults to true for agent-scoped calls (`paseo-tools.ts:1215-1221`), and T3 has `t3_thread_wait`. Foundry delivers a notice only where the host has none: durable and at-least-once, as a steer into a running turn (CORE-001), or otherwise a note on the next turn. Check the signet commission (`report: 'post' | 'notify'`) before adding any other result shape.
- **An access ceiling and a fan-out limit** (**Aron**: "agreed"). A spawned thread never runs with broader access than its spawner. T3 refuses broader modes; Paseo intersects grants. Primaries spawning primaries are capped in depth and count. The values are open (SUBAGENTS.md §9 Q4, Q5).
- **Capacity:** each primary is a full session. Under a Kingdom pool, the pool picks a subscription per launch.

## Existing machinery to use

| Concern | Primitive |
|---|---|
| Parent link | `ThreadMeta.parentThreadId` and `ThreadSpawn` (`packages/core/src/thread.ts:53-65`); `POST /api/threads` `parentThreadId` (`viewer/routes/runtime.ts:738`). Only `placement` is new |
| Child threads, handoff rows | `turns/subagents.ts` (`handoff` / `handoff-return`) |
| Handoff brief | the chorus's `subagent-spawn` trigger |
| Host tools in the harness | host MCP forwarding (`packages/acp/src/agent.ts:776`; `native-launch.ts:189`, `:220` for Codex) |
| Tagging a spawn's input | PreToolUse `updatedInput` rewrite (agent-session `src/claude-subagents.ts:1239-1244`) |
| Finish notices | the host's own (Paseo `notifyOnFinish`, T3 `t3_thread_wait`) first |
| Worktree | FEAT-003 |
| Result to a running turn | CORE-001 steer; `queued` turns otherwise |
| Result contract | signet `threadCommissionSchema` (`report: post | notify`) |
| Archive tree | per-node snapshots with `lineage` (THREAD-TREE spec A) |

## Open

- Whether T3's and Paseo's launch tools accept every Foundry option we need (effort, Foundry's own modes). Both were checked for provider, worktree and parent link only.
- The ceiling values: capped or refused, depth 1 or 2 (SUBAGENTS.md §9).

## Acceptance

- [ ] In T3, a primary launch creates a T3 sidebar thread running Foundry, in the FEAT-003 worktree. Its Foundry thread has `spawn.via = host-t3`, placement `primary` and the spawner's `parentThreadId`.
- [ ] The same in Paseo through `create_workspace` and `create_agent {workspaceId}`.
- [ ] The worktree path links the new session to its spawner. Without a fresh worktree, the handoff id does, and it never reaches the harness's transcript.
- [ ] The new thread's first turn carries the handoff brief. The delivered-pointer list ships only after its repeat-chime measurement and the stage-one bar.
- [ ] The spawner gets one finish notice: the host's where it sends one, Foundry's otherwise, after a Foundry restart in between.
- [ ] A launch asking for broader access than the spawner is held to the spawner's.
- [ ] The project Archive lists the primary as a top-level entry, and the spawner shows a link to it.

## Related

Oracle `docs/foundry/reference/SUBAGENTS.md` §0 and §9; COMPARISON §0.3 Q2 (resolved 2026-11-01); CORE-001; FEAT-003.
