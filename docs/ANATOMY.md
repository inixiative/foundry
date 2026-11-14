# Foundry anatomy

One sheet naming every part of Foundry, so people and agents use the same words. Each term says what the part is and why it exists, where it lives, and its status. Detail lives in the linked docs; this page only names things and points.

**Status key** (checked against the code on 2026-11-01, not only the docs):

- **live**: runs by default. Chorus parts marked live run on every thread whose project's chorus is on; the chorus itself is opt-in per project.
- **off**: built, but off until a setting turns it on, or present in code with nothing wiring it in.
- **proposed**: designed or ticketed, not built.
- **retired**: removed; never reintroduce the word or the thing (see [Retired words](#retired-words)).

`pf/` is `packages/foundry/src/`, `pc/` is `packages/core/src/`, `pa/` is `packages/acp/src/`.

## How the parts connect

```
 ACP host (Zed, Paseo, T3)        viewer :4500 (rail | centre | right panel)
          │ foundry-acp (stdio)            │ HTTP + /ws data streams
          └──────────────┬─────────────────┘
                         ▼
 ┌──────────────────────── Foundry daemon ─────────────────────────────────────┐
 │  TurnService ─► thread (wrapper: conversation, floor, members)              │
 │                   │                                                         │
 │   composition ladder ─► layers ─► executor = main thread (Artificer) ─► tool gate
 │   (CLAUDE.md, role files,           │ native session via agent-session     │
 │    region knowledge)                ├─ subagents (observed threads = nodes) │
 │                                     │                                       │
 │   chorus: one region Warden per region, asked at every trigger              │
 │     user-message ─► advice    consumed ─► advice    subagent-spawn ─► brief │
 │     agent-action ─► guard     after the turn ─► review (writes thread knowledge)
 │     each Warden: stage(s) under a charter ─► NO_COMMENT | pointer           │
 │     chime ─► main thread, read under the reception charter                  │
 │                                                                             │
 │   decision runtime: decision host ─► primed pool (Haiku, low) ─ scheduler   │
 │   other roles: Cartographer (routing), Librarian (thread state),            │
 │                feedback lifecycle, Forge Master and Feedback scopes         │
 │   journal ─► Archive capture (one session per node, Warden calls reduced)   │
 └───────────────┬─────────────────────────────────────────────────────────────┘
                 │ Installation socket, Signets (enrolled keys)
                 ▼
   Kingdom: pairing, Signets, member relay, subscription pools ── hosted Archive
   Oracle: replays real work against Foundry and measures whether help lands
```

## The packages

| Term | What and why | Where | Status |
|---|---|---|---|
| foundry-core | Engine primitives with no runner and no I/O policy (Thread, Harness, ContextLayer/Stack, MiddlewareChain, SignalBus, capability gate), so the harness logic is reusable alone. MIT. | `packages/core` (`@inixiative/foundry-core`) | live |
| Foundry | The harness and the app: daemon, turns, middleware, viewer, persistence, Kingdom pairing, Archive capture. BSL 1.1. | `packages/foundry` (`@inixiative/foundry`) | live |
| foundry-acp | A thin stdio ACP agent that maps ACP sessions onto Foundry threads through the daemon's loopback API, so any ACP host drives the same turn path as the viewer. MIT. | `packages/acp`; [FOUNDRY-ACP.md](reference/FOUNDRY-ACP.md) | live |
| agent-session | The separate package that runs native Claude Code, Codex and Muse Code sessions and primed decision sessions. Foundry never launches a CLI itself. | `@inixiative/agent-session` | live |

## The thread and its tree

| Term | What and why | Where | Status |
|---|---|---|---|
| thread | One line of work: its stack, agents, journal and turns. Its id is also its ACP `sessionId` and its Archive session id. | `pc/thread.ts`, `pf/agents/thread-runtime.ts` | live |
| main thread | The thread the user talks to. Its executor is the only agent that does the work. | | live |
| Artificer / executor | The native Claude Code (or Codex, or Muse Code) session running as the main thread's executor. "Artificer" is the role name in [FLOW.md](FLOW.md); code says `executor`. | `pf/providers/session-adapter.ts`, `session-backed.ts` | live |
| worker | The subscription harness a thread's main session runs on: `claude-code`, `codex` or `muse` (Muse Code, on the user's own Muse login; main threads only, never decisions). Set when the thread is created; a project has a default. | `ThreadMeta.worker`, `SUBSCRIPTION_WORKERS` (`pf/models/registry.ts`) | live |
| turn | One message and the work it starts. A turn accepted while the thread is busy is `queued`, not `active`, so restart recovery drops it rather than marking it interrupted. | `pf/turns/turn-service.ts` (`TurnService`, per-thread `SerializedQueue`) | live |
| unwrapped / wrapped thread | A thread with no layer, classifier, router, Warden or conversation is unwrapped: the message reaches the native session as typed, with no Cartographer call or thread state. A fresh install's threads are unwrapped. | `wrapsThread`, `pf/agents/thread-runtime.ts` | live |
| project / global scope | A registered repository a thread works in; its chorus, settings cascade and capacity hang off it. A cwd outside every project uses the global (unscoped) scope and is never refused. | `projects` in settings; `.foundry/project.json` in the repo | live |
| thread tree | A main thread is the root of a tree of nodes, each archived as its own Archive session linked to its parent. | [THREAD-TREE.md](THREAD-TREE.md) spec A | live |
| node | One conversation in the tree: the main thread or a subagent at any depth. A middleware call is never a node. | spec A | live |
| subagent | A child the agent spawns (Claude `Agent`/`Task`, a Codex sub-agent). `task_started` makes it an observed thread on its own node and fires the `subagent-spawn` trigger. Work you want done without a voice in the thread is a subagent. | `pf/turns/subagents.ts` | live |
| member | A second party in a thread: `owner`, `local` (an in-process agent, your own Codex included) or `signet` (remote, through Kingdom). Not "participant", which the flow orchestrator uses for a Warden contribution. | `ConversationMember` (`@inixiative/signet`), `pf/conversations/` | live (local members per thread: proposed, BOARD-001 slice 2a) |
| reduced entry | A Warden or Cartographer call stored in the node it wrapped as its state and result (`middleware-reduced` row), never the message it received, so Archive does not hold every Warden's input per turn. | spec A, `pf/persistence/` | live |
| journal | The local, append-only record of every turn, phase row and middleware call; the source for the viewer, the Archive capture and Oracle. | `pf/persistence/local-session-store.ts` | live |
| Archive capture | Foundry writes each node's snapshot to the machine's local Archive, which syncs onward. Foundry keeps no archive store of its own. | `pf/archives/`; [session-archives.md](session-archives.md) | live |
| tool gate | Structural `toolRules`: the only thing that can deny a tool call, in every permission mode. Wardens never block. | `pf/turns/tool-gate.ts`, `toolRules` | live |

## Context composition

| Term | What and why | Where | Status |
|---|---|---|---|
| ladder / levels | One ordered stack composes every role's context: computer (personal) → org → org personal → project → project personal. The more specific level wins. | [usage-and-context.md](usage-and-context.md) "Standing instructions" | live |
| default ladder (`claude-code` preset) | With nothing configured, the nodes are Claude Code's own discovery: `managed`, `global`, `org`, `project`, `local` (`CLAUDE.local.md`), `memory` (auto memory). | `pf/prompts/instruction-settings.ts` | live |
| node | One rung of the ladder: a scope, shared or personal, its files and its tier. `composition.nodes` registers more. | `composition.nodes`; core `discoverHierarchy` (`pc/adapters/markdown-hierarchy.ts`) | live |
| corpus tier | Who a file may reach: `personal_private`, `team`, `org`. Personal files never reach a team or org audience. | `VISIBLE_TO` rules in core | live |
| audience | The tier a role composes for (`composition.roles.<role>.audience`, default `personal_private`). | | live |
| CLAUDE.md composition | Foundry composes `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, rules and auto memory itself, resolving `@path` imports as Claude Code does, for any harness. The `instructions` source on the `instructions` layer. | `pf/prompts/instruction-stack.ts`, `claudemdSource` | off (a fresh install composes nothing; add an `instructions` source) |
| harnessSettings | Whether a main thread's Claude loads the user's own settings, commands, skills, agents, plugins and hooks (`load`, default) or none (`off`). Project settings only inside a registered project; credentials in them never replace the subscription login. | `composition.harnessSettings`, `pf/providers/harness-settings.ts` | live |
| harnessLoading | Whether the harness also loads those files (`load`) or Foundry suppresses them (`suppress`), so there is one injection path. Defaults to `suppress` when every view composes instructions. | `composition.harnessLoading` | live |
| composition view | Roles × slots × ladder nodes: every model-backed role composes each slot from the same ladder; a role opts out of nodes, never in. | `composition.roles` | live |
| role | Who a composition is for: `main`, each Warden (its region id), the Cartographer. | | live |
| slot | `instructions` (the system prompt) and `domainKnowledge` (what the role primes with). Thread knowledge is not a slot. | | live |
| role file | `.foundry/roles/<role>/<slot>.md` (and `.local.md`) at any rung, e.g. the org's instructions for one Warden. | | live |
| dedupe | Same file, identical content and identical sections are removed, keeping the most specific copy; every removal is reported in the layer's Selection panel. | `composition.dedupe` | live |
| role budget | Characters a middleware role may compose (`DEFAULT_ROLE_BUDGET`, 120,000). Over budget the phase does not run and nothing is truncated. `DECISION_INPUT_CAP` (160,000) is the backstop. | `pf/providers/decision-budget.ts` | live |
| context layer / stack | A managed context cache (`cold → warming → warm → stale`) and the stack that assembles layers under a token budget. | `pc/context-layer.ts`, `pc/context-stack.ts` | live |
| thread state | A compact always-warm summary of the thread, written only by the Librarian and read by every middleware role. | Librarian layer | live (on a wrapped thread) |
| thread knowledge | A Warden's own notes about this thread (`thread-knowledge:<domain>`), written by its post-work review and read on its next call. | `pf/agents/domain-librarian.ts` | live |
| shared running summary | One thread summary compacted per turn and read by every Warden, plus a ledger of pointers already delivered so repeats are suppressed. | | proposed |

## The chorus

| Term | What and why | Where | Status |
|---|---|---|---|
| chorus | A project's set of Wardens, one per region, all asked at every trigger. Per project because its docs are. Opt-in: `chorus.enabled` in the machine's settings or the repo's `.foundry/project.json`. | `projects[id].chorus`; `pf/agents/region-roster.ts` | off (per project; a repo may commit it on) |
| chorus layer | One regions directory in a chorus (not Layer 1 / Layer 2, which are classification steps); several layers compose (a later layer's region replaces an earlier one whole), e.g. a template base then a project's delta. | `chorus.layers` | live |
| Warden | A narrow context router for one region. It answers only "is this moment mine, and where is it written?" with `NO_COMMENT` or a pointer; it never blocks or decides. Fresh each call, never a continuing conversation. Code calls it a domain librarian. | `pf/agents/domain-librarian.ts` (`DomainLibrarian`, kind `domain-librarian`) | live |
| region | A concept shard of the project's docs and code, sized for one Warden to hold well. | `<project>/.foundry/regions/<region id>/` | live |
| `region.json` | A region's id, title, routing line, concepts, sources, size and `role` (`warden` default, or `herald`). Holds no stages or charter. | | live |
| `knowledge.md` | The region's full catalogue: what it covers, every example by name, the specifics. The default stage reads it. | `KNOWLEDGE_DOC`, `pf/classify/stages.ts` | live |
| `recognise.md` | A short description of the region for a recognising stage: purpose, the problems it covers in plain words, when it is not its domain. Any stage may name another `<doc>.md`. | | off (no default stage reads it) |
| corpus files | `registry.json`, `GLOSSARY.md`, `ERRORS.md`, `ECOSYSTEM.md` beside the regions; composed into no Warden. | `.foundry/regions/` | live |
| region key | The content hash of a region's composed knowledge, so identical base regions across projects could share a warm prefix. The sharing is not built; the key is journalled. | `regionKey` | live (sharing: proposed) |
| charter / point charter | The fixed meta-instructions every pointing Warden runs under: scope discipline, `NO_COMMENT` by default, the pointer shapes, and "an instruction to build something new is a reason to look". Foundry's, never a setting. | `WARDEN_CHARTER`, `pf/classify/charters/point.warden.ts`, sections in `charters/point/` | live |
| recognise charter | The charter for a `recognise` stage: name the regions the moment is in, one `<region id>: <why>` line each. | `RECOGNISE_CHARTER`, `charters/recognise/` | off (no default stage recognises) |
| charter sections | The charter's named prose files; an eval run may swap them, settings never can. | `pf/classify/charters/sections.ts` | live (eval only) |
| reception charter | The main thread's counterpart: how to read a chime (verify it, follow the top pointer, pick from a choose-one set, ask before overriding an existing system that the instruction did not acknowledge). Held once as the standing layer `chorus-reception`. | `CHORUS_RECEPTION`, `pf/agents/chorus-reception.ts`; `chorus.reception` | live |
| stage | One step of a Warden's classification run (at most three): who answers, which region doc it reads, what it may answer, and which outcomes go on. Same code live, in evals and in Oracle. Spoken of and shown as layers (next row). | `StageConfig`, `chorus.wardens.stages` | live (two by default) |
| Layer 1 / Layer 2 | The names for the chorus's classification stages (Aron, 2026-11-01): Layer 1 is detection (Haiku asks every region "is this mine?"), Layer 2 is the polish (Sonnet confirms Layer 1's yes and picks the primitive). The viewer shows "Layer 1 · recognise" and "Layer 2 · confirm and pick" (#218). Code keeps `stages[0]`, `stages[1]`. | `ChorusLayer`, `pf/viewer/turn-timeline.ts` | live (both, by default) |
| default stage | The two-layer chain (Aron, 2026-11-02): Layer 1 points on `knowledge.md` on the decision model and effort (Haiku 5.5, low), its why `inline`, escalating each yes without that why (`carryWhy: false`) within a quarter of the deadline; Layer 2 points on the same `knowledge.md` on Sonnet 5.5, low. Why: Oracle finding `2026-11-01-l2-nowhy`: 93/114 recall and 34.5/1350 false yes on template's dev cells, against the 92 / 37 bar. With API-token decisions (no stage host) the default is the single stage (`SINGLE_STAGE`: one `point` stage, `binary`, reason `none`). Fields a written stage omits fill from `DEFAULT_STAGE`. | `DEFAULT_STAGES`, `defaultStages`, `pf/classify/stages.ts` | live |
| task | `recognise` (name the regions) or `point` (name the thing and where). Only a pointing stage's yes reaches the thread. | `StageTask` | live (`point`); `recognise` off |
| outcomes | `binary` (yes / NO_COMMENT) or `ternary` (adds `unsure`). | `StageOutcomes` | live (`binary`) |
| reason | `none`, `inline` (the why with every answer) or `followup` ("why?" asked after a yes or unsure). | `StageReason` | live (`inline` on Layer 1, `none` on Layer 2) |
| escalate | The outcomes of a non-final stage that go on to the next, carrying their why. | `StageConfig.escalate` | live (`yes`) |
| carryWhy | Whether a non-final stage hands its why on with its outcome; false hands the outcome alone. | `StageConfig.carryWhy` | live (false in the default chain: Sonnet judges without Haiku's argument; true when omitted) |
| deadline share | A stage's share of its trigger's deadline. | `StageConfig.deadline` | live (0.25 for Layer 1; Layer 2 has what is left) |
| two-stage chorus | Layer 1 and Layer 2 together: a cheap model asks every region, and on each yes a stronger model (Sonnet) confirms and picks. The default since 2026-11-02 (Oracle finding `2026-11-01-l2-nowhy`: 93/114 recall and 34.5/1350 false yes on template's dev cells, against the 92 / 37 bar); a project's written stages replace it. | `DEFAULT_STAGES`, `chorus.wardens.stages` | live (default) |
| phase | What a Warden is doing for its trigger: advice, guard, brief or review. Not a stage: Foundry says "phase" for these and "stage" only for classification steps. | journal phase rows | live |
| trigger | The moment a Warden is asked. Every trigger runs the same stages and only frames the input. | `TriggerPoint`, `pf/agents/warden-triggers.ts` | see rows below |
| `user-message` → advice | Every Warden, on every user message. | | live |
| `consumed` → advice | Every Warden, when the main thread takes in a work item (a ticket or spec file it reads, a Linear issue or Notion page it fetches). Rides with the next turn as notes. | `pf/agents/work-items.ts`; `chorus.consumed` | off |
| `agent-action` → guard | Once per turn when its tool activity ends, over every write, edit and command in order, for each Warden whose `guardTriggers` name one. Advisory only; never awaited, never holds the hand-back. | `guard: per-turn` (default) or `per-call`; `REGION_GUARD_TRIGGERS` | live |
| `subagent-spawn` → brief | Every Warden, on the task text handed to a subagent; journalled on the parent and delivered with its next turn. | `FlowOrchestrator.brief` | live |
| review (post-work review) | After the turn, each Warden reviews the work and writes its thread knowledge (`post-turn` in the pre-filter). | `learning.enabled` | live |
| `hand-back` | Wardens review the final message before the user sees it, one extra pass at most. | named in `warden-triggers.ts` | proposed |
| `agent-question` | A Warden answers the agent's question on the user's behalf when confident and backed by a recorded ruling. | named in `warden-triggers.ts` | proposed |
| chime | What a Warden's yes becomes in the thread: "The <region> Warden chimed in: …". A pointer, never advice text. | `pf/agents/flow-orchestrator.ts` | live |
| pointer | The parsed answer: `{ relevant, shape, pointer, where, why, level, candidates }`, at most three names, each with its doc section and one line that tells it apart. | `parseWardenPointer`, `pf/classify/pointer.ts` | live |
| ranked pointer (`one`) | `Look over here: X (where) — why`, then up to two `Less likely:` fallbacks. A class pointer is a ranked pointer at the class level. | shape `ranked` | live |
| all-of set (`all`) | `All of these: Each applies; read every one.` when the moment touches several systems at once. | shape `all` | live |
| choose-one set (`any`) | `Choose one: Related systems; pick the one whose job matches.` when close siblings can't be told apart; the main thread picks. | shape `choose-one`; `pointer.any` (on) | live |
| pointer level | How specific a pointer is: `exact`, `candidates` or `class` (the pointer ladder Oracle scores). | `PointerLevel` | live |
| `NO_COMMENT` | The default answer: exactly that string. It adds nothing to the thread and is journalled as `no-comment`, so silence is measurable. | every phase protocol | live |
| `excluded` / `not-admitted` | A Warden the queue never ran in time (advice / guard); the turn goes on without it. | | live |
| pre-filter | A local model scores, per Warden, whether a moment is in its domain and skips only confident noes; fails open and journals every skip. Superseded as policy by "ask every region, every time"; the code stays. | `prefilter`, `pf/providers/warden-prefilter.ts`, `prefilter-model.ts` | off |
| Herald | A region role for live data (what other agents and teammates are doing), beside Wardens' static knowledge. The socket exists (`chorus.heralds`, region `role: "herald"`); Herald regions never run and have no charter. | `pf/agents/herald.ts` (class, nothing constructs it) | proposed |

## The decision runtime

| Term | What and why | Where | Status |
|---|---|---|---|
| decision | One fast, tool-less model call by a middleware role (a Warden stage, the Cartographer, a classifier, naming, feedback). | `CompletionOpts` | live |
| decision model | The model decisions run on: Claude Haiku 5.5 (`claude-haiku-5-5`) at `low` effort by default; GPT-5.6 Luna with Codex decisions. | `DECISION_MODEL` (`pc/model-registry.ts`), `subscriptionOnly.model`, `.effort` | live |
| subscription decisions | Decisions run on the machine's own subscription login, with no API provider constructed and no paid fallback. `apiTokens: true` is the only way to use API keys. | `subscriptionOnly`, `pf/providers/subscription-decisions.ts`, `subscription-policy.ts`; [subscription-decisions.md](subscription-decisions.md) | live |
| decision runtime | Claude with Wardens in project hosts (default, or `claude-project`), `claude` (Claude, every Warden primed: the evals' baseline), or `codex`. `claude-in-session` was removed on 2026-11-03 and is refused by name. | `subscriptionOnly.decisionRuntime` | live (project hosts) |
| decision host | The process-wide host that runs every decision on the decision model and effort. | `liveDecisionHosts`, `pf/providers/decision-host.ts` (`decisionHost` is the offline variant for evals and reports) | live |
| stage host | An extra decision host started for a stage that names another model or effort, on the same login and bounds. | `stageHost` in `liveDecisionHosts` | live (Sonnet 5.5 low, the default Layer 2, on the decision login; only subscription decisions start one) |
| primed pool | The warm sessions decisions run on: one primed key per role (a key per stage on the host plus a review key per Warden, plus 8), at least 16; an evicted key re-primes cold. Not a setting. | `primedSessions`, `pf/providers/primed-decisions.ts`; agent-session `ClaudePrimedSessions` / `CodexPrimedSessions` | live |
| prime | Starting a role's session once with its instructions and stable context (`stablePrefix`); each decision then forks it and sends only the per-call part, so no cycle sees another's. | | live |
| hedge | A Codex decision still running after `hedgeAfterMs` (4,000) is started again on a second branch; the first to finish wins. Claude decisions are not hedged. | `subscriptionOnly.hedgeAfterMs` | live (Codex decisions only) |
| decision deadline | The safety-net deadline for every decision, queue time included: 60 s. Advice and routing default to it. | `DECISION_DEADLINE_MS`; `callTimeoutMs`; `adviseTimeoutMs`, `routingTimeoutMs` | live |
| maxConcurrent | Decisions running at once across all threads (16). Guards may hold at most three quarters of the slots and reviews half, so a turn waiting to start always finds capacity. | `subscriptionOnly.maxConcurrent`; `DECISION_PRIORITY` (`turn > guard > review`) | live |
| decision receipts | Private records of each decision's ownership, model and settlement, never its text. | `subscriptionOnly.directory` (`.foundry/decision-receipts`) | live |
| project Warden host | Every Warden of a project held warm in one Foundry-owned Claude Code process on the decision login, while someone works in the project; every thread of it sends its advice there (guards, reviews and Layer 2 stay primed; primed serves while no host does). Replaced the per-thread in-session runtime (THREAD-TREE spec C) on 2026-11-03. | `subscriptionOnly.projectHost`, `pf/providers/project-warden-hosts.ts`; [subscription-decisions.md](subscription-decisions.md), "Project Warden host" | live (default for Claude decisions) |
| Warden host singleton | One process per machine holding every Warden warm; threads post context and get chimes back. | | proposed |

## Other roles in code

| Term | What and why | Where | Status |
|---|---|---|---|
| Cartographer | Context routing: reads the topology map and decides which layers a message needs; never modifies. At most one per configuration. | `pf/agents/cartographer.ts` | live (on a wrapped thread) |
| Librarian | Programmatic, no model call: the sole writer of thread state; reconciles signals. Takes no settings. | `pf/agents/librarian.ts` | live |
| classifier / router | Thread agents that classify a message and route it to an executor; keyword fallback on timeout. | agent kinds `classifier`, `router` | off (a fresh install has neither) |
| feedback lifecycle | `/feedback` records an item on the thread and turn; with detection on, a correction is classified, routed to Warden roles, offered back in a tuning prompt and applied to a role file with provenance. | `pf/feedback/`, `feedback.capture`; [FEEDBACK-LOOP.md](FEEDBACK-LOOP.md) | live (explicit `/feedback`); detection off |
| tuning prompt | "What happened / what we did / what we intend", shown to the user to sharpen a captured correction (`ask`, `block` or `blockOn`). | | off (with detection) |
| Forge Master | A thread scope (role `forge-master`): threads for talking to this Foundry about itself, started from the New thread picker or a settings page's "Ask the Forge Master" (which drafts the question). Each holds a standing brief with this install's configuration. A Forge Master Warden is designed, not built. | `pf/agents/scope-roles.ts`, `threads:@forge` | live |
| Feedback scope | A thread scope (role `feedback`): threads that work through the feedback inbox with the person; the viewer shows the inbox beside the thread, and the thread's MCP bridge carries `feedback_inbox`, `feedback_item`, `feedback_status` (read, archive, reopen; tuning answers stay the person's). | `pf/agents/scope-roles.ts`, `pf/tools/feedback-inbox.ts`, `threads:@feedback` | live |
| MCP bridge | The `foundry` MCP server a native session can pull from mid-turn (`foundry_query`, `foundry_conventions`, … plus `send_to_member`, `pass_conch`, `kingdom_post` when registered). | `pf/mcp/server.ts` | live |

## Shared threads

| Term | What and why | Where | Status |
|---|---|---|---|
| conversation | A wrapper of a main thread, not a chat: one post-in point, one read-off point, and floor state. Always wrapped, so posts reach the executor. | `pf/conversations/`; [CONVERSATIONS.md](reference/CONVERSATIONS.md) | live |
| shared thread | A thread with a member grant from someone other than its owner. | | live |
| post-in point | Kingdom's relay frame, admitted in one synchronous transaction (dedupe, pause, depth, floor), then delivered as a note or a turn and labelled as untrusted data from that member. | `pf/conversations/service.ts` | live |
| read-off point | A member reads the main thread's journal through its terms (`view: own` or `thread`), never tool I/O or Warden entries. | `thread.read`, `visibleTo` | live |
| floor modes | `talk` (anyone posts), `speak-when-spoken-to` (one reply per invitation), `conch` (only the holder posts); all built on invitations. A shared thread defaults to `conch`, an unshared one to `talk`. | `conversations.floor`; `SHARED_CONVERSATION_DEFAULTS` | live |
| invitation | The one floor mechanism: `{ to, by, standing, expiresAt }`. | `Invitation`, `pf/conversations/types.ts` | live |
| conch | One standing invitation held for `holdSeconds` (300); the owner can always take or reassign it; the agent may pass it only with `agentMayPass` (false). A member may ask for it, or `take` it when its grant allows. | `conversations.conch`, `pass_conch` | live |
| owner / driver / leader | Separate roles: who owns the thread, who holds the conch, who may reassign it. Roles change through Signet revise and grant, with no role table. | | live |
| depth bound | Agent turns without the owner before the conversation pauses (`maxAgentTurns`, 6). | | live |
| sitting in / participating | Two grants: reading the whole log (`thread.read`, `view: thread`), or that plus posting (`thread.prompt`), governed by the floor. | Kingdom Signet terms | live |
| the log | The shared thread holds only what was posted. Each agent's context is the log plus its own private side. | | live |
| held send | An agent's proposed post (`send_to_member`, `kingdom_post`) waits for its person to release, edit or withdraw it; agents never post straight in. | | live |
| commission | A released send that asks an agent for work; its report posts into the log by default, unless the caller asked to be notified instead. | `commission: { report, expiresAt }` | proposed (BOARD-001 slice 2a) |
| `agents: silent \| drafting` | Silent: agents hear the thread but don't speak (posts become notes, sends are refused) until the leader lets them draft. | `conversations.agents` (`drafting`) | live |
| revival | A post on a thread idle for days brings it back: a `turn` wakes the session, a `note` shows as unread. | | live |
| `/btw` | The only private channel: a word to your own agent, never in the log, on every runtime. | BOARD-001 slice 2b | proposed |
| aside | Person-to-person, visible to two people and no agent, until someone promotes it. | BOARD-001 slice 2b | proposed |

## The viewer

| Term | What and why | Where | Status |
|---|---|---|---|
| viewer | The local control surface at http://localhost:4500, styled with Kingdom's tokens so the two apps read as one. It does not grow runner features (worktrees, diffs, checkpoints). | `pf/viewer/`, `ui/tokens.css` | live |
| data streams | `/ws` streams a panel opens (`thread:<id>`, `threads`, `prompts`, `events`, `flow:<id>`, `feedback`): snapshot, then appends with a `seq` for gap detection; no replay. | `pf/viewer/data-streams.ts`; [SYSTEM.md](SYSTEM.md) | live |
| left rail | Attention (open threads that need you, red then orange; the default), Open (Yours / Shared, fixed halves) and Projects (project list and the selected scope's threads); `⌥⇧←` `⌥⇧→` step between them. Starting a thread from Projects returns to Attention (`afterProjectStart`). | `ui/nav-rail.js`, `ui/project-sidebar.js` | live |
| centre tabs | Thread · Brief (what the thread is about and where it stands) · Work (task lists, records) · Loop (plan → build → review → land, then each turn's flow graph). | `ui/conversation.js`, `brief.js`, `work.js`, `loop-view.js` | live |
| right panel | Context · Participants · Permissions · Heralds · Pointers (Warden pointers that reached the thread) · Feedback. Inspecting anything opens the inspector over it. | `ui/right-panel.js`, `detail-drawer.js` | live (Heralds tab: placeholder) |
| board | The attention board (`b`): threads in columns by status colour. | `ui/board.js` | live |
| status colours | Green working · orange needs you · red can't proceed · light yellow queued · light blue done · neutral idle/paused · charcoal archived. Solid icons with the symbol cut out. | `ui/status-icons.js` | live |
| Chorus page | Read-only project settings page listing the chorus's layers, regions, sizes, keys and stages. | `GET /api/projects/:id/chorus` | live |

## ACP

| Term | What and why | Where | Status |
|---|---|---|---|
| ACP host | An editor or runner (Zed, Paseo, T3 Code) that drives Foundry over ACP v1. Every turn from it passes through Foundry's middleware. | [FOUNDRY-ACP.md](reference/FOUNDRY-ACP.md) | live |
| access follows the host | Foundry honours whatever permission mode the user chose in the host, full access included; no Foundry-only stricter modes. Only structural rules deny. | §0 | live |
| ACP launch file | `~/.foundry/acp-launch.json` (0600): the daemon's loopback endpoint and pid, which foundry-acp reads. foundry-acp auto-starts the daemon. | `pf/client` | live |
| remote ACP clients | ACP from another machine. | §7.2 | proposed |

## Kingdom links

| Term | What and why | Where | Status |
|---|---|---|---|
| Kingdom | The hosted connector: identity, owners, integrations, Signets, subscription pools. Foundry ↔ Kingdom is many-to-many. | | live |
| pairing / Installation | `bun run kingdom pair` registers this Foundry as a Kingdom Installation (its own key), asks to become an owner's Foundry integration, and collects the Signet the owner grants. | `pf/providers/kingdom-pairing.ts`; [session-archives.md](session-archives.md) "Kingdom pairing" | live |
| Installation socket | One live connection per paired Kingdom: Signet snapshots in, session count and tunnel URL out, member relay frames in. | `pf/providers/kingdom-installation-connection.ts` | live |
| Signet | The only grant for using an integration: resources, operations, lens, limits, revocation. Foundry acts on Kingdom only by presenting Signets. | `@inixiative/signet` | live |
| enrolled key / Signet credential file | A Signet's one presentation: a key enrolled by the Installation; the local `signet-<id>.json` (0600) holds the renewal credential and a short-lived DPoP access token. | `<config>/kingdom/<host>/signet-<id>.json` | live |
| access grant | A project-scoped grant that lets a native session read an integration's resources through Kingdom with a Signet. | `kingdomAccess`; [kingdom-access.md](kingdom-access.md) | off (per grant) |
| capacity (`local` / `kingdom`) | Where a project's main threads get their subscription: this machine's login, or a Kingdom pool that releases a short-lived token through a `subscription.use` Signet. | `projects[id].capacity`, `kingdomCapacity`; [native-authentication.md](native-authentication.md) | live (`local`); `kingdom` off |

## Oracle words Foundry work leans on

Oracle is the test harness: it replays real work against Foundry and measures whether help lands. Its words, defined fully in Oracle `docs/PROCEED.md`, `docs/ORACLE-TEST.md` and `docs/CORRECTION-FIXTURES.md`:

| Term | Meaning |
|---|---|
| fixture (H / A / C / B) | A finished piece of real work: H the task as given, A the attempt that got corrected, C the correction, B the accepted fix, plus X (the existing thing B used) and the base commit. A sealed check must fail A and pass B. |
| replay | Rerunning a fixture's H from its base commit with an agent, with and without help, and checking whether it reached X. |
| Subject / judge | The Subject stands in for the user when the agent asks; a blind judge or a program grades the result. |
| arm | One condition of a replay, smallest help first (the hint ladder): `none`, `correction`, `pointer`, `pointer@write`, `search`, then the live `chorus`. |
| plan run | A run asked to write its plan as its answer (not the CLI's plan mode); cheap, and checked against full builds before it is trusted. |
| slices | One fixture tested at each layer: detection, pick, reception, plan, build. |
| stage-one / detection | Slice 1: given only the task, do the right regions say "mine"? Per-region recall and false yes. |
| the bar | The standing stage-one baseline. No change to docs, regions, charters or the region builder ships unless detection holds it. |
| dev / holdout | Work tuned on versus work held back once per corpus freeze, so the gap measures overfitting. |
| Prospector | Oracle's miner of real sessions and merged work into fixtures and probes; its collector and classifier run as `foundry repeats` (`pf/feedback/repeats.ts`). |

## Two names for one thing

- **Warden** in prose; **domain librarian** in code (`DomainLibrarian`, agent kind `domain-librarian`, `domainLibrarians`). Region Wardens are generated per project; settings may not declare one.
- **The charter's version**: `charter-<12 hex>` (`WARDEN_CHARTER_VERSION`, the prefix of foundry-core's `computeHash`, e.g. `charter-e49589e870f6`) and the sha256 of the same text, which eval reports also record. Same text, two hashes. `reception-<12 hex>` names the reception charter the same way.
- **Pointer shapes**: settings and docs say `one` / `all` / `any`; the parsed pointer says `ranked` / `all` / `choose-one`.
- **Guard and `agent-action`**, **brief and `subagent-spawn`**, **review and `post-turn`**: the phase and the trigger that starts it.
- **Artificer and executor**: the main thread's native session.
- **Brief** is both the handoff brief (a Warden phase) and the viewer's Brief tab (a thread summary). They are unrelated.
- **Members and participants**: a conversation's parties are members; `participant` in the flow orchestrator is a Warden or middleware contributor, and the viewer's Participants tab shows members.

## Retired words

| Old word | Replaced by | Retired |
|---|---|---|
| The hand-named Warden roster (Docs, Convention, Security, Architecture, Memory, …) and its advise-style charter | Region Wardens, one per region, under the point charter. `domain-advising` / `domain-librarian` / `decider` agents in settings and `chorus.source` are refused by name. | 2026-10-17 |
| `chorus.source: "regions"` | `chorus.enabled: true` | 2026-10-17 |
| Domain Librarians (as the name for Wardens) | Wardens (the code keeps `domain-librarian`) | before 2026-10-12 |
| Pre-filter on by default | Off; ask every region, every time | 2026-10-15 |
| Guard per tool call | One guard per turn (`guard: per-call` remains a setting) | 2026-10-15 |
| The starter stack (system / conventions / memory layers, classifier → router → three executors) | An unwrapped thread; `setup --remove-legacy-defaults` removes leftovers | 2026-10-16 |
| Supervised mode | Removed (it was a pass-through) | 2026-09-30 |
| Kastle / Castle | Kingdom, owner, integration, Signet | 2026-09-30 |
| Connection (Kingdom model) | Integration (`connectionId` → `integrationId`). The viewer's per-WebSocket `connectionId` is unrelated. | 2026-10-12 |
| Runtime keys (`kingdom_runtime_`, `RuntimeInstallation`) | Pairing as an Installation; Foundry acts only by presenting Signets | 2026-10-08 |
| Foundry's own archive store (`.foundry/archives/archives.sqlite`) | Captures written to the local Archive server | 2026-10-01 |
| Vendor hooks (`RuntimeAdapter`, `foundry hook …`, MIDDLEWARE-ADAPTER) and `ClaudeCodeProvider` | Foundry is the harness; hosts drive it over ACP | 2026-10-11 |
| `permissionMiddleware` | The tool gate | 2026-10-11 |
| `local-herald` member kind | `local` | signet 0.6.0 |
| "phase" for a classification step | "stage"; "phase" stays advice, guard, brief, review | 2026-10-18 |
