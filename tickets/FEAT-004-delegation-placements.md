# FEAT-004: Delegation placements: primary, child or hidden, with one parent link

**Status**: 📝 Proposed (not built). Shape agreed with Aron 2026-11-01.
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

**Placement is an attribute of one mechanism, not three mechanisms.** Every spawned thread records its parent: `parentThreadId`, `parentTurnId` and `spawn` (Oracle SUBAGENTS.md §4.1). Placement decides only where it shows:

| Placement | Sidebar / nav | Project Archive list | Parent's view |
|---|---|---|---|
| `primary` | top level, with a "spawned by" link in its Context tab | its own top-level entry | a link to it |
| `child` | nested under the parent | inside the parent's entry (the parent shows that it has children) | live child chip |
| `hidden` | not listed | inside the parent's entry, collapsed | collapsed row |

**The rule for choosing (Aron):** "if it's related to the task and part of the task, [it's] a child. Otherwise, it's a primary." Provenance on a primary is a lookup, not a hierarchy: "Maybe I can have a way to find the thread that spawned it, but plenty of things need me to do a top-level task."

**Archive (Aron):** "only the top level gets shown in the project archive… It'll show it has stuff underneath it." A primary spawned by another thread is itself top level.

## Primary threads inside a host

A primary thread must show up in the host's own sidebar, or it is invisible to anyone working in T3 or Paseo. Both hosts already give their ACP agent a tool server with a launch tool, and Foundry already passes a host's tool servers through to the harness (`packages/foundry/src/providers/native-launch.ts:184`, `session-adapter.ts:242`). So a primary launch inside a host goes through the host:

- **T3:** `t3_thread_launch` on the `t3-code` server (`t3:apps/server/src/mcp/toolkits/project/tools.ts:123`). Leaving `modelSelection` out inherits the caller's provider instance, so a Foundry thread launches a Foundry thread. `workspaceStrategy: 'existing_worktree'` binds the worktree FEAT-003 made. Its modes cannot exceed the caller's.
- **Paseo:** `create_agent` on the `paseo` server (`paseo:packages/server/src/server/agent/tools/paseo-tools.ts`), with `provider: <foundry provider>/<model>`, `cwd` and `detached: true` for a primary. Paseo stamps `paseo.parent-agent-id` unless the agent is detached.
- **Zed** has no launch tool. A primary there is visible in Foundry's viewer and the attention board only.
- **No host** (the viewer, the CLI): Foundry creates the thread itself.

In every case two things are created: the host's thread, and Foundry's thread wrapping it. The host starts Foundry for the new thread with `session/new`. Foundry links that session to its spawner with a **handoff id** that it puts on the first line of the launch message and strips before the harness sees it. Foundry controls both ends, so this works in any host without host changes. It needs no clock or cwd guess, which would be a fallback for a case we don't have.

## What the new thread gets

- **Everything Foundry normally gives a thread:** its project's composition and chorus, on its own session.
- **The handoff brief** the parent's Wardens already wrote at the spawn (`subagent-spawn` trigger, `turns/subagents.ts`), on its first turn.
- **The pointers already delivered** in the parent, so the new thread's Wardens skip what was said already. Aron: "have the stuff that the wardens have weighed on so that they can skip their initial stuff because of the split-off." This is the first use of the "ledger of pointers already delivered" from the thread-context proposal (CLAUDE.md, Thread context), which isn't built.
- **Not the parent's transcript.** T3 and Paseo don't pass it either. The task and the brief are the handoff.

## Results and limits

- **The spawner hears the result** (Aron: "yes, sure"). The finish is durable and at-least-once, as Paseo's finish subscriptions are. It reaches a running parent turn as a steer (CORE-001), or is otherwise a note on its next turn. A child's question reaches the parent the same way (T3 `DelegatedTaskQuestionReactor`). This is the signet commission's `report: 'post' | 'notify'` applied to an agent's own spawn. Check that contract before adding any other result shape.
- **An access ceiling and a fan-out limit** (Aron: "agreed"). A spawned thread never runs with broader access than its spawner. T3 refuses broader modes; Paseo intersects grants. Primaries spawning primaries are capped in depth and count. The values are open (SUBAGENTS.md §9 Q4, Q5).
- **Capacity:** each primary is a full session. Under a Kingdom pool, the pool picks a subscription per launch.

## Existing machinery to use

| Concern | Primitive |
|---|---|
| Parent link | `ThreadMeta.parentThreadId` (`packages/core/src/thread.ts`), extended per SUBAGENTS.md §4.1 |
| Child threads, handoff rows | `turns/subagents.ts` (`handoff` / `handoff-return`) |
| Handoff brief | the chorus's `subagent-spawn` trigger |
| Host tools in the harness | host MCP forwarding (`native-launch.ts:184`, `:220` for Codex) |
| Worktree | FEAT-003 |
| Result to a running turn | CORE-001 steer; `queued` turns otherwise |
| Result contract | signet `threadCommissionSchema` (`report: post | notify`) |
| Archive tree | per-node snapshots with `lineage` (THREAD-TREE spec A) |

## Open

- Whether T3's and Paseo's launch tools accept every Foundry option we need (effort, Foundry's own modes). Both were checked for provider, worktree and parent link only.
- The ceiling values: capped or refused, depth 1 or 2 (SUBAGENTS.md §9).

## Acceptance

- [ ] In T3, a primary launch creates a T3 sidebar thread running Foundry, in the FEAT-003 worktree. Its Foundry thread has `spawn.via = host-t3`, placement `primary` and the spawner's `parentThreadId`.
- [ ] The same in Paseo with `detached: true`.
- [ ] The handoff id never reaches the harness's transcript.
- [ ] The new thread's first turn carries the handoff brief and the delivered-pointer list, and its Wardens don't repeat a pointer on that list.
- [ ] The spawner gets the finish notice exactly once, after a Foundry restart in between.
- [ ] A launch asking for broader access than the spawner is held to the spawner's.
- [ ] The project Archive lists the primary as a top-level entry, and the spawner shows a link to it.

## Related

Oracle `docs/foundry/reference/SUBAGENTS.md` §0 and §9; COMPARISON §0.3 Q2 (resolved 2026-11-01); CORE-001; FEAT-003.
