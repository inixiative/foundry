import type { ConceptRegistry } from '@inixiative/atlas';

// Foundry's concept registry: structure only. Classes are the layers
// (feature / primitive / infrastructure / integration). Membership comes from the
// stamp rules in config.ts (Foundry is laid out by directory, not by module/package
// captures, so the registry carries no constituent categories). `docs:` values
// resolve under docs/ and are existence-checked by `atlas check`.
export const CONCEPTS: ConceptRegistry = {
  // ── features: what Foundry does for a user ──────────────────────────────────
  'feature:threads': { docs: ['FLOW.md'] }, // thread runtime, sessions, the one turn path, local session store
  'feature:threadTree': { docs: ['THREAD-TREE.md'] }, // native subagents as child threads, reduced middleware entries, stitching
  'feature:flow': { docs: ['FLOW.md', 'api/PRIMITIVES.md'] }, // the FLOW.md roles: orchestrator, Cartographer, Librarian, Herald, routed agents
  'feature:wardens': { docs: ['FLOW.md', 'subscription-decisions.md'] }, // region Wardens: roster, triggers, reception, in-session, pre-filter
  'feature:toolGate': { docs: ['FLOW.md'] }, // the user's structural tool rules: the only thing that can deny a tool call
  'feature:feedback': { docs: ['FEEDBACK-LOOP.md'] }, // explicit feedback, lifecycle, routing, repeats, correction detection
  'feature:evals': {}, // Warden eval machinery: probes, charter runs, reports, experiment gate (docs live in Oracle)
  'feature:composition': { docs: ['usage-and-context.md'] }, // the instruction ladder: standing instructions, composed role slots
  'feature:usage': { docs: ['usage-and-context.md'] }, // token counts, usage attribution, analytics, native context budgets
  'feature:auditLog': { docs: ['THREAD-TREE.md'] }, // the one audit log and composition versions (spec B)
  'feature:viewer': { docs: ['SYSTEM.md'] }, // the local dashboard: HTTP server, routes, browser UI
  'feature:acp': { docs: ['reference/FOUNDRY-ACP.md'] }, // foundry-acp: hosts (Paseo, T3 Code, Zed) drive Foundry threads over ACP
  'feature:mcpBridge': { docs: ['FLOW.md'] }, // the `foundry` MCP server: the mid-session bridge (Loop 2)
  'feature:daemon': {}, // LaunchAgent install, supervisor, two-copy auto-update, last-good settings, local client launch
  'feature:setup': {}, // setup, doctor, legacy starter, docs scan, startup self-test
  'feature:nativeAuth': { docs: ['native-authentication.md'] }, // which login a native session runs on: profiles, accounts, Kingdom-held logins
  'feature:devices': { docs: ['DEVICE-PROJECT-IDENTITY.md'] }, // local device inventory and linked project checkouts
  'feature:conversations': { docs: ['reference/CONVERSATIONS.md'] }, // agent conversations: the wrapper of a main thread members reach through Kingdom

  // ── primitives: reusable building blocks (core is all primitives) ──────────
  'primitive:agents': { docs: ['api/PRIMITIVES.md'] }, // BaseAgent, classifier, router, executor, decider, clarifier, Harness, tool loop
  'primitive:thread': { docs: ['api/PRIMITIVES.md'] }, // core Thread, ownership scope, ids
  'primitive:contextLayers': { docs: ['api/PRIMITIVES.md', 'FLOW.md'] }, // ContextLayer, ContextStack, cache lifecycle, hydration
  'primitive:middleware': { docs: ['api/PRIMITIVES.md'] }, // middleware chain, hooks, retry
  'primitive:signals': { docs: ['api/PRIMITIVES.md'] }, // SignalBus, event stream, interventions, action prompts
  'primitive:traces': { docs: ['api/PRIMITIVES.md'] }, // trace spans, trace records, checkpoint import
  'primitive:classify': {}, // the one classification primitive: stages, charters, protocols, pointers
  'primitive:decisions': { docs: ['subscription-decisions.md'] }, // decision roles on subscription logins: hosts, priming, budgets, priority
  'primitive:nativeSessions': { docs: ['FLOW.md'] }, // native Claude Code / Codex sessions via agent-session: launch, delivery, evidence
  'primitive:providers': {}, // LLM provider interface and the API-key providers (Anthropic, OpenAI, Gemini, OpenAI-compatible)
  'primitive:modelRegistry': {}, // capability vocabulary, provider/model table, vendor settings
  'primitive:tools': { docs: ['EXECUTION_ENVIRONMENTS.md'] }, // agent tool interfaces, native tool classes, capability gating, tool adapters
  'primitive:memory': { docs: ['api/ADAPTERS.md'] }, // memory/knowledge adapters (file, sqlite, http, markdown, postgres, redis, Muninn, Supermemory)
  'primitive:journal': { docs: ['THREAD-TREE.md'] }, // the local journal: content-addressed records, session store, attachments
  'primitive:settings': {}, // the settings model, resolution, ConfigStore, settings routes
  'primitive:jobs': {}, // BullMQ queue, makeJob / makeSingletonJob, worker, handlers
  'primitive:logger': {}, // pluggable logger (consola, pino) with async scopes
  'primitive:websockets': {}, // data streams over WebSocket: registry, delivery, serialized queue, client
  'primitive:vcr': { docs: ['live-testing.md'] }, // cassettes: recorded HTTP, stdio and WebSocket sessions; live tier
  'primitive:secrets': {}, // credential references, private (0600) files and tokens, secret scrubbing

  // ── infrastructure: the platform substrate ─────────────────────────────────
  'infrastructure:prisma': { docs: ['SYSTEM.md'] }, // Postgres via Prisma
  'infrastructure:redis': {}, // Redis (job queue, memory adapter)
  'infrastructure:git': {}, // git and worktree detection

  // ── integrations: the external-service boundary ────────────────────────────
  'integration:kingdom': {
    docs: ['kingdom-access.md', 'runtime-seam.md', 'signet-cancellation.md'],
  }, // pairing, Signets, access grants, tunnel handoff
  'integration:archive': { docs: ['session-archives.md'] }, // the machine's local Archive: capture, search, context source
  'integration:typesafe': { docs: ['typesafe-jev.md'] }, // TypeSafe / Jev decisions, shadow runs, decision catalog
  'integration:gloss': { docs: ['GLOSS.md'] }, // Gloss margin notes in the viewer
};
