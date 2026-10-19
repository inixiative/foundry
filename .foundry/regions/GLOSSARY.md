# Foundry glossary

**Every term Foundry's region Wardens use, alphabetical, each with the region that holds it.**

<!-- Generated with the region Warden docs (v1) by ~/.foundry/evals/warden-regions/assemble.py. A term defined by two regions appears once per region. -->

---

## A

**acknowledgement rule**  
A pointer at a system the instruction contradicts needs the instruction to say replace or bypass it; otherwise ask one short question first. *Region:* [A project's region Wardens](chorus/knowledge.md)

**acp**  
This class: foundry-acp, ACP hosts driving Foundry threads, the method map, session/update projection, modes, setup. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**ACP**  
Agent Client Protocol: JSON-RPC over stdio between an editor/runner host and an agent; Foundry speaks v1 only. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**ACP host**  
An ACP client that spawns foundry-acp per connection: Paseo, T3 Code, Zed, JetBrains. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**ACP launch file**  
~/.foundry/acp-launch.json, written 0600 by the daemon: endpoint, capability, pid. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**ACP modes**  
default, acceptEdits, plan, bypassPermissions: the host's permission modes passed to the native runtime. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**acp:<client> thread tag**  
Thread tag naming the host so Archive and Oracle can split recurrence by host. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**ActionHandler**  
Runs operator commands from /api/actions: thread:pause/resume/archive/inspect, layer:warm/invalidate, agent:dispatch, system:snapshot. *Region:* [Viewer dashboard shell](viewer/knowledge.md)

**ActionQueue**  
Core prompt queue; one prompt shows in viewer and ACP, first responder wins. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**ActionQueue**  
Holds pending action prompts awaiting an answer, such as capability or tool-gate asks. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**ActionQueue**  
Holds pending capability asks until a human answers in the viewer. *Region:* [Agent tools and execution environments](tools/knowledge.md)

**actor**  
Who made a change: user, feedback, agent, release or external. *Region:* [Composition audit log](audit-log/knowledge.md)

**addLogBroadcast**  
Also sends every log call in the current async scope to an extra target. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**admission**  
The scheduler's acceptance of a decision; violations, substituted models and unproven results close it, rate limits do not. *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**advise deadline**  
Advice is bounded by a deadline; a Warden that times out is skipped and the turn proceeds. *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

**adviseTimeoutMs**  
Advise deadline; a Warden that times out is skipped. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**agent-action**  
Guard trigger, once per turn when tool activity ends, over the turn's writes, edits and commands in order. *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

**agent-question / hand-back**  
Next trigger points, not built: answer on the user's behalf; review the final message before it lands. *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

**agent-session**  
Class: @inixiative/agent-session: HarnessSession, transports and capabilities, subagent events, subscription pools, routing and leases. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**AgentLLMConfig**  
Per-agent provider, model, temperature, maxTokens, sources (visible layer ids) and maxDepth. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**AIAssist**  
LLM review of config and prompt improvement behind /api/assist; the settings panel's AI Analyze / AI improve. *Region:* [Viewer dashboard shell](viewer/knowledge.md)

**all of these**  
Shape `all`: several systems each apply; read every one. *Region:* [Warden classification primitive](classify/knowledge.md)

**allowedBilling**  
Pool billing modes allowed to serve; defaults to ['subscription'], spending money is never a routing default. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**Analytics tab**  
Cost and usage page: stat cards, budget gauge, ranked models and agents, thread costs, call log. *Region:* [Viewer dashboard shell](viewer/knowledge.md)

**AnalyticsStore**  
Stores and serves usage analytics (the JSONL call log) for the viewer. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**anchor**  
The directory a node is about, which places it in the order; none means computer level. *Region:* [Standing instructions and composition](composition/knowledge.md)

**annotations.typesafe**  
Where the middleware puts the validated response (or the configured `annotationKey`). *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

**anticipated**  
Primary measure: share of real corrections some Warden said first. *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

**api-providers**  
Class: the LLMProvider interface and the API-key providers (Anthropic, OpenAI, Gemini, OpenAI-compatible family, embeddings). *Region:* [Models, providers and usage](models-providers/knowledge.md)

**apiTokens**  
Opt-in for API providers (Anthropic, OpenAI, Gemini, OpenAI-compatible); subscription sessions are the default. *Region:* [Repo structure and conventions](conventions/knowledge.md)

**apiTokens**  
Setting that opts in to API-key providers and the API decision provider (needs ANTHROPIC_API_KEY); cannot combine with subscriptionOnly. *Region:* [Subscription-only policy](subscription-policy/knowledge.md)

**--append-system-prompt**  
How a Claude session starts with its standing parts; it survives compaction and is re-sent and cached every request. *Region:* [Session context delivery](session-delivery/knowledge.md)

**--append-system-prompt-file**  
How a Claude session starts with every standing part as its system prompt; Codex gets them in its first message. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**applyChange / revertChange**  
Append one rule line with provenance (changeId, before/after hash); remove exactly that line. *Region:* [Feedback and corrections](feedback/knowledge.md)

**appServerBridgeConfiguration**  
Codex equivalent of withNativeBridge: the bridge lease as flat app-server config keys. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**appServerClientMcpConfiguration**  
Codex equivalent of withClientMcpServers: host servers as app-server config keys. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**archive agents**  
Declares collectors in `agents.json` and installs them as launchd / systemd units. *Region:* [Local Archive and session capture](archive/knowledge.md)

**Archive claim lease**  
Foundry's 10-minute lease (renewed every 2) on native sessions so the collector skips them; fulfilled after capture, lapses to raw capture. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**Archive lineage**  
kind, parentSessionId, rootSessionId, parentEntryId, toolUseId, depth linking a node's Archive session to its parent. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**archive up**  
Archive CLI command that creates `~/.local/share/archive/server.token` and starts the Compose stack. *Region:* [Local Archive and session capture](archive/knowledge.md)

**archive-capture**  
Class: Foundry's use of the local Archive: setup, journal capture, archive commands, context source, thread context. *Region:* [Local Archive and session capture](archive/knowledge.md)

**archive-server**  
Class: the Archive itself (@inixiative/archive): deployment, collectors, routing, tags/references/retention, HTTP API. *Region:* [Local Archive and session capture](archive/knowledge.md)

**ARCHIVE_RUN**  
Env var (test | oracle | foundry) stamping the snapshots a process writes. *Region:* [Local Archive and session capture](archive/knowledge.md)

**ArchiveCapture**  
Writes each journalled thread to the local Archive as a whole-thread snapshot, retrying failures every 30 s. *Region:* [Local Archive and session capture](archive/knowledge.md)

**ArchiveContextSource**  
Context source of type `archive`: searches the local Archive for the bound project as historical evidence. *Region:* [Local Archive and session capture](archive/knowledge.md)

**Artificer**  
The native session doing the real work under the harness; the only role on a capable model by default. *Region:* [Repo structure and conventions](conventions/knowledge.md)

**Artificer**  
The executor: a native Claude Code or Codex session run through agent-session under the harness. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**Artificer**  
The executor: the native Claude Code (or Codex) session running under the harness. *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**ask / block / blockOn**  
Tuning prompt modes; block holds the queued turn, a stop withdraws it, blockTimeoutMs bounds it. *Region:* [Feedback and corrections](feedback/knowledge.md)

**ASK_TIMEOUT_MS**  
How long the gate waits on a user ask. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**assembledToMessages**  
Turns stack.assemble() plus the user payload into provider-ready messages. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**assemblePrompt**  
Assembles a prompt from its section files with overrides, omissions and mode sections. *Region:* [Warden classification primitive](classify/knowledge.md)

**assertMainThreadLabs**  
Throws unless every registered main thread runs on a main-thread lab. *Region:* [Subscription-only policy](subscription-policy/knowledge.md)

**asSource / asAdapter / signalWriter**  
The three faces every memory adapter offers: layer source, ref hydration, signal persistence. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**atlas**  
Class: the code map: @atlas blocks, the concept registry, navigating by concept. *Region:* [Repo structure and conventions](conventions/knowledge.md)

**@atlas block**  
Top-of-file @kind / @partOf / @uses on every source file, validated against the concept registry. *Region:* [Repo structure and conventions](conventions/knowledge.md)

**atlas check**  
Run by bun run check; fails below 100% @atlas coverage. *Region:* [Repo structure and conventions](conventions/knowledge.md)

**.atlas/concepts.ts**  
Foundry's concept registry (features, primitives, infrastructure, integrations); broad but closed. *Region:* [Repo structure and conventions](conventions/knowledge.md)

**audience**  
composition.roles.<role>.audience (default personal_private): which tiers a role may read. *Region:* [Standing instructions and composition](composition/knowledge.md)

**audit-log**  
Class: the one audit log, source versions, composition versions, recompose (THREAD-TREE spec B). *Region:* [Composition audit log](audit-log/knowledge.md)

**AuditLog**  
The single append-and-read log of versioned changes in <configDir>/audit.jsonl; row ids are the versions. *Region:* [Composition audit log](audit-log/knowledge.md)

**authFetch**  
Same-origin fetch that sends the tunnel session cookie; use for viewer API calls. *Region:* [Viewer dashboard shell](viewer/knowledge.md)

## B

**BaseAgent**  
Abstract agent: getContext() from visible layers, run(payload, filterOverride) returning an ExecutionResult. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**baseContextOf**  
Builds the system prompt a session starts with: every standing part, labelled, in order. *Region:* [Session context delivery](session-delivery/knowledge.md)

**BashShell**  
ShellTool over real system bash. *Region:* [Agent tools and execution environments](tools/knowledge.md)

**beginTurn**  
Durable acceptance of a turn before it runs: 409 on a duplicate, 503 if it cannot be made durable, 202 to the caller. *Region:* [Threads and the turn path](threads/knowledge.md)

**bindLiveAuthority**  
Binds the bridge to the live runtime's authority (packages/foundry/src/mcp/authority.ts). *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**blessed version**  
Minimum CLI version in policy.json; a full successful test:live raises it. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**briefNotes**  
Turns a Warden's subagent-handoff brief into next-turn prompt notes. *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**browser mode**  
playwright-mcp (accessibility snapshot + clicks), js-execute (JS in the page) or hybrid. *Region:* [Agent tools and execution environments](tools/knowledge.md)

**BROWSER_POLICY**  
Preset policy for browser agents: navigate, interact, screenshot allowed; execute prompted. *Region:* [Agent tools and execution environments](tools/knowledge.md)

**BudgetExceededError**  
Thrown when a token or cost budget reaches its halt threshold. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**budgetGuardHook**  
Built-in pre:dispatch hook that blocks dispatches once the token tracker shows the budget spent. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**buildDecisionCatalog / refreshDecisionCatalog**  
Build a catalog snapshot from a loaded manifest / re-read it from the manifest path. *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

**buildInjectionArtifact**  
Segmented reading view of injected context, kept distinct from the user message; not for sending. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**buildRoleLayers**  
Builds a Warden's private instructions and domainKnowledge layers from the composition view. *Region:* [Standing instructions and composition](composition/knowledge.md)

**builtinFilters**  
stripAnsi, collapseBlankLines, collapseWhitespace, stripProgress, dedup, gitStatus, testOutput, rtk, compose. *Region:* [Agent tools and execution environments](tools/knowledge.md)

**bun run archive:viewer**  
Archive console: the normal viewer with journal and capture, no model agents. *Region:* [Local Archive and session capture](archive/knowledge.md)

**bun run check**  
The full gate: typecheck (5 targets), lint, atlas check, test. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**bun run doctor**  
Inspects the install without starting agents or calling providers; flags `legacy-starter-defaults`. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**bun run vcr:accept**  
Accepts pending recordings as the new baseline. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**bun run vcr:refresh**  
test:live then test:live:daemon; the scheduled re-record; refuses the daemon's checkout. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**BunScript**  
ScriptTool running agent-written TypeScript in a fresh Bun subprocess per call, API keys stripped. *Region:* [Agent tools and execution environments](tools/knowledge.md)

**bunx atlas query --partOf**  
Find files by concept; graph --json gives the whole graph, generate writes a local MAP.md. *Region:* [Repo structure and conventions](conventions/knowledge.md)

**bunx atlas stamp <path> --write**  
Fills @kind / @partOf from .atlas/config.ts when a file is added or moved. *Region:* [Repo structure and conventions](conventions/knowledge.md)

## C

**CacheLifecycle**  
Rule-based layer lifecycle management with event queuing. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**callTimeoutMs**  
Per-decision deadline including queue and preflight time (default 30000). *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**candidate / stable**  
A built update on trial vs the release that last booted; a candidate that boots becomes stable, one that fails is marked failed. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**capability**  
The launch file's bearer secret; accepted only on direct loopback requests, never through the tunnel. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**capability**  
Registry tag on a model (e.g. 'judgment', 'execution') used to find models fit for a job. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**capability**  
What a tool call touches, e.g. exec:shell, file:write, net:api; rules are keyed by capability. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**capability**  
A named permission such as exec:shell, exec:process, file:read, file:write, browser:navigate, browser:execute. *Region:* [Agent tools and execution environments](tools/knowledge.md)

**CapabilityDeniedError**  
The error class for a denied capability (packages/core/src/capability.ts). *Region:* [Agent tools and execution environments](tools/knowledge.md)

**CapabilityGate**  
Checks whether a capability is allowed, prompted or denied under a policy; require() blocks until a human approves. *Region:* [Agent tools and execution environments](tools/knowledge.md)

**CapabilityGate net:api / llm:call**  
The two capabilities the Jev client and middleware check before any call. *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

**capacity: local | kingdom**  
A project's capacity: the machine's own login (default) or a Kingdom pool; set by `bun run kingdom capacity`, applied on restart. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**captureRunSessions**  
Archive setting: keep run-tagged sessions (on by default) or drop explicitly stamped ones. *Region:* [Local Archive and session capture](archive/knowledge.md)

**captureToolCallsAndResults**  
Archive setting: keep tool calls and results (on by default); off strips them and marks coverage partial. *Region:* [Local Archive and session capture](archive/knowledge.md)

**Cartographer**  
The context-routing agent: owns the topology map, routes slices, modifies nothing; keyword fallback. *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**cassette**  
A recording at `tests/fixtures/vcr/<service>/<method>.<name>.json` with version, body and `recorded` stamp. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**catalog(context)**  
Trusted callback giving the shadow runner a revision, candidates (ID + description) and learnings for this thread. *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

**cause**  
Structured why: feedbackItemId/changeId, settingsRevision, gitCommit/gitBlob, or detected: on-read; no free-text reason. *Region:* [Composition audit log](audit-log/knowledge.md)

**charter eval**  
scripts/evals/warden-charter.ts: runs a classify configuration over probes and judges the remarks; a dev diagnostic. *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

**chartered**  
Builds a Warden call's system message: the charter plus the Warden's instructions. *Region:* [Warden classification primitive](classify/knowledge.md)

**Cheap models for decisions**  
Classifiers, routers, Cartographer, Librarian and Wardens run Claude Haiku 5.5; only the Artificer uses a capable model by default. *Region:* [Subscription-only policy](subscription-policy/knowledge.md)

**checkout**  
One device-local repository/worktree; its path, branch, commit and dirty state belong to it, not the project. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**chime**  
A Warden's advice appended after the user's message as "The <domain> Warden chimed in:"; NO_COMMENT adds nothing. *Region:* [A project's region Wardens](chorus/knowledge.md)

**Choice**  
Jev question type that picks one option from criteria and reports a confidence. *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

**choose one**  
Shape `any` (on by default): close siblings that can't be told apart; pick the one whose job matches. *Region:* [Warden classification primitive](classify/knowledge.md)

**chorus**  
A project's set of region Wardens, built from its concept regions when `projects[id].chorus.enabled` is true; opt-in, per project, no global setting. *Region:* [A project's region Wardens](chorus/knowledge.md)

**chorus.consumed**  
Opt-in `consumed` trigger config: `enabled`, `tools`, `paths`, `maxChars` for tickets and specs the main thread reads. *Region:* [A project's region Wardens](chorus/knowledge.md)

**chorus.heralds**  
Socket for Herald regions (`role: "herald"`); takes the stages shape, runs nothing, Heralds are not built. *Region:* [A project's region Wardens](chorus/knowledge.md)

**chorus.layers**  
Ordered regions directories; a later layer's region id replaces the earlier one whole, ids present once union. *Region:* [A project's region Wardens](chorus/knowledge.md)

**chorus.reception**  
On with the chorus by default; `false` leaves the `chorus-reception` layer out. *Region:* [A project's region Wardens](chorus/knowledge.md)

**chorus.source**  
Retired key, refused by name: `"regions"` becomes `"enabled": true`, `"roster"` has no replacement. *Region:* [A project's region Wardens](chorus/knowledge.md)

**chorus.wardens.stages**  
Up to three classification stages per Warden role; default one stage; machine's list replaces the repository's whole. *Region:* [A project's region Wardens](chorus/knowledge.md)

**chorus.wardens.stages**  
Where a project sets its Warden stages (in the `chorus` region's settings). *Region:* [Warden classification primitive](classify/knowledge.md)

**CHORUS_RECEPTION**  
The reception charter the main thread holds as the `chorus-reception` standing layer: how to read a chime, plus the acknowledgement rule. *Region:* [A project's region Wardens](chorus/knowledge.md)

**claims**  
Lease a driver such as Foundry holds on sessions it records, so collectors skip them until fulfilled or lapsed. *Region:* [Local Archive and session capture](archive/knowledge.md)

**Clarifier**  
Checks whether a request is complete enough to execute, returning questions if not; sits between route and execute. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**class pointer**  
A ranked pointer at the class level: 'Look over here: <the class> (<where>)'. *Region:* [Warden classification primitive](classify/knowledge.md)

**Classification stages**  
Up to three stages per Warden answer; each names model, effort, doc, outcomes, reason, task and escalate. *Region:* [Warden classification primitive](classify/knowledge.md)

**Classifier**  
Decider returning a Classification (category, subcategory, tags) from a pre-warmed taxonomy. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**classify**  
Class: the one classification primitive: stages, charters, response protocols, NO_COMMENT, pointer shapes. *Region:* [Warden classification primitive](classify/knowledge.md)

**classify run config**  
run.json given to --classify: stages, eval-only sections, debug, members; read by readClassifyRun. *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

**classifyCorrection**  
Live single-message correction classify via the shared classify contract on a decision provider. *Region:* [Feedback and corrections](feedback/knowledge.md)

**classifyTool**  
Maps a native tool call (name, input, path) to a capability and paths. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**claude-code preset**  
The default ladder mirroring Claude Code discovery: managed, global, org, project, local, memory (DEFAULT_INSTRUCTION_LADDER). *Region:* [Standing instructions and composition](composition/knowledge.md)

**claude-context-budget.ts**  
Claude Code's native auto-compaction policy; no separate summarizer or compression loop. *Region:* [Repo structure and conventions](conventions/knowledge.md)

**claude-in-session**  
The `subscriptionOnly.decisionRuntime` value that turns this runtime on; off by default. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS**  
Subagent cap the launch raises (by 76 today) so Wardens don't starve the user's own subagents. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**CLAUDE_CONFIG_DIR**  
Selects Claude's profile and its keychain credential; set via profileEnvironment, never by hand. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**CLAUDE_HARNESS_INSTRUCTIONS_OFF**  
Env that makes a Claude worker skip CLAUDE.md, rules, AGENTS.md and auto memory. *Region:* [Standing instructions and composition](composition/knowledge.md)

**ClaudeCodeSessionAdapter**  
Runs a Claude Code thread as a persistent native session; built with the authentication manager. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**claudeContextEnvironment**  
Builds CLAUDE_CODE_AUTO_COMPACT_WINDOW / CLAUDE_AUTOCOMPACT_PCT_OVERRIDE for the child process. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**ClaudeInSessionDecisions**  
agent-session 0.6.6 class that runs the root, dispatcher and Warden tree inside a Claude main session. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**claudemdSource**  
A context source for one CLAUDE.md-style file with its @path imports resolved. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**ClaudePrimedSessions**  
agent-session's Claude primed sessions: persisted primed transcript, `--resume --fork-session` per decision, pre-spawned spare. *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**ClaudeSubagentSessions**  
agent-session side-session runtime: a side process per thread with a dispatcher agent and standby moments. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**claudeUsageWindows**  
Reads the Claude login's percent used per usage window before an offline job spends the subscription. *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**cleanEnvironment**  
Child environment free of the terminal's agent sessions and credentials for live runs. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**clientMcpServers**  
Validates and copies a host's MCP servers, throwing on anything Foundry will not launch. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**closeAllConnections**  
Close every connection with one code and reason (authorization lost, shutdown). *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**Codex worker CODEX_HOME**  
A Codex worker runs on a Foundry-private .foundry/runtime-profiles/<source id>/codex-home linking the profile's auth.json. *Region:* [Subscription-only policy](subscription-policy/knowledge.md)

**CODEX_HOME**  
Codex profile home; Foundry runs Codex on a private home with auth.json symlinked to the profile's. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**CodexPrimedSessions**  
agent-session's Codex primed sessions: one warm codex app-server per decision profile, a thread per role key. *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**CodexPrimedSessions**  
One Codex app-server per account with a primed thread per decision role; Codex Wardens stay here. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**CodexSessionAdapter**  
Runs a Codex thread as a persistent `codex app-server --listen stdio://` session. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**collector**  
Archive process that scans Claude Code / Codex history directories and imports sessions by exact project root. *Region:* [Local Archive and session capture](archive/knowledge.md)

**commitDelivery**  
Records into the ledger exactly the parts the turn report says were sent. *Region:* [Session context delivery](session-delivery/knowledge.md)

**compactClosedTurns**  
On start, reduces closed turns (interrupted included) whose middleware rows are newer than their reduced rows. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**CompletionOpts.priority**  
A decision call's rank; guards may hold at most 3/4 of slots, reviews at most half. *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**CompletionOpts.stablePrefix**  
Declares a role's stable context so it is primed once; roles without it run inline on a fresh process. *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**composeChorus**  
Merges `chorusLayers(project)` into one region set, later layers replacing earlier regions whole. *Region:* [A project's region Wardens](chorus/knowledge.md)

**composedHash**  
sha256 of the exact text a Warden received for a slot; unique, so the same text reuses its row. *Region:* [Composition audit log](audit-log/knowledge.md)

**composeRoleView**  
Composes every slot of one role from the ladder, filtered by audience and deduped across slots. *Region:* [Standing instructions and composition](composition/knowledge.md)

**composition-view**  
Class: roles x slots x ladder nodes; what each role composes, role layers and files, budgets, the prompt composer. *Region:* [Standing instructions and composition](composition/knowledge.md)

**composition.harnessLoading**  
Whether the harness also loads instruction files (load) or is suppressed (suppress); the one injection path. *Region:* [Standing instructions and composition](composition/knowledge.md)

**composition.nodes**  
Settings that register ladder nodes merged over the preset by id; enabled:false removes one, preset:none starts empty. *Region:* [Standing instructions and composition](composition/knowledge.md)

**composition_version**  
Journal row for one distinct composed slot: role, slot, ordered parts, retrieved, omitted, composedHash; id cv_<uuidv7>. *Region:* [Composition audit log](audit-log/knowledge.md)

**CompositionAuditor**  
Turns a call's composition snapshot into source and composition version ids (versionRecord). *Region:* [Composition audit log](audit-log/knowledge.md)

**configFromSaved**  
Saved settings.json to full config over defaults, migrating legacy `providers` to `vendors`. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**configOptions**  
ACP config options offered: mode, model, thought_level (effort); no executor-agent select. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**ConfigRevisionError**  
Thrown when settings changed elsewhere since they were read: reload before saving. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**ConfigStore**  
Persists settings to disk with JSON patch semantics and revisions; the viewer reads and writes through it. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**configuredModel**  
Reads only a native configuration's model; not proof of what served. *Region:* [Session context delivery](session-delivery/knowledge.md)

**consumed**  
Advice trigger when the main thread takes in a work item (ticket, spec, Linear issue, Notion page); off unless `chorus.consumed.enabled`. *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

**consumedMatcher**  
Builds the matcher for which reads and fetches count as consumed work items, from settings. *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

**consumedNotes**  
Turns a consumed work item's Warden answers into next-turn prompt notes. *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**content store**  
session_content / session_content_ref: sha256-addressed text referenced by journal records, kept once. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**contentHash**  
The sha256 hex hash that identifies stored journal content. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**Context routing**  
The role that reads the topology map and decides which context slices a message needs; filled by the Cartographer. *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**context-layers**  
Class tag: ContextLayer, ContextStack, cache lifecycle, hydration registry and refs; layers are independent token caches. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**contextBudget**  
Claude Code native compaction policy `{ maxTokens: 200_000, compactAt: 0.8 }`, at vendors.anthropic.subscription.contextBudget. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**ContextLayer**  
One independently managed context cache: id, sources, staleness, maxTokens, prompt, hash and state. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**ContextRef**  
A pointer { system, locator } into some system, hydrated on demand. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**ContextSource**  
Anything with an id and load(): Promise<string>; supplies layer content on warm(). *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**ContextStack**  
Ordered composition of layers with warming, merging, slicing, snapshots and token-budgeted assembly. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**continueOn**  
Moves a thread to another pool instance only when both share native history (continuation key); refusals say why. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**controlledFixtureSpawn**  
Claude adapter test seam: the real session protocol against a controlled process with exact restricted argv. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**Core vs Foundry boundary**  
Anything that decides how to use the primitives, or needs HTTP, processes or services, goes in foundry. *Region:* [Repo structure and conventions](conventions/knowledge.md)

**core-agents**  
Class tag: foundry-core agent primitives (BaseAgent, Executor, Decider, Classifier, Router, Clarifier, Harness, Planner, the tool-use loop). *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**core-thread**  
Class: core Thread, SessionManager blueprints, ownership scope, ids, and the persisted thread and message models. *Region:* [Threads and the turn path](threads/knowledge.md)

**CorpusCompiler**  
Compiles raw signals into docs and a deduplicated corpus snapshot with attribution traces. *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**/correction**  
ACP available command posting typed feedback as an intervention. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**/correction**  
Classified and tuned with a decision provider; without one, recorded as feedback tagged correction. *Region:* [Feedback and corrections](feedback/knowledge.md)

**correction target**  
What a correction pushed toward (rule, primitive, system, pattern) labelled by --label-targets (Opus). *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

**corrections**  
Class: detecting corrections in sessions and reviews: the Prospector, review findings, foundry repeats. *Region:* [Feedback and corrections](feedback/knowledge.md)

**Correctness checking**  
Wardens in guard mode, asked once per turn over the turn's tool activity. *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**cost weights**  
kindWeighted / modelWeighted: tokens weighted by kind and model into comparable cost. *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

**createDataStreams**  
The data-stream hub: stream families, subscription admission and delivery over a registry. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**createDecisionProvider**  
API-key decision provider from a judgment-tagged model, never the worker model; only with apiTokens: true. *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**createLiveBridge**  
Starts a thread's live loopback MCP bridge so native sessions reach Foundry mid-session. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**createNativeTextProvider**  
The bounded shared subscription text provider: no scheduler, no automatic model calls; buildNativeTextProvider is tests only. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**createNativeToolProjector**  
Turns a native session's tool events into the owner's tool records. *Region:* [Agent tools and execution environments](tools/knowledge.md)

**createPrimedDecisionHost**  
One primed decision host per profile keeping a warm session per middleware role; no scheduler. *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**createRegisteredProvider**  
Builds a client for any registry provider through the one OpenAI-compatible adapter. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**createSerializedQueue**  
Run async tasks one after another, in order. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**createSession / TRANSPORTS**  
Open a session by transport kind; TRANSPORTS[kind].capabilities declares what each transport really supports. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**createSubscriptionDecisions**  
The live decision entry: primed session per role plus the priority scheduler on the decision profile's runtime. *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**createToolGate**  
Builds a thread's gate: structural rules first, then ask the user through ActionQueue. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**createTypeSafeMiddleware**  
Middleware that asks Jev during a turn and stores the answer in `context.annotations.typesafe` before `onDecision`. *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

**createViewer**  
Builds the viewer's Hono server over the harness, event stream and interventions, without starting it. *Region:* [Viewer dashboard shell](viewer/knowledge.md)

**credential reference**  
`{type: environment, variable}` or `{type: command, command, args}`; settings never hold the token itself. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

## D

**daemon**  
Class: the LaunchAgent daemon: install, supervisor, PATH for agent CLIs, two-copy auto-update, last-good settings. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**daemon.autoUpdate**  
Setting: `apply` builds and restarts onto `origin/main` once idle; `check` only logs that it moved. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**data-streams**  
Data streams over WebSocket: registry, subscriptions, delivery, serialized queue, stream buffers, browser socket clients. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**database**  
Class: Postgres via Prisma (schema, db scripts, JSON helpers) and Redis. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**DataStreamClient**  
Loopback client that keeps viewer streams alive across reconnects and gaps (packages/foundry/src/client). *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**Decider**  
Agent that returns only a slim Decision (value, confidence, reasoning); its context stays behind. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**decision catalog**  
Content-hashed snapshot of profiles, candidates and hashed source evidence, built from a manifest and an Atlas graph. *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

**decision profile**  
The one login + runtime + model every decision role runs on (`subscription-decisions`, Claude Haiku 5.5 by default). *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**decision-hosts**  
Class: how decision roles run on subscription logins: provider, host, primed sessions, budgets, priority, thread naming. *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**DECISION_DEADLINE_MS**  
10 s safety-net deadline on every pre-message decision; a late answer is a timeout, classifiers fall back to keywords. *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**DECISION_INPUT_CAP**  
Structural cap on serialized characters a native decision call may take, behind the role budget. *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**DECISION_MODEL / DECISION_PROVIDER**  
API-token decision defaults: anthropic, Claude Haiku 5.5. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**DECISION_PRIORITY**  
The priority constants (e.g. DECISION_PRIORITY.guard): a waiting turn above guards above background review. *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**decisionHost**  
Standalone subscription decision host for offline jobs (repeat reports, evals) without daemon or thread. *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**decisionInput**  
Selects only the catalog concepts tied to the caller's files as a decision's input. *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

**decisionManifestSchema**  
Zod schema (version 1) for a Jev profile manifest. *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

**decisions.jsonl receipts**  
Per-decision ownership, model, priming and settlement evidence, without prompt or answer text, in subscriptionOnly.directory. *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**dedupe**  
Removing the same file, identical content or identical sections, keeping the most specific (later) copy, after the audience filter. *Region:* [Standing instructions and composition](composition/knowledge.md)

**DEFAULT_CONSUMED_MAX_CHARS**  
12,000: a work item longer than this is clipped with a marker. *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

**DEFAULT_CONSUMED_PATHS**  
Default work-item globs: tickets, specs, `*.spec.md`, `SPEC*.md`, `docs/design/**`. *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

**DEFAULT_CONSUMED_TOOLS**  
Glob patterns for tools that fetch a work item: Linear issues and documents, Notion pages. *Region:* [Agent tools and execution environments](tools/knowledge.md)

**DEFAULT_ROLE_BUDGET**  
120,000 characters of instructions plus domain knowledge for middleware roles; none for main. *Region:* [Standing instructions and composition](composition/knowledge.md)

**DEFAULT_STAGE**  
Today's single pointing stage on the region's knowledge.md. *Region:* [Warden classification primitive](classify/knowledge.md)

**defaultConfig / starterConfig / defaultAgents**  
Full defaults / minimal first-install bootstrap / the one bare executor. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**defaults.nativeAuthenticationId**  
Optional explicit native-profile source for the worker; its runtime matches the worker. *Region:* [Subscription-only policy](subscription-policy/knowledge.md)

**defaults.provider**  
The main-thread worker harness: claude-code (default) or codex without API tokens. *Region:* [Subscription-only policy](subscription-policy/knowledge.md)

**deliveredUnderstanding**  
The expert understanding the provider actually received at a past turn. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**Delivery ledger**  
The Librarian's record of part hashes the session holds; passed as SessionDelivery.held, updated by commitDelivery. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**delivery ledger**  
The Librarian's record of which part hashes a session holds; the delivery's source of truth. *Region:* [Session context delivery](session-delivery/knowledge.md)

**DeliveryRecord.session**  
The turn's record of what was actually delivered to the session, with InjectionArtifact.sessionDelivery. *Region:* [Session context delivery](session-delivery/knowledge.md)

**describeMcpServers**  
Names MCP servers by name and transport only, never env or header values. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**design-rules**  
Class: CLAUDE.md's Design Principles and Common Mistakes (for AI assistants). *Region:* [Repo structure and conventions](conventions/knowledge.md)

**destinations.json**  
Archive routing config: organizations (owning projects) and destinations; one archive per organization. *Region:* [Local Archive and session capture](archive/knowledge.md)

**Detail drawer**  
Right panel: span detail, layer detail, corrections (DetailDrawer). *Region:* [Viewer dashboard shell](viewer/knowledge.md)

**detectCorrection**  
Pattern-signal score for one typed message; cheap pre-filter before the model classify. *Region:* [Feedback and corrections](feedback/knowledge.md)

**devices**  
Class: local device identity and inventory, linked project checkouts, foundry_device. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**devMode**  
Developer-mode signal; change it with setDevMode so it persists. *Region:* [Viewer dashboard shell](viewer/knowledge.md)

**DispatchContext**  
What middleware sees: agentId, payload, timestamp and mutable annotations. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**Domain advising**  
The role where each Warden checks its warm cache against the message before execution. *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**DomainLibrarian**  
The one shared Warden implementation: advise, guard and post-work review over a primed session; instantiated per region, never subclassed. *Region:* [A project's region Wardens](chorus/knowledge.md)

**DomainLibrarian**  
The shared class every region Warden is an instance of (chorus region), distinct from the Librarian. *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**domainUnderstanding**  
One expert's current owned understanding of a thread, with revision provenance. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**Don't reinvent Claude Code**  
Design principle 1: wrap the native session, don't replace it. *Region:* [Repo structure and conventions](conventions/knowledge.md)

**DPoP**  
RFC 9449 proof signed by the device key, bound to nonce, endpoint and access token, sent with each Signet call. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**drainConnections**  
Tell every connection to reconnect (graceful shutdown). *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

## E

**encodeRecord / decodeRecord**  
Write a journal record with its bulk stored by hash reference (never refusing for size), and read it back with references restored. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**enqueueJob**  
The only way to put work on the queue: handler name plus typed payload. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**ensureServices**  
Starts the docker-compose services that DATABASE_URL, REDIS_URL and MUNINN_URL point at before boot. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**Entry**  
Prisma model for memory entries (conventions, corrections, ADRs, taste, signals) with optional embedding. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**.env.local**  
Where an API-key provider (only with `apiTokens`) writes its key; the subscription default needs none. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**escalate**  
Which outcomes of a non-final stage pass to the next as an 'An earlier stage' section. *Region:* [Warden classification primitive](classify/knowledge.md)

**evaluate**  
The client call: typed questions in, typed answers out, optional AbortSignal, 10-second transport deadline. *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

**EventStream**  
Unified ordered observable (5K history, push/pull) of layer, dispatch, signal, session and middleware events for the UI. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**evidenceDigest**  
Portable SHA-256 of text for public evidence in Bun and the browser; integrity join only, not a signature. *Region:* [Session context delivery](session-delivery/knowledge.md)

**excluded / not-admitted**  
A Warden the queue never admitted in time: `excluded` for advice, `not-admitted` for guard. *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

**executionEnv**  
An agent setting: bash, just-bash, typescript, browser or hybrid. *Region:* [Agent tools and execution environments](tools/knowledge.md)

**executionId / requestId / runId**  
UUIDs returned by a successful read for attribution; runId groups one project/thread per process lifetime. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**ExecutionResult**  
What every agent run returns: output, contextHash, optional tokens and meta. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**Executor**  
Agent that takes context + payload, does work and returns the full result. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**experiment gate**  
requireExperiment / experimentProblems: a wide eval run needs a passing experiment design. *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

## F

**fails open**  
An unsure score, failed call, timeout or missing model asks the Warden, as without the pre-filter. *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

**fallback to primed**  
A thread whose Warden tree is not running sends its Wardens to primed sessions, as if the setting were off. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**feedback**  
Class: explicit feedback and its lifecycle: capture, sharpen, route, tune, apply/revert, the inbox views. *Region:* [Feedback and corrections](feedback/knowledge.md)

**/feedback**  
Explicit feedback from the composer, a message's ⋯ menu or ACP; recorded as said, never sent to the model. *Region:* [Feedback and corrections](feedback/knowledge.md)

**Feedback channel**  
Guard findings become signals that reach the session on a later turn; no MCP push is built. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**feedback item**  
A fold over feedback-* journal rows (itemId fb_…); its state is never stored separately. *Region:* [Feedback and corrections](feedback/knowledge.md)

**feedback.capture**  
Setting (default false) that turns on the detect → classify → route → tune loop. *Region:* [Feedback and corrections](feedback/knowledge.md)

**FeedbackLifecycle**  
Folds feedback journal rows into an index of items with captures, routes and changes. *Region:* [Feedback and corrections](feedback/knowledge.md)

**FeedbackPhase**  
feedback-capture | -route | -tune | -apply | -revert | -status, appended via LocalSessionStore.appendPhase. *Region:* [Feedback and corrections](feedback/knowledge.md)

**FeedbackService**  
The single entry for giving or reading feedback; capture never changes behaviour. *Region:* [Feedback and corrections](feedback/knowledge.md)

**FileExternalSessionStore**  
File-backed thread-to-native-session id map that survives restarts. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**FileMemory**  
JSON-file memory with owner and visibility; the zero-dependency default. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**Five-role message flow**  
Every message goes through context routing, domain advising, execution, correctness checking, then signal reconciliation. *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**fixture**  
A labelled moment (the Prospector's 740) used for pre-filter measures and label agreement. *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

**fixture bridge**  
Isolated-fixture MCP surface: only fixture_read, fixture_write, fixture_command, each with an invocation UUID. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**flow-loops**  
This class: the harness data flow, channels, loops, progressive depth, thread-state and failure modes. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**flow-roles**  
This class: the FLOW.md roles and the named agents that fill them. *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**flow:<threadId>**  
Data stream of a thread's recorded turn flows, learning history, revisions and review status; held only while a flow view is on screen. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**FlowOrchestrator**  
Production entry point wiring Cartographer, Wardens and Librarian into pre-message and post-action; runs in start.ts. *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**FlowOrchestrator.brief**  
Asks the chorus once over a subagent's task text (`handoffText`) at spawn. *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

**FlowOrchestrator.consume**  
Asks the chorus once per consumed work item through the advice protocol. *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

**FlowOrchestrator.postAction**  
Runs the turn's one guard over its guardable calls, not awaited; the chorus never holds the hand-back. *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

**flowSnapshot**  
Server-side bounded snapshot for the flow stream; provider payloads reduced to counts. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**Fluid / Formal / Compiled**  
The three corpus stages writeback feeds: raw signals, reviewed conventions, the session's effective context. *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**Forge Master**  
Pinned workspace entry shown instead of a scope's threads (forgeMasterOpen). *Region:* [Viewer dashboard shell](viewer/knowledge.md)

**foundry MCP server**  
Seven tools: foundry_device, foundry_query, foundry_conventions, foundry_memory, foundry_access, foundry_threads, foundry_signal. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**foundry MCP server**  
The MCP server named foundry in a native session, scoped to the calling thread's project. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**foundry repeats**  
CLI (runRepeats, repeatReport) listing corrections given more than once across past sessions. *Region:* [Feedback and corrections](feedback/knowledge.md)

**foundry-acp**  
@inixiative/foundry-acp (packages/acp, MIT): the stdio ACP agent, a loopback client of the daemon. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**foundry-acp setup**  
bunx @inixiative/foundry-acp setup: global install, launchd daemon, host settings for Paseo and T3; macOS only. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**.foundry-auth-lock**  
Exclusive single-owner profile lock (non-subscription native profiles); shared holders and it refuse each other. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**foundry-dispatch**  
A dispatcher generation: a background subagent that starts Warden spares and absorbs their endings. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**foundry-jobs**  
The BullMQ queue on Redis that background jobs run on. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**foundry-root**  
The never-ending background root agent that starts dispatcher generations. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**foundry-warden**  
The one generic Warden agent definition; each spawn's prompt is pinned to its composed text. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**.foundry/audit.jsonl**  
Audit log: a before/after row per committed settings change (`GET /api/settings/history`). *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**~/.foundry/device.json**  
This machine's random stable device UUID, mode 0600, shared by the user's installations. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**.foundry/project.json**  
The repository's committed Foundry settings; only `chorus` (and `$comment`) is read, any other key makes the file ignored. *Region:* [A project's region Wardens](chorus/knowledge.md)

**.foundry/project.json**  
A repository's committed project settings (e.g. `chorus`); machine settings win key by key. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**.foundry/releases/state.json**  
Release state: stable, previous, candidate and failed SHAs. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**.foundry/settings.json**  
Runtime config: default provider/model, vendors, agents, composition, layers, sources, projects. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**Foundry: context**  
The think tool_call opened at send, completed with routing and Warden decisions. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**Foundry: guard**  
The think item showing guard findings as comments; never a block. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**Foundry: guard**  
How a Warden finding on a tool call shows in a host: a comment that never blocks. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**foundry_access**  
Native bridge tool for Claude/Codex: actions integrations, describe, read. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**FOUNDRY_ACP_LAUNCH**  
Overrides the launch file path (tests, a second Foundry); with it set foundry-acp never starts a daemon. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**foundry_conventions**  
MCP tool: a domain's reviewer instructions, domain knowledge and thread-private knowledge. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**foundry_device**  
Read-only MCP tool reporting the active device and checkout for the bound thread's project, labelled session-bound. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**foundry_device**  
MCP tool: this session's enrolled device and bound checkout only. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**foundry_memory**  
MCP tool: search or fetch the thread's retained memory records with provenance. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**foundry_query**  
MCP tool: search the thread's current context layers for a topic. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**foundry_signal**  
MCP tool: report an observation; disabled on the read-only native grant. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**FOUNDRY_STARTUP_SELF_TEST**  
Env flag (=1) that lets startup make a model call; in subscription mode it consumes a decision allowance. *Region:* [Subscription-only policy](subscription-policy/knowledge.md)

**foundry_test**  
The local test database: `bun run db:push:test` then `bun run test:db`. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**foundry_threads**  
MCP tool: summaries of other live threads in the same project. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**FOUNDRY_VCR**  
`record` or `replay`: sets the VCR mode explicitly. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**FOUNDRY_VCR_MAX_LIVE**  
Cap on live calls per process (default 80). *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**FoundryClient**  
Client for the daemon's loopback HTTP API, the same routes the viewer uses; refuses redirects, keeps the bearer on origin. *Region:* [Threads and the turn path](threads/knowledge.md)

**Four communication channels**  
Pre-message, mid-session MCP, post-action native event stream, and feedback on a later turn. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**freshness check**  
Part of `bun run test`: fails on age, old CLI or agent-session version, pending drift, or a leak. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

## G

**gate-request / gate-outcome**  
Journal phase rows recording each gate request and its result in session_phase. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**gateway mode**  
Source that points the CLI at a token-based inference endpoint (`baseUrl`) with an environment or command credential. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**general files**  
Unslotted files (CLAUDE.md, AGENTS.md, rules, auto memory); composition.roles.<role>.<slot>.general picks whose compose. *Region:* [Standing instructions and composition](composition/knowledge.md)

**git-worktrees**  
Class: git and worktree detection, a thread's worktree and branch. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**gitContext**  
Origin remote, branch and worktree root for the checkout containing a directory, in one call. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**global scope**  
Where a thread goes when its cwd is in no registered project (no projectId). *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**Global scope**  
Unscoped threads: activeProjectId is null. *Region:* [Viewer dashboard shell](viewer/knowledge.md)

**gloss**  
Gloss margin notes in the viewer: viewing, maintenance actions, boundaries. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**.gloss/ sidecar**  
Gloss's mirrored Markdown margin-note file beside a TypeScript source. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**GlossService**  
Runs Gloss operations per project in bounded child processes, maintenance exclusive per root. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**GraphPanel**  
The viewer's graph panel (center → Graph, or g) with threads, turn and loop tabs. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**guard-request / guard-outcome**  
Journal rows wrapping a turn's guard: one request per asked Warden, one outcome, `wraps: turn:<id>`. *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

**guard: "per-call"**  
Setting that restores a guard per tool call; the default is one guard per turn. *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

**GUARD_RESPONSE_PROTOCOL**  
Advisory-only guard contract; its validator refuses critical severity or a suggestion. *Region:* [Warden classification primitive](classify/knowledge.md)

**guardFn**  
A programmatic guard the Memory Warden was designed to use; none is supplied, so it runs the LLM guard. *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

**guardTriggers**  
A Warden's trigger list; it guards once per turn when one names a call of the turn. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**guardTriggers**  
The tool names whose calls make a Warden's guard fire for the turn. *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

## H

**Haiku 5.5**  
The default model for classifiers, routers and Wardens unless a Warden stage names its model. *Region:* [Repo structure and conventions](conventions/knowledge.md)

**handoff**  
Tunnel token Kingdom presents to `POST /api/handoff`; mintHandoffCode / redeemHandoffCode hand a browser to the tunnel session. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**handoff / handoff-return**  
Parent journal rows for a subagent spawn (task hash and excerpt) and its result (outcome, excerpt, usage). *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**handoff brief**  
Notes from the subagent-spawn trigger, delivered as "The <domain> Warden chimed in on the handoff to <description>:". *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

**Harness**  
Entry point for external messages: classify → route → dispatch, with a full Trace per message. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**HarnessSession**  
agent-session's provider-agnostic contract: start / send / kill / fork / interrupt plus an event handler; optional transport, interruptNative, readLimits. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**harvest**  
Gloss maintenance that migrates source comments into sidecars; ongoing via harvest --staged pre-commit. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**hedgeAfterMs**  
A decision still running past this starts the same input on a second branch; first to finish wins (Codex 4000). *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**Herald**  
Cross-thread watcher with pluggable detectors; exists in agents/herald.ts but is not wired. *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**Herald detectors**  
ContradictionDetector, ConvergenceDetector, CrossPollinationDetector, DuplicationDetector, ResourceImbalanceDetector. *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**hierarchyFingerprint**  
One stat per consulted path to detect a change before recomposing. *Region:* [Standing instructions and composition](composition/knowledge.md)

**holdStream**  
Viewer store: open a stream for a panel, deliver its frames, return the release function. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**Horizon alignment**  
The goal: the agent's output converging on the project's standards, not more autonomy. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**html**  
htm tagged template bound to Preact (ui/lib.js); the viewer's markup, instead of JSX. *Region:* [Viewer dashboard shell](viewer/knowledge.md)

**HttpApi**  
ApiTool over fetch with typed responses, bearer auth, allowedUrls and maxResponseSize truncation. *Region:* [Agent tools and execution environments](tools/knowledge.md)

**httpCassettes**  
A cassette-backed fetch for Kingdom endpoints; replay refuses a different method or path. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**HttpMemory**  
Generic REST adapter over fetch for remote knowledge bases and vector DB APIs. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**HydrationAdapter**  
Hydrates ContextRefs for one system, optionally in batches (hydrateBatch). *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**HydrationRegistry**  
Routes refs to per-system hydration adapters and hydrates them in parallel batches. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

## I

**idAtTime / timeFromId**  
Synthesize a UUID v7 for a cutoff date for id range queries / read the creation time back out of an id. *Region:* [Threads and the turn path](threads/knowledge.md)

**ImageAttachmentStore**  
Stores message image bytes once each by content hash under the config directory. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**imageMediaType**  
Detects an image's real type (png, jpeg, gif, webp) from its byte signature, ignoring claimed headers. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**@import**  
Claude Code's @path include; four hops, inside the repository for project, org and local files. *Region:* [Standing instructions and composition](composition/knowledge.md)

**in-session-wardens**  
This region's class: Wardens held as subagents inside the thread's own Claude Code process. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**IN_SESSION_DECISION_CONTEXT**  
Exported constant of providers/in-session-wardens.ts. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**inbox**  
An item's status: open until a feedback-status row archives it (POST /api/feedback/status). *Region:* [Feedback and corrections](feedback/knowledge.md)

**@inixiative/agent-session**  
The native Claude Code and Codex session library foundry's native providers use. *Region:* [Repo structure and conventions](conventions/knowledge.md)

**@inixiative/agent-session**  
Published package that drives coding-agent CLIs as persistent, streaming, event-captured sessions; Foundry pins it through bun.lock. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**@inixiative/archive/remote**  
HTTP client (ArchiveClient) Foundry writes captures through. *Region:* [Local Archive and session capture](archive/knowledge.md)

**@inixiative/foundry**  
packages/foundry: opinionated framework (agents, providers, tools, viewer, jobs); BSL 1.1, MIT on 2030-04-06. *Region:* [Repo structure and conventions](conventions/knowledge.md)

**@inixiative/foundry-acp**  
packages/acp: the ACP agent hosts (Paseo, T3 Code, Zed) drive; MIT. *Region:* [Repo structure and conventions](conventions/knowledge.md)

**@inixiative/foundry-core**  
packages/core: minimal engine, primitives and pure data, zero opinions; MIT. *Region:* [Repo structure and conventions](conventions/knowledge.md)

**@inixiative/foundry/client**  
Wire types, loopback HTTP client, data-stream socket client, launch file reader, launchd starter; foundry-acp's only import. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**@inixiative/foundry/client**  
The daemon client, the only Foundry import foundry-acp may use to drive threads. *Region:* [Repo structure and conventions](conventions/knowledge.md)

**@inixiative/foundry/runtime**  
The only entrypoint outside consumers import: KingdomInstallationConnection, SignetClient, SignetHttpError, kingdomIntegrationSchema. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**@inixiative/gloss**  
The pinned Gloss library (0.0.4) the viewer runs as its own adapter. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**InMemoryExternalSessionStore**  
In-memory thread-to-native-session id map for tests or ephemeral runs. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**InSessionWardens**  
Holds each thread's in-session Warden host and routes that thread's Warden calls to it. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**inspectReadiness**  
Readiness of local config without building providers or dispatching work. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**Installation**  
A local Foundry, Archive or Oracle known to Kingdom by its own key (`installation-key.json`, 0600). *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**installationName**  
This Foundry's name, used by Kingdom pairing. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**instruction-ladder**  
Class: standing instructions, the registered hierarchy (computer, org, project, personal), discovery like Claude Code, @imports, tiers and dedupe. *Region:* [Standing instructions and composition](composition/knowledge.md)

**instructions source**  
Source type `instructions` on the default `instructions` layer; composes the ladder for the thread's location on each warm. *Region:* [Standing instructions and composition](composition/knowledge.md)

**Integration**  
What Kingdom mints for an owner when they approve a registration; holds Signets; identified by `integrationId`. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**Integration limits**  
Local profile references are not Kingdom capacity grants; an execution contract must authorize roles, models and budgets itself. *Region:* [Subscription-only policy](subscription-policy/knowledge.md)

**integrationId**  
The identity name everywhere; legacy `connectionId` / `connectionIds` configs are rejected. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**interruptNative**  
HarnessSession stop that waits for the runtime's own terminal; unlike interrupt(), a confirmed stop settles native ownership. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**InterventionLog**  
Records manual operator overrides on a trace span and emits a correction signal with confidence 1.0. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**invalidateComposition**  
Marks every live role slot stale so the next turn re-reads; call after writing a role or instruction file yourself. *Region:* [Standing instructions and composition](composition/knowledge.md)

**isOpenTurn**  
Tells whether a turn status is accepted but not yet settled. *Region:* [Threads and the turn path](threads/knowledge.md)

## J

**Jev**  
TypeSafe's typed-decision model (`jev-latest` by default); for bounded judgments like domain, urgency or topic change. *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

**jobs**  
Class: BullMQ queue on Redis, makeJob / makeSingletonJob, worker, handlers. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**journal**  
Class: the local journal, LocalSessionStore, phase rows, content-addressed records and image attachments. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**journal.rawMiddlewareDays**  
Setting (default 30) after which raw advice/guard/route rows of reduced turns are pruned. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**journal.rawMiddlewareDays**  
Retention days for raw middleware journal rows (default 30). *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**judge**  
Judges one Warden remark with the provider, retrying a failed call up to twice. *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

**JustBashShell**  
ShellTool over the just-bash interpreter: an in-memory filesystem seeded with files, nothing touches disk. *Region:* [Agent tools and execution environments](tools/knowledge.md)

## K

**Kev-4B**  
The local pre-filter model (Qwen3.5-4B + LoRA, MLX) served on the System One API. *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

**Kingdom**  
The permission hub: owners, Integrations, Inquiries and Signets; enforces every grant server-side. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**kingdom-access**  
Class: Kingdom resource access grants and the foundry_access tool: configure, describe, read, attribution, failures. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**kingdom-pairing**  
Class: pairing a Foundry with Kingdoms as an Installation: connection, held Signets, holders, the runtime seam. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**kingdom-token-helper.ts**  
Bundled helper that issues and renews Kingdom gateway tokens, enforcing autoRenew. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**kingdom_request**  
The same access adapter for Foundry's API-backed tool loop (url = integrations | describe | read | close). *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**kingdomAccess**  
Setting list of resource grants: id, url, credentialFile, integrationId, signetId, projectIds, optional threadIds. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**KingdomAccessClient**  
Reads through an access grant with single, non-retried, non-redirected requests, bounded to 1 MiB. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**KingdomAuthentication**  
Holds Kingdom inference sources (Signets by owner) and resolves which login a native run uses. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**KingdomClient**  
Presents the held Signet for native-run inference actions: resolve, delegate, revoke. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**kingdomInference**  
Kingdom sources keyed by owner key with a Signet `credentialFile`; with defaults.kingdomOwnerKey and kingdomInferenceAssignments. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**KingdomInstallationConnection**  
The Installation's live socket to one Kingdom; syncs held Signet files from pushed snapshots. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**KingdomInstallationConnections**  
One KingdomInstallationConnection per paired Kingdom, isolating failures. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**kingdomIntegrationId**  
Stable paired-Kingdom id derived from API origin + owner; survives re-pairing. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**kingdomIntegrations**  
Setting recording each pairing as `{ url, integrationId, owner, signetId }`. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**KingdomSubscriptionAuthentication**  
Runs main threads on a Kingdom-chosen pool login, token released per launch and held only in memory. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**knowledge.md**  
A region's full knowledge, the Warden's `domainKnowledge` slot through the generated `region:<id>` source. *Region:* [A project's region Wardens](chorus/knowledge.md)

**KnowledgePersistence**  
Connects a thread's learning lifecycle to the local journal, withholding learning on durability failure. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

## L

**largestRoster**  
The largest chorus any project runs; sizes the primed decision pool with `largestStageCount`. *Region:* [A project's region Wardens](chorus/knowledge.md)

**largestStageCount**  
The most classify stages any chorus asks per Warden; each stage has its own primed session. *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**last-good settings**  
The settings saved after the last successful boot (recordBooted), restored when a boot fails. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**lateBoundToolGate**  
Gate resolver handed to a provider before the viewer exists; fails closed. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**LaunchAgent**  
The macOS launchd job (DAEMON_LABEL) the daemon runs as; installed by `bun run daemon:install`. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**Layer staleness timer**  
lastWarmed + staleness marks a layer stale, triggering re-warm and map rebuild. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**layer state**  
cold | warming | warm | stale | compressing, observed with onStateChange. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**learningLoop**  
The per-domain learning loop across a flow's recent turns. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**LearningSettings**  
Learning configuration checked by validateLearningSettings and resolved by resolveLearningSettings. *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**legacy starter**  
The old seeded stack (system/conventions/memory layers, classifier, router, prompt-only executors); removed when unedited. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**Librarian**  
The singular signal reconciler and sole writer to thread-state; not a Warden. *Region:* [Repo structure and conventions](conventions/knowledge.md)

**Librarian**  
The singular agent that is sole writer to the thread-state layer and keeps the injection ledger. *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**Lifecycle hooks**  
16 hook points (pre/post dispatch, execution, layer warm/stale, session events) registered in a HookRegistry. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**LINEAR_ISSUE_TOOLS**  
Glob patterns matching a Linear issue fetch under any MCP server name. *Region:* [Agent tools and execution environments](tools/knowledge.md)

**live-first testing**  
Live runs against real CLIs and launchd are the truth; replays give fast deterministic parsing and stay fresh. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**LIVE_FILES**  
The test files in scripts/vcr/shared.ts whose transports are cassettes; test:live records them. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**LLMProvider**  
Interface `{ id, complete(messages, opts) }`, streaming via AsyncGenerator<LLMStreamEvent>; all API-key providers implement it. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**local Archive**  
The one Archive per machine: Docker Compose server + Postgres on 127.0.0.1:4700; holds the database. *Region:* [Local Archive and session capture](archive/knowledge.md)

**localArchive()**  
How every Archive client finds the server: ARCHIVE_URL or 127.0.0.1:4700, token from ARCHIVE_TOKEN or server.token. *Region:* [Local Archive and session capture](archive/knowledge.md)

**LocalSessionStore**  
The local journal: phase rows per turn, committing a completed response with its artifact. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**LocalSessionStore.appendPhase**  
Appends an immutable phase row; edits outside any turn go on the item's origin thread with turnId null. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**logger**  
Class: pluggable logger (consola, pino) with async scopes. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**logScope**  
Runs a function so every log inside carries a named, nestable scope tag. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

## M

**main**  
MAIN_ROLE: the fallback role when routing is weak. *Region:* [Feedback and corrections](feedback/knowledge.md)

**main thread**  
The default worker and every enabled executor; may run only on a main-thread lab. *Region:* [Subscription-only policy](subscription-policy/knowledge.md)

**MAIN_THREAD_LABS**  
Anthropic, OpenAI, Google, Meta, xAI: the only labs a main thread may run on. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**MAIN_THREAD_LABS**  
The five labs main threads may run on (Anthropic, OpenAI, Google, Meta, xAI); others, gateways and local hosts are refused. *Region:* [Subscription-only policy](subscription-policy/knowledge.md)

**mainThreadRequirement**  
Says what a provider still needs to run a main thread, applying the subscription vs API-token rule. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**makeSingletonJob**  
A job handler superseded when a newer run is queued (SupersededError). *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**MarkdownDocs**  
Reads a directory of .md files as context, cached by mtime; system "markdown" for refs. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**markEvalRun**  
Marks a process and state dir as an eval run so Archive and repeat reports skip it. *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

**mcp-bridge**  
The foundry MCP server a native session calls mid-session, its tools, loopback proxy, live authority and fixture bridge. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**memory-adapters**  
Class tag: memory and knowledge adapters (file, sqlite, http, markdown, postgres, redis, Muninn, Supermemory) as context sources and the MemoryTool. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**memoryRoot**  
The directory that keys a repository's auto memory, mapping worktrees to their main checkout. *Region:* [Standing instructions and composition](composition/knowledge.md)

**MemoryToolAdapter**  
Wraps any memory adapter (fromFileMemory, fromSqliteMemory, fromSupermemory, from) as an on-demand memory tool. *Region:* [Agent tools and execution environments](tools/knowledge.md)

**MemoryView**  
A FileMemory limited to one scope, private by default; what a thread is handed. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**mergeStoredMessages**  
Merges this tab's rows with browser storage from other tabs, never dropping stored rows. *Region:* [Viewer dashboard shell](viewer/knowledge.md)

**Message**  
Prisma model: Postgres conversation rows grouped by turnId; not the local session store. *Region:* [Threads and the turn path](threads/knowledge.md)

**Mid-session MCP pull**  
The running session pulls missing context through the foundry MCP server's tools. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**Middleware tiers**  
Always, on domain shift, on cross-cutting signals, on low confidence. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**MIDDLEWARE-ADAPTER**  
The rejected plan to bind middleware to Claude/Codex hooks; replaced by headless Foundry over ACP. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**middleware-chain**  
Class tag: MiddlewareChain, hooks, retry, built-in hooks and reactive middleware rules around a dispatch. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**middleware-reduced**  
Phase row appended at turn end per middleware call: state versions and result only, about 0.5-1 KB. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**MiddlewareChain**  
Koa-style before/after middleware on every dispatch, in two tiers: use (always) and useWhen (conditional). *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**mode sections**  
Sections a stage's modes add under classify/charters/<prompt>/modes/<mode>/; additive unless an overrides dagger replaces one. *Region:* [Warden classification primitive](classify/knowledge.md)

**model-registry**  
Class: the model registry: capability vocabulary, provider/model table, vendors with subscription and API modes. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**MODEL_REGISTRY**  
The table of providers and their models, labs and capabilities; read through the lookup helpers. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**MODEL_VENDORS**  
Vendors with their subscription and API modes, main-thread labs first. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**Module Dependency Graph**  
Import order agents → providers → adapters → eval → viewer; each imports only from those above (docs/SYSTEM.md). *Region:* [Repo structure and conventions](conventions/knowledge.md)

**moment / answer / next**  
Foundry's SDK MCP tools: hold for a moment, answer it, fetch the next spares to start. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**MuninnMemory**  
Self-hosted MuninnDB memory with decay, Hebbian strengthening and associations. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

## N

**native-auth**  
Class: which login a native session runs on: credential sources, native profiles, gateway modes, profile locks, sharing the user's own logins. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**native-profile mode**  
Source that references an existing CODEX_HOME / CLAUDE_CONFIG_DIR without copying or refreshing credentials. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**native-profile source**  
A nativeAuthentication entry naming a private (0700) profile directory: a credential reference, never a token. *Region:* [Subscription-only policy](subscription-policy/knowledge.md)

**native-sessions**  
Class: native Claude Code / Codex sessions: session adapters, SessionBacked providers, native launch and environment, thread launch choices, native evidence. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**NativeAuthentication**  
Base manager of reference-only sources; `select(threadId, sourceId)`, `revoke(sourceId)`; passed as `authentication` to the adapters. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**nativeAuthentication setting**  
Array of credential sources in .foundry/settings.json binding native sessions at launch. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**nativeAuthenticationSelections**  
Per-thread source ids; `defaults.nativeAuthenticationId` covers unassigned threads and auxiliary work. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**NativeEvidence**  
Metadata-only record of a native session's output, produced by projectNative; raw envelopes are dropped. *Region:* [Session context delivery](session-delivery/knowledge.md)

**nativeLaunchEvidence**  
Metadata-only record of launch argv, position and hash for unknown arguments; never rewrites the real argv. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**newId**  
Mints a time-sortable UUID v7 id, optionally prefixed (newId('thr')); the id carries its creation time. *Region:* [Threads and the turn path](threads/knowledge.md)

**No backwards-compat cruft**  
Remove unused systems entirely: no fallbacks, re-exports of removed types, _unused vars or shims. *Region:* [Repo structure and conventions](conventions/knowledge.md)

**No retraction**  
A dropped layer stays in the session until compaction (message) or restart (system prompt). *Region:* [Session context delivery](session-delivery/knowledge.md)

**no-intervention / review**  
Shadow outcomes: Noul ≤0.2 is no-intervention; the middle band, low Choice confidence or none is review. *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

**NO_COMMENT**  
The expected answer when nothing in the region applies: exactly NO_COMMENT, journalled as no-comment. *Region:* [Warden classification primitive](classify/knowledge.md)

**normalizeScope**  
Copies an ownership scope dropping undefined fields, for stable equality. *Region:* [Threads and the turn path](threads/knowledge.md)

**Noul**  
Jev question type that returns a yes probability. *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

## O

**observe**  
Returns a subject's existing version when its text was seen before; a reported change (record: true) always gets its own row. *Region:* [Composition audit log](audit-log/knowledge.md)

**observed child thread**  
A native subagent run recorded as a child thread; never dispatched to, no runtime, no Wardens. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**offline-fixture**  
Dry-run mode of `scripts/typesafe-shadow.ts`: scripted answers, simulated zero usage, verifies control flow only. *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

**omitted**  
Sources left out of a slot with reason: excluded-by-role, hidden-from-audience, duplicate, refused, budget. *Region:* [Composition audit log](audit-log/knowledge.md)

**onDecision**  
Caller callback that reads the validated answers and applies its own confidence / review policy. *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

**One turn path**  
Every client's turn (ACP, viewer, Oracle) runs the same accept → queue → Harness.send → middleware → executor path. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**One turn path**  
Viewer, ACP hosts and Oracle runs share TurnService.accept → SerializedQueue → Harness.send; the viewer is not an ACP client. *Region:* [Threads and the turn path](threads/knowledge.md)

**One writer, many readers**  
Wardens and guards emit signals; the Librarian reconciles and writes thread-state. *Region:* [Repo structure and conventions](conventions/knowledge.md)

**onToolRequest**  
agent-session tool gate hook: pre-use (Claude only) and permission stages; first deny wins, a throwing gate denies. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**onToolRequest**  
agent-session's HarnessSession callback: (call) => allow | {deny: reason} | {ask}. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**OpenAIProvider**  
OpenAI Chat Completions and the OpenAI-compatible family with registry-driven model differences; Azure not supported. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**openTurnDetail**  
Viewer action opening any owned turn's detail through the journal route, loaded or not. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**Oracle**  
Eval/scoring app in its own repo (../oracle), depends only on the published foundry-core. *Region:* [Repo structure and conventions](conventions/knowledge.md)

**Oracle**  
The replay test of Wardens; scores with the same foundry-core code as the charter eval. *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

**origin**  
How an item arose: detected, intervention, seed, mined or explicit. *Region:* [Feedback and corrections](feedback/knowledge.md)

**orphan**  
A nested agent whose parent ended; its own end would wake the main model, so it is never stopped; past 40 the thread stops serving in-session. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**outcome cassette**  
`outcome.<name>.json`: the conclusion Foundry reached live; every replay must reach the same one. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**outcomes**  
`binary` (yes / NO_COMMENT) or `ternary` (adds unsure, treated as no until the next stage's doc shows otherwise). *Region:* [Warden classification primitive](classify/knowledge.md)

**OutputFilter**  
A stdout transform applied before tool output enters agent context. *Region:* [Agent tools and execution environments](tools/knowledge.md)

## P

**parseWardenPointer**  
Reads remarks into { shape, pointer, where, why, level, candidates, unparsed }. *Region:* [Warden classification primitive](classify/knowledge.md)

**parts**  
A composition version's ordered source versions with heading, separator and kept range, so recompose is exact. *Region:* [Composition audit log](audit-log/knowledge.md)

**.pending.json**  
A new recording awaiting review beside the kept committed cassette. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**per-turn text**  
Cartographer routing, Warden notes (placement after-message) and thread-state, sent every turn and never in the base. *Region:* [Session context delivery](session-delivery/knowledge.md)

**--permission-mode**  
foundry-acp flag giving a default mode for every session a host opens; a host-chosen mode wins. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**permissionLevel**  
Core lookup of the level a policy gives a capability, without prompting (packages/core/src/capability.ts). *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**personal rung**  
A role file kept out of git (guardPersonalFile); committed rungs change through a pull request. *Region:* [Feedback and corrections](feedback/knowledge.md)

**perTaskStopAffordance**  
`initialize` flag that makes the user's Stop interrupt the main turn without killing background Wardens. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**phase row**  
One immutable, checksummed session_phase row of a turn (route, advice, guard-*, handoff, middleware-reduced, ...). *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**planModeHook**  
Built-in pre:dispatch hook applying plan-mode behaviour from a PlanModeConfig. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**Planner**  
Agent that generates a structured plan as a DAG of steps executed in dependency order. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**PlaywrightBrowser**  
BrowserTool over Playwright: navigate, snapshot, evaluate, click, fill, screenshot; contextId shares session state. *Region:* [Agent tools and execution environments](tools/knowledge.md)

**pointCharter**  
Assembles the point charter for a pointer setting, omitting choose-one when pointer.any is off. *Region:* [Warden classification primitive](classify/knowledge.md)

**pointer**  
A Warden's non-silent answer: at most three names in one of four shapes. *Region:* [Warden classification primitive](classify/knowledge.md)

**policy.json**  
`fixtures/vcr/policy.json`: maxAgeDays (14) and blessed versions. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**port registry**  
`@inixiative/config` local ports; Foundry is block 5 (viewer 4500, Postgres 5932, Redis 6879, Muninn 8975/8976). *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**POST /api/messages/send**  
Accepts a turn with 202; the reply arrives on the thread:<id> stream, not in the response body. *Region:* [Threads and the turn path](threads/knowledge.md)

**POST /api/messages/send**  
Accepts a turn with 202; its output arrives on the thread:<id> stream. *Region:* [Viewer dashboard shell](viewer/knowledge.md)

**POST /api/threads/:threadId/turns/:turnId/interrupt**  
The stop route the viewer and ACP share (TurnService.interrupt); Codex has no native stop. *Region:* [Threads and the turn path](threads/knowledge.md)

**Post-action channel**  
Tool calls observed on the native event stream; the structural tool gate answers permission requests. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**post-work review**  
After the work, every Warden reviews it under the same charter and writes its thread knowledge. *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

**PostgresMemory**  
Durable Postgres memory for entries, traces, signals and messages with pgvector search. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**Pre-message channel**  
System prompt at session start plus changed layers and Warden notes with each user message. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**pre-use stage**  
Claude's PreToolUse callback over the control protocol, run before every tool call in every mode; Codex has none. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**Preact + htm + Signals**  
The viewer UI stack: ~5KB runtime, vanilla JS, no build step. *Region:* [Viewer dashboard shell](viewer/knowledge.md)

**prefilter.enabled**  
Turns the pre-filter on; false (default) asks every Warden and starts no model server. *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

**prefilter.skipBelow**  
Score threshold (0.26): a Warden scoring below it is skipped. *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

**prefiltered**  
Journal field listing skipped Wardens with their scores on advice, guard and review records. *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

**prestartWardens**  
Pre-starts Wardens on thread start, turn landed and thread-knowledge change. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**primed keys / largestRoster**  
Primed Claude roles kept warm: 2 x Wardens + 8 (at least 16), sized from the largest chorus at startup, not a setting. *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**primed session**  
A warm per-role session primed once with role instructions and stable context, forked for each decision. *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**priming**  
A Warden's decision session primed with its composed instructions plus domain knowledge; each call forks it, a changed composition re-primes. *Region:* [A project's region Wardens](chorus/knowledge.md)

**Prisma schema**  
`prisma/schema.prisma`: Entry, Trace, Span, Signal, Intervention, ThreadState, Message; Postgres with pgvector. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**privateHome**  
Codex native-profile option: a Foundry-owned CODEX_HOME with Foundry's config.toml and a linked auth.json. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**probe**  
A moment from a real session: the user's ask, the agent's turn, the correction, and a train/test period; never committed. *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

**ProcessCassettes**  
Stands in for spawning: Claude stream-json, Codex app-server JSON-RPC and the auth status probe, ordered by stdin events. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**profileEnvironment**  
Builds the child env that selects a login profile, empty for the default location. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**Progressive depth**  
Basic layers every message; deeper layers only on domain shift, low confidence or cross-cutting signals. *Region:* [Repo structure and conventions](conventions/knowledge.md)

**Progressive depth**  
Escalate from cheap always-on layers to deeper middleware only when something triggers. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**Project / ProjectRegistry**  
A repo directory owning its threads, runtime adapter and tags / the lookup of every project by path or tag. *Region:* [Threads and the turn path](threads/knowledge.md)

**project link**  
A separate record relating existing project ids across devices; never rewrites ids, grants or history. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**ProjectCapacityAuthentication**  
Routes each thread to its project's capacity: local login or Kingdom pool. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**projectNative**  
The single translation boundary from raw native output to NativeEvidence. *Region:* [Session context delivery](session-delivery/knowledge.md)

**projects[id].agents**  
Project agents: standalone or `extends: <global id>` with optional `override`; never Wardens. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**projects[id].chorus**  
The machine's chorus setting `{ enabled?, regions? | layers?, consumed?, reception?, wardens? }`; wins key by key over the repository's. *Region:* [A project's region Wardens](chorus/knowledge.md)

**Prompt-layer pairing**  
Each layer's prompt goes in as its own block so the model knows why that context exists. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**Prospector**  
foundry-core's correction detector (packages/core/src/feedback/correction.ts). *Region:* [Feedback and corrections](feedback/knowledge.md)

**protectedPaths**  
Paths whose writes are classified with file:write and checked by the gate; project and global lists add up. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**protocol drift**  
A new or missing event kind, changed field or exit code; held back as `.pending.json`, run fails. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**providerMessages**  
What the executor handed the provider; not what the session received. *Region:* [Session context delivery](session-delivery/knowledge.md)

**providers/session-delivery.ts**  
The provider code deciding which parts to send a native session each turn. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**providerUsage**  
The provider's original usage object kept on each record, including service tier and future tags. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**pruneRawMiddleware**  
Deletes raw middleware rows of reduced closed turns past the window, then sweeps unreferenced content; on start and every 6 hours. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**Pull over push**  
Inject predicted context; let the session pull the rest via MCP. *Region:* [Repo structure and conventions](conventions/knowledge.md)

## Q

**queued**  
Turn status for messages typed during setup; sent in order when ready, failed by restart recovery. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**queueNotes**  
Queues Warden notes to ride the parent's next user message. *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

## R

**ranked pointer**  
Shape `one`: 'Look over here: <name> (<where>)' then up to two 'Less likely' lines. *Region:* [Warden classification primitive](classify/knowledge.md)

**rate_limit event**  
Account-level limit reading from a session (unattributedReason account-status), never part of a turn's output. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**Re-alignment tax**  
The recurring cost of steering agents back to the project's standards, which Foundry exists to remove. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**ReactiveMiddleware**  
Fires reaction rules after each dispatch to emit signals, re-warm layers or write memory. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**readInstructionFile**  
Loads an instruction file and its imports the way Claude Code loads CLAUDE.md. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**readPrivateJson**  
Reads a private JSON object, refusing symlinks, loose modes and oversize files. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**readStageAnswer**  
Reads a stage's answer strictly under its protocol, counting malformed ones as errors. *Region:* [Warden classification primitive](classify/knowledge.md)

**reason**  
`none` (live default), `inline`, or `followup` ('why?' asked after a yes or unsure). *Region:* [Warden classification primitive](classify/knowledge.md)

**recall / skip rate**  
Share of relevant (moment, Warden) pairs still asked / share of all pairs not asked. *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

**RECOGNISE_CHARTER**  
The charter for recognise stages, which only name the regions a moment is in. *Region:* [Warden classification primitive](classify/knowledge.md)

**recompose**  
recompose(cv, retrieved): rebuild a slot's exact text from its parts and verify it against composedHash. *Region:* [Composition audit log](audit-log/knowledge.md)

**reconcileThreadMessages**  
Refreshes one thread's in-tab message cache from the journal, keeping tab-only state. *Region:* [Viewer dashboard shell](viewer/knowledge.md)

**recordedClaudeTransport**  
Test helper (tests/helpers/vcr.ts) exposing launches, writes and statusChecks like the fake transports. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**recordWindows / windowDelta**  
Store a reading of a login's usage windows; compute growth between two readings, listing reset windows separately. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**recurrence**  
A capture matched to an existing item by matchExisting; carries that item's id. *Region:* [Feedback and corrections](feedback/knowledge.md)

**recycle**  
Past 100k tokens of dispatcher context a new generation starts and the old one ends into the root, no main turn. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**RedisMemory**  
Redis-backed shared, ephemeral memory with TTLs and a signal publisher; ioredis peer dep. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**Reduced middleware entry (mw:<callId>)**  
The Archive entry shape of one middleware call: role, trigger, wraps, decision, result, state, timing, usage. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**reduceMiddleware**  
Turns one turn's raw middleware rows into reduced entries for the archive snapshot. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**referencedHashes**  
Lists the content hashes a stored JSON record references directly. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**references**  
Links to integration items (GitHub repo/branch/PR, Linear issue) found in a session; a mention, not proof. *Region:* [Local Archive and session capture](archive/knowledge.md)

**RefSource**  
A ContextSource whose content is a set of refs hydrated through the registry on warm. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**refused setting**  
A setting subscription mode cannot enforce (non-subscription worker, decision agent with tools or temperature) is refused, not routed. *Region:* [Subscription-only policy](subscription-policy/knowledge.md)

**refuseHandNamedWardens**  
Settings validation refusing any `domain-advising`, `domain-librarian` or `decider` agent in `agents` or `projects[id].agents`, by name. *Region:* [A project's region Wardens](chorus/knowledge.md)

**refuseHandNamedWardens**  
Refuses domain-advising, domain-librarian or decider agents in settings by name, with the fix. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**region Warden**  
A Warden generated from one `<project>/.foundry/regions/<id>/` directory; the only kind of Warden since 2026-10-17. *Region:* [A project's region Wardens](chorus/knowledge.md)

**region.json**  
A region's id, title, routing line, concepts, sources, tokens and `role` (warden or herald); `stages` or `charter` there are refused. *Region:* [A project's region Wardens](chorus/knowledge.md)

**REGION_GUARD_TRIGGERS**  
The write and exec tool names whose calls reach a region Warden's guard. *Region:* [A project's region Wardens](chorus/knowledge.md)

**REGION_WARDEN_INSTRUCTIONS**  
The generic region Warden instructions; `regionInstructions` adds the region's title and routing line. *Region:* [A project's region Wardens](chorus/knowledge.md)

**regionKey**  
A region's warm-cache key: the content hash of its composed knowledge, independent of project, layer and directory. *Region:* [A project's region Wardens](chorus/knowledge.md)

**regionWardens**  
Generates one `domain-librarian` Warden per region with `invocation: always` and the write/exec guard triggers. *Region:* [A project's region Wardens](chorus/knowledge.md)

**registerConfigValidator**  
Adds a check that runs on every validateConfig. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**registered hierarchy (ladder)**  
The ladder or tree of nodes, each a level, shared or personal, with its files and corpus tier. *Region:* [Standing instructions and composition](composition/knowledge.md)

**rehydrate**  
Fills cassette placeholders back in with this replay's directories. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**release**  
An exported commit with its own install under `.foundry/releases/<sha>`; the daemon runs this, not the working checkout. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**renameThread**  
Viewer action setting a person's name on a thread, or handing naming back to the agent with an empty name. *Region:* [Threads and the turn path](threads/knowledge.md)

**repo-structure**  
Class: packages and their boundaries (core vs foundry vs acp), tech stack, licenses, dev commands. *Region:* [Repo structure and conventions](conventions/knowledge.md)

**resolveDaemonPath**  
Computes the PATH the LaunchAgent needs so bun, claude, codex and node resolve; live tiers use it too. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**resolveProjectView**  
Resolves a project's view: composed layers, generated Wardens (`scope: project-generated`) and `view.chorus`. *Region:* [A project's region Wardens](chorus/knowledge.md)

**resolveSubscriptionPolicy**  
Resolves subscription mode (default) versus API tokens, checking login locations at startup. *Region:* [Subscription-only policy](subscription-policy/knowledge.md)

**responseProtocol**  
Builds a stage's response protocol from its spec; the default reproduces the advice and guard protocols. *Region:* [Warden classification primitive](classify/knowledge.md)

**RESTRICTED_POLICY**  
Preset policy that denies dangerous operations and allows reads and cheap LLM calls. *Region:* [Agent tools and execution environments](tools/knowledge.md)

**retrieved**  
Placeholders for focus-dependent sources whose text is stored raw with each call. *Region:* [Composition audit log](audit-log/knowledge.md)

**review code**  
Code printed by pairing that an owner claims in Kingdom (a `registerIntegration` Inquiry) to approve it. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**review findings**  
Reading review comments as corrections (reviewFindingMessages, parseReviewFindings, authorshipOf). *Region:* [Feedback and corrections](feedback/knowledge.md)

**role**  
A composing party: main, each Warden by its region id, the Cartographer; the Librarian composes nothing. *Region:* [Standing instructions and composition](composition/knowledge.md)

**role file**  
.foundry/roles/<role>/<slot>.md at a rung (.local.md for personal), overlaying one role's slot. *Region:* [Standing instructions and composition](composition/knowledge.md)

**role:<role>:instructions / role:<role>:domainKnowledge**  
A middleware role's private layers, off the thread stack so the executor never receives them. *Region:* [Standing instructions and composition](composition/knowledge.md)

**routed agent**  
A non-executor agent saved with another provider or model, run on the decision profile at startup and listed in the startup log. *Region:* [Subscription-only policy](subscription-policy/knowledge.md)

**routedAgents**  
Builds the classifier and router agent settings on the decision profile ahead of the Artificer. *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**routeFeedback**  
Assigns a sharpened rule to the Warden roles owning its domain, falling back to main. *Region:* [Feedback and corrections](feedback/knowledge.md)

**Router**  
Decider returning a Route (destination, priority, contextSlice) from a pre-warmed topology. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**rtk**  
The default RTK-style filter stack, all built-in filters composed (~60-80% savings). *Region:* [Agent tools and execution environments](tools/knowledge.md)

**run tags**  
`run:test`, `run:oracle`, `run:foundry`: sessions that are not a person's work; kept but exempt from learning. *Region:* [Local Archive and session capture](archive/knowledge.md)

**runArchiveCli**  
Spawns the Archive CLI in a subprocess; Foundry never imports it (it would resolve Foundry's Prisma client). *Region:* [Local Archive and session capture](archive/knowledge.md)

**rung**  
A ladder position: computer, org, org personal, project, project personal. *Region:* [Standing instructions and composition](composition/knowledge.md)

**rung**  
Level of the instruction ladder a line is written to: computer, org, org-personal, project, project-personal. *Region:* [Feedback and corrections](feedback/knowledge.md)

**runProxy**  
The stdio proxy that forwards a host's MCP calls to the loopback bridge. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**runStages**  
Runs a Warden's classification stages and returns the combined result. *Region:* [Warden classification primitive](classify/knowledge.md)

## S

**sameAsLive**  
Test helper proving a replay reaches the same outcome as the live run. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**scopedProvider**  
Wraps a provider so every call carries a fixed threadId and cwd. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**Score**  
Jev question type that scores a value and reports a confidence. *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

**scrubbing**  
Paths to {{cwd}}/{{tmp}}/~, tokens, emails, identity keys and account connectors redacted before writing. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**scrubSecrets**  
Replaces credential-shaped substrings in feedback transcripts and counts the hits. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**secretInText / unredactedSecretInText**  
Patterns for Kingdom secrets in text; the unredacted one asserts nothing leaked. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**secrets**  
Class: credential references, private 0600 files and tokens, bound launch environments, secret detection and scrubbing. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**Selection panel**  
The viewer panel listing composed files, files hidden from the audience, refusals and duplicates. *Region:* [Standing instructions and composition](composition/knowledge.md)

**selectMemory**  
Chooses which visible memory records to inject within a budget, reporting selected and omitted. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**selectScope**  
Switches the workspace to Global (null), a project, Forge Master ('forge') or the Feedback inbox. *Region:* [Viewer dashboard shell](viewer/knowledge.md)

**self-chat**  
The single long-lived foundry-self helper chat (FoundrySelfChatStore, SelfChatPane). *Region:* [Viewer dashboard shell](viewer/knowledge.md)

**sendToStreamLocal**  
Fan a frame out to every connection holding a stream, each with its own seq. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**seq**  
Per-connection, per-stream counter used only for gap detection. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**SerializedQueue**  
The per-thread queue a turn sent to a busy thread waits in. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**SerializedQueue (per thread)**  
A busy thread queues its next turn; a cancel before start never dispatches (CANCELLED_BEFORE_START). *Region:* [Threads and the turn path](threads/knowledge.md)

**serve --sync**  
The Archive server's onward publication to destinations every 30 s, with backoff. *Region:* [Local Archive and session capture](archive/knowledge.md)

**servedModel**  
Which model actually served a completion: native configuration first, else the provider's model. *Region:* [Session context delivery](session-delivery/knowledge.md)

**Session store**  
Append-only event log of a session; thread-state is a materialized view derivable from it. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**session-delivery**  
Class: what a native session receives each turn: standing parts in the system prompt, per-turn deltas, the delivery ledger and delivery evidence. *Region:* [Session context delivery](session-delivery/knowledge.md)

**session/request_permission**  
How an ActionQueue prompt for the thread reaches the host; carries rawInput and locations. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**session/update**  
ACP notifications foundry-acp sends: message chunks, tool_call and tool_call_update, plan, mode updates. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**session_compacted**  
Compaction event that clears the ledger; conversation-only parts are re-sent. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**session_compacted**  
Native compaction event; it clears the delivery ledger so conversation-only parts are sent again. *Region:* [Session context delivery](session-delivery/knowledge.md)

**SessionBackedProvider**  
LLMProvider served by persistent native sessions, routing each request to its thread's gate. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**SessionBackedProvider.observeSubagents**  
Hands subagent events carrying parentToolUseId to subagent observers instead of dropping them. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**SessionBackedProvider.open**  
Opens the thread's session on its first accepted turn, provisionally; relaunches with setup if the turn changes model or launch settings. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**SessionDelivery.held**  
The ledger of held part hashes the executor passes to the provider each turn. *Region:* [Session context delivery](session-delivery/knowledge.md)

**sessionId**  
The ACP session id, equal to the Foundry thread id. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**SessionManager**  
Holds the tree of threads; resolve / dispatch spawn a missing thread lazily from a registered blueprint. *Region:* [Threads and the turn path](threads/knowledge.md)

**SessionManager.addBlueprint**  
Registers a match (string or RegExp) and create function that spawns threads for unknown destinations. *Region:* [Threads and the turn path](threads/knowledge.md)

**SessionManager.inheritLayers**  
Builds a child thread's stack from the parent's layers: share (same instance) or copy (snapshot). *Region:* [Threads and the turn path](threads/knowledge.md)

**sessionTurn**  
Builds one later turn: unheld parts as deltas plus the per-turn text. *Region:* [Session context delivery](session-delivery/knowledge.md)

**settings**  
Class: the settings model: .foundry/settings.json, ConfigStore with patch semantics and revisions, resolution, settings routes. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**Settings panel**  
Agents, Layers, Providers, Sources, Defaults tabs; FOUNDRY_SETTINGS and PROJECT_SETTINGS list the sections. *Region:* [Viewer dashboard shell](viewer/knowledge.md)

**settings-history.jsonl**  
The retired settings history file; a hard cut, no longer written, read or migrated. *Region:* [Composition audit log](audit-log/knowledge.md)

**settings.rejected-<ts>.json**  
Where settings that failed to boot are set aside. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**settleTask**  
Signet action posting a task-settlement request; never renews or auto-retries; receipts gate output. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**setup**  
Class: setup, doctor, readiness, legacy starter removal, docs scan, startup self-test, the foundry CLI. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**setup turn**  
A hidden Foundry-authored turn (`actor: 'foundry'`, `kind: 'setup'`) that starts the Warden tree. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**shareable**  
Strips paths, URLs, emails, credentials and project names from repeat-report text that leaves the machine. *Region:* [Feedback and corrections](feedback/knowledge.md)

**shared holder**  
A worker or decision registered as `.foundry-auth-shared/<owner>.json` on a login for its lifetime. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**shared holder**  
The worker and decisions may both hold one login, like the user's own concurrent CLI sessions. *Region:* [Subscription-only policy](subscription-policy/knowledge.md)

**sharp**  
A rule is sharp when lintStatement passes and the model's sharp flag is true. *Region:* [Feedback and corrections](feedback/knowledge.md)

**shedding**  
A full queue drops its oldest lowest-priority wait to admit a more urgent call; shed guards report unchecked. *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**signal**  
Reactive shared UI state (ui/lib.js); the store is made of signals. *Region:* [Viewer dashboard shell](viewer/knowledge.md)

**Signal reconciliation**  
The role that consumes all signals and reconciles them into thread state; filled by the Librarian. *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**SignalBus**  
Typed pub/sub for side-channel signals by kind (correction, convention, taste, ci_rule, adr, security). *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**signals**  
Class tag: SignalBus, EventStream, interventions and action prompts / ActionQueue. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**Signet**  
Kingdom's only grant for using an integration: resources, operations, lens and limits; revocable. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**Signet credential file**  
`<configDir>/kingdom/<host>/signet-<signetId>.json` (0600): renewal credential, current DPoP access token, key path. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**SignetClient**  
Renews its access token and signs each call: describe, execute, settleTask, verifyAuthority, run actions. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**signets**  
Class: the Signet protocol and SignetClient: DPoP presentation, renewal, cancellation, task settlement. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**silence precision**  
NO_COMMENT when nothing of the Warden's applied. *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

**slot**  
instructions (system prompt) or domainKnowledge (priming context); thread knowledge is not a slot. *Region:* [Standing instructions and composition](composition/knowledge.md)

**slot**  
Where a rule line goes in a role: instructions or domainKnowledge. *Region:* [Feedback and corrections](feedback/knowledge.md)

**snapshot / append**  
Stream frames: one snapshot after open, then appends with seq + 1; no replay. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**source**  
A ladder file, a settings prompt, a domainKnowledge source, a feedback-written line, or the Warden charter. *Region:* [Composition audit log](audit-log/knowledge.md)

**source-scoped history**  
Session history keys include source UUID and configuration hash; a warm session cannot silently change sources. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**source_version**  
One change to one source subject: action, before/after hash, node and tier, actor, cause. *Region:* [Composition audit log](audit-log/knowledge.md)

**Span**  
One stage of a trace: kind, status, timing, input/output, error, annotations, context hash, layer ids, children. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**spare**  
A started Warden held on `moment`, ready to answer the next trigger. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**speak precision**  
A remark matched the user's later real correction, judged by Opus. *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

**spec B**  
THREAD-TREE.md part B: audit for composed instructions, the template's email-versioning pattern carried over. *Region:* [Composition audit log](audit-log/knowledge.md)

**splitHostInstructions**  
Separates the user's words from a host's wrapper text in a prompt (null if there is no wrapper). *Region:* [Threads and the turn path](threads/knowledge.md)

**splitSystemMessage**  
Splits messages into a system string and the remaining turns (Anthropic, Gemini). *Region:* [Models, providers and usage](models-providers/knowledge.md)

**SqliteMemory**  
bun:sqlite memory with FTS5 full-text search, recent and count queries. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**staleness**  
Milliseconds after warming before a layer is considered stale (undefined = never). *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**stampFoundryRun**  
Stamps a folder Foundry made for its own sessions with the run kind (`.archive-run`). *Region:* [Local Archive and session capture](archive/knowledge.md)

**standing instructions**  
The CLAUDE.md / AGENTS.md / rules / memory files Foundry composes into a session itself. *Region:* [Standing instructions and composition](composition/knowledge.md)

**Standing part**  
A warm layer or the executor's instructions labelled ## Context: <id>, held by the session at its current hash. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**standing part**  
A warm layer or the executor's instructions held in the session at its current hash, labelled `## Context: <id>`. *Region:* [Session context delivery](session-delivery/knowledge.md)

**standingParts / layerPart**  
Core helpers that build the labelled standing parts from the stack and its layers. *Region:* [Session context delivery](session-delivery/knowledge.md)

**started**  
Turn report status of a new native process; the ledger is reset to what that session then holds. *Region:* [Session context delivery](session-delivery/knowledge.md)

**startup self-test**  
A provider check at startup that runs only when explicitly enabled (startupSelfTestEnabled). *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**startViewer**  
Starts the viewer server with its config store (and tunnel). *Region:* [Viewer dashboard shell](viewer/knowledge.md)

**StreamBufferRegistry**  
Tracks live turns by id and pushes changes to the owning thread's open stream. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**structural tool gate**  
`turns/tool-gate.ts`, answers the CLI's permission request; the only thing that denies a tool call. *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

**structuralLevel**  
Strictest rule level (allow / prompt / deny) for a tool call, with no model call. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**subagent-spawn**  
Brief trigger when the agent hands a task to a subagent; uses the advice protocol over the task text. *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

**SubagentRecorder**  
Turns native subagent events into child threads with ThreadMeta parentThreadId, parentTurnId, depth and spawn. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**subject**  
What a source version is about: file:<realpath>, prompt:agent:<role>, source-content:<id>, charter, or a settings subject. *Region:* [Composition audit log](audit-log/knowledge.md)

**Subscription-only default**  
No API provider, no paid fallback, no automatic retry, no model substitution unless apiTokens is set. *Region:* [Subscription-only policy](subscription-policy/knowledge.md)

**subscription-policy**  
Class: subscription-only by default, apiTokens opt-in, which login and model the worker and each role use, integration limits. *Region:* [Subscription-only policy](subscription-policy/knowledge.md)

**SUBSCRIPTION_DECISION_MODELS**  
Default decision model per native runtime on a subscription login. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**SUBSCRIPTION_DEFAULTS**  
Default scheduler limits (calls, queue depths, concurrency) sized for a full Warden chorus. *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**SUBSCRIPTION_WORKERS**  
Native harnesses (claude-code, codex) that run a main thread on a subscription login, mapped to their profile. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**SubscriptionAuthentication**  
Runs the main-thread worker on this machine's subscription login, Codex on a Foundry-private CODEX_HOME. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**subscriptionOnly budgets and queues**  
maxCalls (10000), maxConcurrent (16), maxQueued (512), maxQueuedPerThread (256). *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**subscriptionOnly.decisionRuntime**  
`claude` (default), `codex` or `claude-in-session`: where decisions run. *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**subscriptionOnly.decisionSourceId**  
Optional explicit native-profile source for decisions; must match decisionRuntime when both are set. *Region:* [Subscription-only policy](subscription-policy/knowledge.md)

**subscriptionOnly.maxConcurrent**  
Decision queue size (default 16), sized for the chorus instead of asking fewer Wardens. *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

**subscriptionOnly.model / expectedObservedModel**  
The decision model (overrides classifierModel) / the id the Claude CLI must report serving. *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**SubscriptionPool**  
agent-session pool of login instances with deterministic routing over observed limits, leases and health. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**subscriptionSettingsSchema**  
Validates the optional subscription-mode overrides, each with a default. *Region:* [Subscription-only policy](subscription-policy/knowledge.md)

**SupermemoryAdapter**  
Hosted supermemory.ai memory with extracted facts, profiles and hybrid search. *Region:* [Context layers and memory adapters](context-memory/knowledge.md)

**System One API**  
`POST https://api.typesafe.ai/v1/systemone` with bearer auth; the endpoint TypeSafeDecisionClient calls. *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

**System One API**  
TypeSafe's decision endpoint (POST /v1/systemone), served locally on a loopback baseUrl for the pre-filter. *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

## T

**<t3_code_instructions>**  
T3's host instruction wrapper, stripped into turn metadata before feedback capture. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**tagger / suggestedTags**  
Haiku on primed subscription sessions suggests junk, category and project tags; suggestions are never applied. *Region:* [Local Archive and session capture](archive/knowledge.md)

**task**  
A stage's job: `recognise` (name regions) or `point` (name the system). *Region:* [Warden classification primitive](classify/knowledge.md)

**TASK_SOURCES**  
Maps native todo/plan tools (TodoWrite, update_plan) to plan entries. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**testing**  
Class: how Foundry is tested and checked: test tiers and commands, the full check, live-first practice. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**text-only launch**  
Decision processes run with no tools, empty strict MCP config, no user settings or hooks and paid credentials stripped. *Region:* [Decision hosts and scheduler](decision-hosts/knowledge.md)

**Thread**  
Core orchestrator for one unit of work: owns the context stack, agents, middleware dispatch, signal bus and status. *Region:* [Threads and the turn path](threads/knowledge.md)

**thread knowledge**  
The third slice, per call; stored raw in the content store by revision and hash, never audited. *Region:* [Composition audit log](audit-log/knowledge.md)

**thread tree node**  
One conversation (main thread or subagent at any depth), archived as its own Archive session; middleware calls are not nodes. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**Thread-state layer**  
Compact always-warm thread summary (domain, recent activity, flags); Librarian is its sole writer. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**Thread-state layer**  
The compact always-warm thread summary that only the Librarian writes. *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**thread-tree**  
Class: a thread is a tree; native subagents as observed child threads, handoff rows, reduced middleware entries, stitching into Archive. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**Thread.dispatch**  
The single entry every host's turn passes through into flow middleware, the journal and InjectionArtifact. *Region:* [Threads and the turn path](threads/knowledge.md)

**thread.fan()**  
Dispatches one payload to several agents in one thread with allSettled; returns FanResult[] per agent. *Region:* [Threads and the turn path](threads/knowledge.md)

**Thread.fromSession**  
Store replay to rebuild a thread; design only, not built. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**thread:<id>**  
Data stream of live turns: turn state, text deltas, activity rows; folded by applyTurnFrame. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**THREAD_STATE_LAYER_ID**  
The layer id the Librarian writes thread state under. *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**ThreadContextTracker**  
Tracks a thread's repository, branch, root and referenced PRs/tickets, refreshed on capture or worktree change. *Region:* [Local Archive and session capture](archive/knowledge.md)

**ThreadFactory**  
Builds a new isolated Thread from the project template, cloning warm layers and agents per thread. *Region:* [Threads and the turn path](threads/knowledge.md)

**threadGraph**  
Threads and their subagent threads as a top-down tree with folded overflow. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**ThreadKnowledge**  
A Warden's thread-private understanding, the `thread-knowledge:<domain>` layer, written only by its post-work review. *Region:* [A project's region Wardens](chorus/knowledge.md)

**ThreadLaunchSettings**  
Per-thread native launch settings: effort, permission mode, client MCP servers. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**ThreadMeta.setup**  
`{ status: starting | ready | degraded, wardens: { expected, held, failed }, runtime }`, streamed on `threads`. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**ThreadNamer**  
Keeps an agent-maintained short name on each thread after completed turns, off the turn path. *Region:* [Threads and the turn path](threads/knowledge.md)

**ThreadRuntimeManager**  
Attaches and disposes a live thread's runtime: Librarian, Wardens, flow, sinks, bindings. *Region:* [Threads and the turn path](threads/knowledge.md)

**threads**  
Class: the thread runtime and the one turn path (TurnService, queued turns, projects, ThreadFactory, ThreadRuntimeManager, FoundryClient). *Region:* [Threads and the turn path](threads/knowledge.md)

**ThreadState**  
Prisma model: thread metadata only (description, tags, status, parent, archive time). *Region:* [Threads and the turn path](threads/knowledge.md)

**threadTitle**  
Picks the title a thread shows: a person's name over the agent's. *Region:* [Threads and the turn path](threads/knowledge.md)

**three scopes**  
One list shown globally (FeedbackInbox), per project (FeedbackStrip), per thread (TurnFeedback, ThreadFeedback). *Region:* [Feedback and corrections](feedback/knowledge.md)

**tier**  
A file's corpus visibility (personal_private, team, org); each file keeps the narrowest of its node's and any owning node's. *Region:* [Standing instructions and composition](composition/knowledge.md)

**tier**  
Registry grouping of models (e.g. 'frontier') used for sweep options via modelOptionsByTier. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**TokenCounts**  
input, output, cacheRead, cacheWrite (with cacheWrite5m / cacheWrite1h subsets) and thinking (subset of output). *Region:* [Models, providers and usage](models-providers/knowledge.md)

**TokenTracker**  
foundry-core's one usage record, with cost and budget enforcement. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**tombstone**  
Row left by delete or retention so an unchanged transcript is not imported again. *Region:* [Local Archive and session capture](archive/knowledge.md)

**tool-gate**  
The user's structural tool rules: the only thing in Foundry that can deny a native tool call. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**toolCapability**  
Maps a native tool call's name to the capability it exercises. *Region:* [Agent tools and execution environments](tools/knowledge.md)

**toolGlobMatcher**  
Builds a case-insensitive predicate testing a tool name against glob patterns. *Region:* [Agent tools and execution environments](tools/knowledge.md)

**ToolRegistry**  
Where agents find typed tools: register(tool, summary), summary(), byKind(kind), allByKind(kind). *Region:* [Agent tools and execution environments](tools/knowledge.md)

**ToolResult**  
What each tool operation returns: structured data, a compact summary and estimatedTokens. *Region:* [Agent tools and execution environments](tools/knowledge.md)

**toolRules**  
Settings key holding structural allow / prompt / deny rules per capability, plus protectedPaths; global and per project. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**tools**  
Class tag: agent tools and execution environments (ToolRegistry, CapabilityGate, native tool classes, shell/browser/http/script adapters, output filters). *Region:* [Agent tools and execution environments](tools/knowledge.md)

**toolUseLoop**  
Runs a completion repeatedly, dispatching tool calls through a registry until text comes back. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**toPrismaJson**  
Converts a value for a Prisma JSON column (null becomes JsonNull); toOptionalPrismaJson leaves undefined unset. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**Trace**  
A message's full span tree from ingress to egress (core class), and its persisted Prisma model. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**traces**  
Class tag: Trace spans, persisted trace records and checkpoint import. *Region:* [Core agents, middleware, signals, traces](core-agents/knowledge.md)

**transport**  
How a session reaches its model: claude-cli, codex-app-server, claude-agent-sdk (live); acp, api (stubs, never a fallback). *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**tree(rootSessionId)**  
Archive read returning the root and every descendant as one unit, ordered by parentEntryId. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**trigger point**  
A named moment a Warden is asked: `user-message`, `consumed`, `agent-action`, `subagent-spawn`. *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

**tuning prompt**  
'what happened / what we did / what we intend', answered apply, edit, reroute, dismiss, later or undo. *Region:* [Feedback and corrections](feedback/knowledge.md)

**Turn-end compaction**  
completeTurn / failTurn append middleware-reduced rows in the transaction that seals the turn; raw rows are never rewritten. *Region:* [Journal and thread tree](journal-thread-tree/knowledge.md)

**turn-inspector**  
The viewer's turn flow graph, inspector data, live state, layer bands and delivery evidence view. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**turnFlowGraph**  
One turn's loop: input → routing ∥ domain assessment → sealed plan → delivered layers → executor → guards → delivery → writeback. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**TurnProjection**  
Projects one prompt's thread and flow streams onto session/updates until a stop reason. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**TurnService**  
The daemon's one turn lifecycle: durable accept, per-thread queue, Harness.send, interrupt. *Region:* [Headless Foundry over ACP](acp/knowledge.md)

**TurnService**  
The one turn lifecycle: accept, queue, dispatch, stream and settle, behind POST /api/messages and every host. *Region:* [Threads and the turn path](threads/knowledge.md)

**typesafe**  
Class: TypeSafe / Jev typed decisions: client, middleware, shadow runner, decision catalog. *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

**TypeSafe**  
External service whose System One API answers typed questions; reached with a service API key, not a subscription. *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

**typesafe provider**  
MODEL_REGISTRY entry (`jev-latest`, typed-decision, judgment, disabled) that describes Jev but never constructs it. *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

**TYPESAFE_API_KEY**  
Env var holding TypeSafe's service key; settings and code name only the variable. *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

**TypeSafeDecisionClient**  
Client whose `evaluate` takes typed questions and returns typed answers; not an LLMProvider. *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

**TypeSafeDecisionClient**  
The client the pre-filter calls the local server through (lives in the `typesafe` region). *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

**TypeSafeError**  
Error the client throws; messages omit provider response bodies and transport details. *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

**TypeSafeShadowRunner**  
Two-stage observe-only experiment: Noul gate, then Choice over catalog candidates; never executes the pick. *Region:* [TypeSafe / Jev typed decisions](typesafe/knowledge.md)

## U

**ui/store.js**  
The viewer store: selection signals, API calls, streams, toasts. *Region:* [Viewer dashboard shell](viewer/knowledge.md)

**unattributedReason: "subagent"**  
Marks every subagent event: it reaches onEvent but never a turn's result.events or content. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**UNBOUND_GATE**  
The gate used before binding; denies everything. *Region:* [Structural tool gate and MCP bridge](tool-gate-mcp/knowledge.md)

**unreadableTurn**  
Placeholder sent when a turn's journal rows cannot be read after retry. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**unsolicited main turn**  
A main-model turn caused by a background task ending; the tree is shaped so there are none. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**unwrapped**  
A thread with no layers, classifier, router, Cartographer or thread-state: the fresh-install default (wrapsThread). *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**unwrapped thread**  
A fresh install's thread: the message reaches the native session as typed, no layers or decision roles. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**updateCheckSeconds**  
How often the daemon checks upstream for a new commit (default 300). *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**usage-telemetry**  
Class: token counts, cache telemetry, TokenTracker attribution and usage windows, analytics, native context budgets and compaction. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**UsageEntry**  
One call's usage: provider, model, effort, agentId, threadId, spanId, integrationId login label, attribution keys. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**user-message**  
Advice trigger on every user message: what does the user usually add here, in your domain? *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

**uses**  
Count of advice and guard-request rows after appliedAt containing (fb_<id>), via phasesContaining. *Region:* [Feedback and corrections](feedback/knowledge.md)

## V

**validateConfig**  
Validates a full config, rejecting retired keys and running registered validators. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**vcr**  
Class: the VCR: cassettes for process stdio, HTTP and WebSocket, freshness rules, drift, scrubbing, re-recording. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**VCR**  
`packages/foundry/src/vcr/`, ported from the template: records and replays external interactions as cassettes. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**vendor settings**  
The `vendors` setting: per vendor and mode, enabled flag and fields such as baseUrl and contextBudget. *Region:* [Models, providers and usage](models-providers/knowledge.md)

**vendors**  
Settings key: each vendor on/off with a subscription mode and an API mode. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**verifyAuthority**  
Signet action returning current permission facts; not approval, quota reservation or admission. *Region:* [Kingdom pairing, access and Signets](kingdom/knowledge.md)

**verifyExpertDelivery**  
The single contract that checks a context delivery against its evidence for inspection, runner and audit. *Region:* [Session context delivery](session-delivery/knowledge.md)

**versions**  
What a call records: {charter, instructions, domainKnowledge, composedHash, retrieved?}. *Region:* [Composition audit log](audit-log/knowledge.md)

**versions.chorus**  
The `{ region, key }` (and `doc`) journalled with every Warden call. *Region:* [A project's region Wardens](chorus/knowledge.md)

**view.chorus**  
What the chorus resolved to: `on`, `enabled`, `enabledBy`, layers, regions, `missingDocs`, and the `reason` none run. *Region:* [A project's region Wardens](chorus/knowledge.md)

**Viewer server API**  
The /api routes in src/viewer/server.ts: traces, threads, events, actions, settings, assist, analytics, messages. *Region:* [Viewer dashboard shell](viewer/knowledge.md)

**viewer-shell**  
The local dashboard: HTTP server and routes, Preact UI, store, navigation, conversation, settings pages. *Region:* [Viewer dashboard shell](viewer/knowledge.md)

**ViewerFileAccess**  
Gates the viewer's file reads and writes, tracking protected paths. *Region:* [Viewer dashboard shell](viewer/knowledge.md)

**ViewerThreadDirectory**  
Thread lookup for viewer routes that includes projectless threads. *Region:* [Viewer dashboard shell](viewer/knowledge.md)

**volatile differences**  
Model- or service-driven changes (thinking, rate limits, chatter) printed as notices, never blocking. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

## W

**Warden notes**  
'The <domain> Warden chimed in:' points appended after the user's message; NO_COMMENT adds nothing. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**warden-evals**  
Class: Warden eval machinery: probes, labels, charter runs, classify run configs, judging, cost weights, reports, the experiment gate. *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

**warden-prefilter**  
Class: the local-model pre-filter that may skip a Warden on a confident no; off by default, fails open. *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

**warden-triggers**  
This region's class: when a Warden is asked and what it does there. *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

**WARDEN_CHARTER**  
The fixed point charter every region Warden runs under; heads the system message above its own instructions. *Region:* [Warden classification primitive](classify/knowledge.md)

**WARDEN_CHARTER_VERSION**  
charter-<sha12> of the charter text; a new hash writes a source version with actor release. *Region:* [Composition audit log](audit-log/knowledge.md)

**WARDEN_CHARTER_VERSION**  
Short hash (charter-<sha12>) of the charter text journalled with each Warden decision and eval run. *Region:* [Warden classification primitive](classify/knowledge.md)

**WardenPrefilter**  
Asks the local pre-filter model which Warden domains can be skipped for a trigger. *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

**Wardens**  
Domain advise + guard roles generated from a project's regions; never hand-named or subclassed. *Region:* [Repo structure and conventions](conventions/knowledge.md)

**Wardens**  
Region Wardens, one per concept region, generated from .foundry/regions (formerly called Domain Librarians). *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**Warm cache**  
A compact structured index (e.g. the ~500-token doc map) a middleware LLM compares the message against. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**warm set**  
Design note, not built: hold only recently routed regions' spares (`warmWardens`) instead of the whole chorus. *Region:* [Wardens inside the thread's process](in-session-wardens/knowledge.md)

**warmLayers**  
Singleton job that warms all context layers in a thread's stack. *Region:* [Settings, jobs, logging and database](settings-runtime/knowledge.md)

**webSocketCassettes**  
A cassette-backed socket factory; replay refuses a sent frame that differs. *Region:* [Testing and the VCR](testing-vcr/knowledge.md)

**whichOn**  
Resolves a command against an explicit PATH instead of Bun.which on the startup PATH. *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**whole-thread snapshot**  
Each capture is the full thread, so re-capturing is safe. *Region:* [Local Archive and session capture](archive/knowledge.md)

**wilsonInterval**  
95% Wilson interval for n successes in d trials. *Region:* [Warden pre-filter and evals](warden-prefilter-evals/knowledge.md)

**withClientMcpServers**  
Adds a host's MCP servers to Claude argv via a private 0600 --mcp-config file; call release on exit. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**withNativeBridge**  
Adds the one process-owned bridge MCP server to a Claude argv; refuses conflicting policy. *Region:* [Native sessions and agent-session](native-sessions/knowledge.md)

**withoutCompetingCredentials**  
Strips API keys, endpoints and profile overrides from a child environment. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**workerModelRequirement**  
Says why a model cannot run on the subscription worker, or undefined when it can. *Region:* [Subscription-only policy](subscription-policy/knowledge.md)

**workItemId**  
Pulls the work item id from a fetch tool call's input. *Region:* [Agent tools and execution environments](tools/knowledge.md)

**workItemOf**  
Returns the work item a tool call took in, or undefined; matches `chorus.consumed` tools and paths. *Region:* [When Wardens are asked](warden-triggers/knowledge.md)

**workLog**  
A finished turn's work rows and tool counts, minus text the answer already shows. *Region:* [Viewer inspector, streams and Gloss](viewer-inspector/knowledge.md)

**WorkstreamOverloadDetector**  
Herald detector recommending a thread split when it juggles too many agents, signals or context hashes. *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**worktree**  
A git worktree; a thread works in one path and branch (updateThreadWorktree). *Region:* [Install, daemon, devices and git](install-daemon/knowledge.md)

**wrapsThread**  
Decides whether a thread is wrapped; an unwrapped thread gets the user's message as typed. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**wrapsThread**  
Whether a thread gets any Foundry context; fresh installs are unwrapped and send the message as typed. *Region:* [Session context delivery](session-delivery/knowledge.md)

**Writeback**  
Loop 4: post-execution map rebuilds, memory entries and convention proposals feeding the corpus pipeline. *Region:* [The FLOW.md roles as agents](flow-roles/knowledge.md)

**Writeback pipeline**  
Loop 4: map rebuilds, memory entries, convention proposals, persistence; not built as a whole. *Region:* [Harness data flow and loops](flow-architecture/knowledge.md)

**writeCredentialHome**  
Creates a Foundry-owned CODEX_HOME with config and the profile's auth.json linked, not copied. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**writePrivateFile / writePrivateJson**  
Atomic 0600 writes, never through a symlink; JSON variant creates its directory 0700. *Region:* [Logins, profiles and secrets](logins-secrets/knowledge.md)

**/ws**  
The viewer's WebSocket endpoint for panel-scoped snapshot-then-append data streams. *Region:* [Viewer dashboard shell](viewer/knowledge.md)

## X

**X-Config-Revision**  
Header returned by /api/settings; sending it back on a write gets 409 if stale. *Region:* [Viewer dashboard shell](viewer/knowledge.md)

## Z

**Zero-SDK providers**  
Providers use raw fetch to provider APIs and add no vendor SDK dependency. *Region:* [Models, providers and usage](models-providers/knowledge.md)
