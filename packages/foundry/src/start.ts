#!/usr/bin/env bun
import { join, resolve } from 'node:path';
import { resolveDecisionModel } from '@inixiative/foundry-core';
import { stampFoundryRun } from './archives/run-stamp';
import { AGENT_CLIS, ensureAgentClisOnPath } from './daemon/agent-clis';
import { publishDaemonRuntime } from './daemon/runtime-hook';
import { subscriptionWorker, WORKER_SESSION_RUNTIMES } from './models/registry';
import { providerBaseUrl, providerContextBudget, providerEnabled } from './models/vendors';
import {
  type DecisionEvents,
  liveDecisionHosts,
  privateDirectory,
} from './providers/decision-host';
import { createDecisionProvider } from './providers/decision-provider';
import { harnessSettingSources } from './providers/harness-settings';
import { InSessionWardens, inSessionThreadSetup } from './providers/in-session-wardens';
import { KingdomAuthentication } from './providers/kingdom-authentication';
import { projectCapacity } from './providers/kingdom-subscription-authentication';
import { LoginPoolAuthentication, LoginRunLog } from './providers/login-pool';
import { LoginSetup } from './providers/login-setup';
import {
  NativeAuthentication,
  type NativeAuthenticationProvider,
} from './providers/native-authentication';
import {
  nativeAuthenticationMode,
  projectRunsOnKingdom,
} from './providers/native-authentication-mode';
import { boundLaunchEnvironment } from './providers/native-text-environment';
import { SubscriptionAuthentication } from './providers/subscription-authentication';
import {
  loginPoolSettings,
  POOLED_RUNTIMES,
  type PooledRuntime,
  resolveSubscriptionPolicy,
  threadWorkerRequirement,
  usableLogins,
  workerDefaultModel,
} from './providers/subscription-policy';
/**
 * @atlas
 * @kind entrypoint
 * @partOf feature:daemon, feature:flow
 */
import type { SecretScratch } from './secrets/scratch';
import { SECRET_SCRATCH_DESCRIPTION, SecretScratchTool } from './tools/secret-scratch';

/**
 * Foundry — production entrypoint.
 *
 * Loads .foundry/settings.json + .env.local, wires up LLM-powered agents,
 * context layers, and the viewer dashboard.
 *
 * Run with: bun run start
 * Open:     http://localhost:${VIEWER_PORT || 4500}
 */

import {
  ContextStack,
  type MemoryEntry,
  type NativeBridgeSource,
  type ThreadMeta,
  type ThreadSetup,
  ToolRegistry,
} from '@inixiative/foundry-core';
import { existsSync, mkdirSync } from 'fs';
import { FileMemory, PostgresMemory } from './adapters';
import {
  ActionQueue,
  buildAgents,
  buildLayers,
  createSourceResolver,
  EventStream,
  Harness,
  InterventionLog,
  ProjectRegistry,
  ThreadFactory,
  ThreadRuntimeManager,
  TokenTracker,
} from './agents';
import { resolveLearningSettings } from './agents/learning-config';
import { describeChorus } from './agents/region-roster';
import { atlasRootOf, configureHarness, createMainThread } from './agents/thread-factory';
import { acpLaunchPath, removeAcpLaunch, writeAcpLaunch } from './client/launch';
import type { ConversationService } from './conversations/service';
import { lateConversationWrapper } from './conversations/types';
import { LocalSessionStore } from './persistence/local-session-store';
import {
  CLAUDE_HARNESS_INSTRUCTIONS_OFF,
  CODEX_HARNESS_INSTRUCTIONS_OFF,
  harnessLoadsInstructions,
} from './prompts/instruction-stack';
import type { LLMProvider } from './providers';
import {
  AnthropicProvider,
  ClaudeCodeSessionAdapter,
  CodexSessionAdapter,
  createRegisteredProvider,
  FileExternalSessionStore,
  GeminiProvider,
  MuseSessionAdapter,
  OpenAIProvider,
  providerApiKey,
  type SessionAdapter,
  SessionBackedProvider,
} from './providers';
import { startPrefilterServer } from './providers/prefilter-model';
import { ThreadLaunchSettings } from './providers/thread-launch';
import { resolvePrefilterSettings, WardenPrefilter } from './providers/warden-prefilter';
import { runStartupSelfTest, startupSelfTestEnabled } from './startup-self-test';
import { BashShell } from './tools/bash-shell';
import { BunScript } from './tools/bun-script';
import { CONVERSATION_TOOL_DESCRIPTION, ConversationTool } from './tools/conversation';
import { registerKingdomAccess } from './tools/kingdom-access';
import { registerKingdomPost } from './tools/kingdom-post';
import { MemoryToolAdapter } from './tools/memory-adapter';
import { rtk as rtkFilter } from './tools/output-filters';
import {
  THREAD_RECORD_TOOL_DESCRIPTION,
  type ThreadRecords,
  ThreadRecordTool,
} from './tools/thread-record';
import { journalHistory, workerHistoryBudget } from './turns/journal-history';
import { nativeQuestions } from './turns/native-questions';
import { lateBoundToolGate, type ThreadToolGate } from './turns/tool-gate';
import {
  ConfigStore,
  createProject,
  defaultAgents,
  type FoundryConfig,
  foundryConfigDir,
  starterConfig,
} from './viewer/config';
import { effectiveProject, resolveProjectView } from './viewer/config-resolve';
import { startViewer } from './viewer/server';

// ---------------------------------------------------------------------------
// Load config (auto-bootstrap on first run)
// ---------------------------------------------------------------------------

const FOUNDRY_DIR = foundryConfigDir();
const selfTestRequested = startupSelfTestEnabled(process.env.FOUNDRY_STARTUP_SELF_TEST);

const configStore = new ConfigStore(FOUNDRY_DIR);
let config: FoundryConfig;

function hasEntries(record: Record<string, unknown> | undefined): boolean {
  return !!record && Object.keys(record).length > 0;
}

/**
 * A runnable config: an executor to run turns and a project for this directory. Nothing else is
 * seeded: layers, sources and decision roles are opt-in, so a fresh install's threads are unwrapped.
 */
function ensureRunnableLocalConfig(config: FoundryConfig): boolean {
  let changed = false;

  if (!hasEntries(config.agents)) {
    config.agents = defaultAgents();
    changed = true;
  }

  if (!hasEntries(config.projects)) {
    const project = createProject(process.cwd(), { label: 'Foundry' });
    config.projects = { [project.id]: project };
    changed = true;
  }

  return changed;
}

// The agent CLIs every native launch spawns by bare name: one found off PATH (an app bundle's) joins
// this process's PATH, so a run outside the daemon finds a CLI nobody put on PATH.
const agentClis = await ensureAgentClisOnPath();
for (const cli of AGENT_CLIS) {
  const install = agentClis.get(cli);
  console.log(
    install
      ? `Agent CLI ${cli}: ${install.binary} (${install.version.join('.')})`
      : `Agent CLI ${cli}: no working install found`,
  );
}

if (!existsSync(`${FOUNDRY_DIR}/settings.json`)) {
  // First run — generate a runnable local config.
  console.log('No config found — generating starter config...');
  config = starterConfig('claude-code', 'fable');
  ensureRunnableLocalConfig(config);
  await configStore.save(config);

  mkdirSync(`${FOUNDRY_DIR}/analytics`, { recursive: true });

  console.log('Starter config generated — setup wizard will open in the viewer.');
} else {
  config = structuredClone(await configStore.load());
  if (ensureRunnableLocalConfig(config)) {
    await configStore.save(config);
    console.log('Updated starter config with a default executor and project.');
  }
}

// Subscription-only unless settings opt in with apiTokens: true. Only the opt-in constructs API providers.
const subscription = resolveSubscriptionPolicy(config, { startup: true });
if (subscription) {
  config = subscription.config;
  console.log(
    `Subscription-only: workers ${Object.entries(subscription.workers)
      .map(([worker, login]) => `${worker} (${login!.profileDirectory})`)
      .join(
        ', ',
      )}, decisions ${subscription.decision.runtime} ${subscription.policy.model} (${subscription.decision.profileDirectory}); no API providers`,
  );
  if (subscription.rerouted.length)
    console.log(`Decision roles use subscription decisions: ${subscription.rerouted.join(', ')}`);
}
// Each project's chorus: said at startup, so a regions directory that did not resolve is never a
// silent loss of the project's Wardens.
for (const [projectId, project] of Object.entries(config.projects ?? {})) {
  if (project.enabled === false) continue;
  const view = resolveProjectView(config, projectId);
  if (!view || (!view.chorus.enabled && !view.chorus.reason)) continue;
  console.log(describeChorus(project.label ?? projectId, view.chorus));
}
// decisionRuntime claude-in-session: each thread's Wardens are held inside its own Claude Code
// process (docs/THREAD-TREE.md spec C). Off by default.
const setupListeners: Array<(threadId: string, setup: ThreadSetup) => void> = [];
const inSession =
  subscription?.policy.wardens === 'in-session'
    ? new InSessionWardens({
        model: subscription.policy.model,
        ...(subscription.policy.effort ? { effort: subscription.policy.effort } : {}),
        timeoutMs: subscription.policy.callTimeoutMs,
        onSetup: (threadId, setup) => {
          for (const listener of setupListeners) listener(threadId, setup);
          if (setup.status !== 'starting')
            console.log(
              `[in-session] thread ${threadId} ${setup.status}: ${setup.wardens.held}/${setup.wardens.expected} Wardens held in ${(setup.readyAt ?? Date.now()) - setup.startedAt} ms`,
            );
        },
      })
    : undefined;
if (inSession)
  console.log(
    "Wardens: held inside each Claude Code thread's own process (claude-in-session); threads on other workers use primed Wardens",
  );
/** Pressure and recycles of every decision host (the decision host and each stage host) reach the viewer. */
const decisionEvents: DecisionEvents = {
  onPressure: (event: Parameters<NonNullable<DecisionEvents['onPressure']>>[0]) => {
    const message =
      event.kind === 'shed'
        ? `Decision shed under load (thread ${event.threadId}, priority ${event.priority}, ${event.queued} queued)`
        : event.kind === 'closed'
          ? `Decision admission closed until restart: ${event.reason}`
          : `Decision subscription rate limited; backing off ${Math.round(event.backoffMs / 1000)}s`;
    console.warn(`[subscription-decisions] ${message}`);
    eventStream.pushError('subscription-decisions', message, 'warn');
  },
  onPrimedEvent: (event: Parameters<NonNullable<DecisionEvents['onPrimedEvent']>>[0]) => {
    if (event.type === 'process-started')
      console.log(`[subscription-decisions] warm Codex app-server ready in ${event.ms}ms`);
    if (event.type !== 'process-recycled' && event.type !== 'violation') return;
    const message =
      event.type === 'violation'
        ? `Decision violated the text-only policy (${event.detail}); process recycled`
        : `Decision process recycled (${event.reason}); roles re-prime on the next decision`;
    console.warn(`[subscription-decisions] ${message}`);
    eventStream.pushError('subscription-decisions', message, 'warn');
  },
};
// The decision host and one host per other model and effort a classify stage names
// (chorus.wardens.stages), started on first use on the same login and bounds. API-token decisions
// have no per-stage host: such a stage is refused.
const live = subscription
  ? liveDecisionHosts(config, subscription, {
      ...(inSession ? { inSession } : {}),
      events: decisionEvents,
      log: (line) => console.log(line),
    })
  : undefined;
const decisions = live?.decisions;
const flowLlm = decisions?.provider ?? createDecisionProvider(config);
/** Wired only with subscription decisions: without it, a chorus that writes no stages runs one. */
const stageHost = live?.stageHost;
const decisionModel = subscription?.policy.model ?? resolveDecisionModel(config).model;
// API-token mode: agents saved on the decision provider's id resolve to the decision client.
const decisionAlias = subscription
  ? []
  : [[resolveDecisionModel(config).provider, flowLlm] as const];

console.log(
  `Foundry starting — provider: ${config.defaults.provider}, model: ${config.defaults.model}`,
);

// ---------------------------------------------------------------------------
// Create LLM provider
// ---------------------------------------------------------------------------

// What hosts chose per thread, and each thread's tool gate (bound once the viewer exists).
const threadLaunch = new ThreadLaunchSettings();
let toolGateFor: ((threadId: string) => ThreadToolGate) | undefined;
// The journal a fresh executor session is seeded from; bound once the viewer opens it.
let journalStore:
  | Pick<LocalSessionStore, 'journalEntries' | 'threadMeta' | 'phasesOf'>
  | null
  | undefined;
const hostSettings = {
  launch: threadLaunch,
  // Bound lazily per call: a session created before the viewer exists still fails closed, never open.
  toolGate: lateBoundToolGate(() => toolGateFor),
  // Sized to the thread's worker, so the seed fits whichever of its models runs.
  history: (threadId: string, turnId?: string) =>
    journalStore
      ? journalHistory(
          journalStore,
          threadId,
          turnId,
          workerHistoryBudget(threadMeta?.(threadId)?.worker),
        )
      : undefined,
};

// A thread's (or its auxiliary session's) record; bound once the runtimes exist.
let threadMeta: ((threadId: string) => ThreadMeta | undefined) | undefined;
let liveConfig = config;
// One binding store for every worker: it is keyed by runtime.
const sessionStore = new FileExternalSessionStore(join(FOUNDRY_DIR, 'sessions.json'));
// Kingdom-capacity projects run their threads, on every worker, on a login Kingdom releases from the
// project's pool, never on this machine's; every other thread keeps the machine's own login. Applies
// to projects set to kingdom at startup.
const projectCapacityAuthentication = Object.keys(config.projects ?? {}).some((id) =>
  projectRunsOnKingdom(config, id),
)
  ? projectCapacity({
      foundryDir: FOUNDRY_DIR,
      config: () => liveConfig,
      meta: (threadId) => threadMeta?.(threadId),
    })
  : (local: NativeAuthenticationProvider | undefined) => local;

/** Local authentication for a worker with no login here: only Kingdom-capacity threads may use it. */
const noLocalLogin = (worker: string): NativeAuthenticationProvider => ({
  bindingId: (threadId) => threadId,
  prepare: async () => {
    throw Error(`The ${worker} worker has no login on this machine; no other login is used`);
  },
});

// This machine's logins per runtime, balanced when there are several (providers/login-pool.ts). Read
// live from settings: a login added in Settings › Providers serves the next launch.
const loginRuns = new LoginRunLog(LoginPoolAuthentication.runsFile(FOUNDRY_DIR));
const loginPools: Partial<Record<PooledRuntime, LoginPoolAuthentication>> = {};
for (const runtime of POOLED_RUNTIMES) {
  const worker = runtime === 'claude' ? 'claude-code' : 'codex';
  const started = subscription?.workers[worker];
  if (!started) continue;
  const live = () => {
    try {
      return usableLogins(configStore.config, runtime);
    } catch {
      return { primary: started, logins: subscription?.pools[worker] ?? [started] };
    }
  };
  loginPools[runtime] = new LoginPoolAuthentication({
    runtime,
    directory: join(FOUNDRY_DIR, 'runtime-profiles'),
    logins: () => live().logins,
    primary: () => live().primary,
    settings: (threadId) =>
      loginPoolSettings(
        configStore.config,
        runtime,
        threadMeta?.(threadId.split(':aux:')[0]!)?.projectId,
      ),
    runs: loginRuns,
  });
}
process.once('exit', () => loginRuns.flush());

/** One worker's provider and session adapter. Building it spawns nothing: processes start per thread. */
function createProvider(
  config: FoundryConfig,
  providerId: string,
): {
  provider: LLMProvider;
  sessionAdapter?: SessionAdapter;
} {
  const login = subscription?.workers[providerId as keyof typeof subscription.workers];
  // Each worker's adapter starts on its own default model: the global model only on the global worker.
  const defaultModel = workerDefaultModel(config, providerId);
  const pooled = login && (login.runtime === 'claude' || login.runtime === 'codex');
  const authentication = login
    ? pooled
      ? loginPools[login.runtime as PooledRuntime]!
      : new SubscriptionAuthentication(join(FOUNDRY_DIR, 'runtime-profiles'), login)
    : subscription
      ? noLocalLogin(providerId)
      : nativeAuthenticationMode(config) === 'kingdom'
        ? new KingdomAuthentication({
            directory: join(FOUNDRY_DIR, 'kingdom'),
            sources: config.kingdomInference ?? [],
            defaultOwnerKey: config.defaults.kingdomOwnerKey,
            assignments: config.kingdomInferenceAssignments,
          })
        : nativeAuthenticationMode(config) === 'native-profile'
          ? new NativeAuthentication({
              directory: join(FOUNDRY_DIR, 'runtime-profiles'),
              sources: config.nativeAuthentication ?? [],
              defaultSourceId: config.defaults.nativeAuthenticationId,
            })
          : undefined;
  const routed = projectCapacityAuthentication(authentication);
  if (routed && !subscriptionWorker(providerId))
    throw Error('Native authentication requires a native runtime provider');
  if (authentication instanceof NativeAuthentication)
    for (const [threadId, sourceId] of Object.entries(config.nativeAuthenticationSelections ?? {}))
      authentication.select(threadId, sourceId);
  const selectedAuth = config.nativeAuthentication?.find(
    (source) => source.id === config.defaults.nativeAuthenticationId,
  );
  if (
    !subscription &&
    selectedAuth?.mode === 'native-profile' &&
    !(
      providerEnabled(config, resolveDecisionModel(config).provider) &&
      providerApiKey(resolveDecisionModel(config).provider)
    )
  ) {
    throw Error(
      'A native profile has one refresh owner. Configure the separate API decision provider or use a gateway authentication source before starting Foundry.',
    );
  }

  // Subscription workers launch with an allowlisted environment: no API keys or competing profiles.
  const subscriptionSpawn = subscription
    ? {
        spawn: (
          argv: string[],
          options: { cwd: string; env: Record<string, string | undefined> },
        ) =>
          Bun.spawn(argv, {
            ...options,
            env: boundLaunchEnvironment(options.env),
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
          }),
      }
    : {};
  // Foundry's `instructions` source composes CLAUDE.md / AGENTS.md / memory; the harness must not load them again.
  const suppressInstructions = !harnessLoadsInstructions(config);
  // What a main thread loads of the user's own setup (CORE-003). Read live: a project registered
  // or the switch flipped applies to the next session.
  const harnessSettings = (cwd: string) =>
    configStore.config.composition?.harnessSettings === 'off'
      ? undefined
      : harnessSettingSources(
          cwd,
          Object.values(configStore.config.projects ?? {})
            .filter((project) => project.enabled !== false && project.path)
            .map((project) => project.path!),
        );
  switch (providerId) {
    case 'claude-code': {
      const sessionAdapter = new ClaudeCodeSessionAdapter({
        contextBudget: providerContextBudget(config, providerId),
        store: sessionStore,
        authentication: routed,
        ...(inSession ? { inSession } : {}),
        harnessSettings,
        defaults: {
          model: defaultModel,
          ...(suppressInstructions ? { env: { ...CLAUDE_HARNESS_INSTRUCTIONS_OFF } } : {}),
          ...subscriptionSpawn,
        },
      });
      return {
        sessionAdapter,
        provider: new SessionBackedProvider({
          id: 'claude-code',
          adapter: sessionAdapter,
          defaultModel: defaultModel,
          ...hostSettings,
        }),
      };
    }
    case 'codex': {
      const sessionAdapter = new CodexSessionAdapter({
        store: sessionStore,
        harnessSettings,
        authentication: routed,
        ...(suppressInstructions ? { appServerConfig: CODEX_HARNESS_INSTRUCTIONS_OFF } : {}),
        defaults: {
          model: defaultModel,
          effort: config.defaults.codexEffort,
          ...subscriptionSpawn,
        },
      });
      return {
        sessionAdapter,
        provider: new SessionBackedProvider({
          id: 'codex',
          adapter: sessionAdapter,
          defaultModel: defaultModel,
          ...hostSettings,
        }),
      };
    }
    case 'muse': {
      // Muse Code on the user's own Muse login, or a Kingdom pool's. Its questions go to the thread's person on the
      // prompt queue the tool gate asks on; its config is the user's own (MuseSessionAdapter).
      const sessionAdapter = new MuseSessionAdapter({
        store: sessionStore,
        authentication: routed,
        // Effort is the host's (the thread's launch settings); otherwise Muse's own default.
        defaults: { model: defaultModel },
        ...(subscription ? { environment: boundLaunchEnvironment } : {}),
        questions: (threadId) => nativeQuestions(actionQueue, threadId),
      });
      return {
        sessionAdapter,
        provider: new SessionBackedProvider({
          id: 'muse',
          adapter: sessionAdapter,
          defaultModel: defaultModel,
          ...hostSettings,
        }),
      };
    }
    case 'anthropic': {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) {
        console.error('ANTHROPIC_API_KEY not set. Add it to .env.local or environment.');
        process.exit(1);
      }
      return {
        provider: new AnthropicProvider({
          apiKey: key,
          defaultModel: config.defaults.model,
        }),
      };
    }
    case 'openai': {
      const key = process.env.OPENAI_API_KEY;
      if (!key) {
        console.error('OPENAI_API_KEY not set. Add it to .env.local or environment.');
        process.exit(1);
      }
      return {
        provider: new OpenAIProvider({
          apiKey: key,
          defaultModel: config.defaults.model,
        }),
      };
    }
    case 'gemini': {
      const key = process.env.GEMINI_API_KEY;
      if (!key) {
        console.error('GEMINI_API_KEY not set. Add it to .env.local or environment.');
        process.exit(1);
      }
      return {
        provider: new GeminiProvider({
          apiKey: key,
          defaultModel: config.defaults.model,
        }),
      };
    }
    default: {
      // Meta, xAI and the other OpenAI-compatible hosts share one adapter, keyed by the registry.
      const key = providerApiKey(providerId);
      try {
        return {
          provider: createRegisteredProvider(providerId, {
            apiKey: key,
            baseUrl: providerBaseUrl(config, providerId),
            defaultModel: config.defaults.model,
          }),
        };
      } catch (error) {
        console.error(`${(error as Error).message}. Add it to .env.local or environment.`);
        process.exit(1);
      }
    }
  }
}

// Every usable worker is built now (subscription mode); with apiTokens, only the default provider.
const workers = new Map(
  (subscription ? subscription.offered : [config.defaults.provider]).map(
    (id) => [id, createProvider(config, id)] as const,
  ),
);
const provider = workers.get(config.defaults.provider)!.provider;
const sessionAdapters = new Map(
  [...workers].flatMap(([id, built]) =>
    built.sessionAdapter ? [[id, built.sessionAdapter] as const] : [],
  ),
);
const sessionProviders = [...workers.values()].flatMap(({ provider }) =>
  provider instanceof SessionBackedProvider ? [provider] : [],
);

// ---------------------------------------------------------------------------
// Action queue
// ---------------------------------------------------------------------------

const actionQueue = new ActionQueue();

// ---------------------------------------------------------------------------
// Token tracker
// ---------------------------------------------------------------------------

const maxCost = parseFloat(process.env.FOUNDRY_MAX_COST || '') || 10.0;
const tokenTracker = new TokenTracker({
  budget: { maxCost },
});

// ---------------------------------------------------------------------------
// Memory + source resolver
// ---------------------------------------------------------------------------

const memory = new FileMemory(`${FOUNDRY_DIR}/memory`);
await memory.load();

console.log(`Memory loaded: ${memory.all().length} entries`);
const writeSignal = memory.signalWriter();

// Source resolver — turns config source IDs into ContextSources. Memory-backed
// sources are scope-aware: the template warms with globally published
// knowledge only, and each thread's clone binds them to that thread.
const sourceResolver = createSourceResolver({ memory });

// ---------------------------------------------------------------------------
// Tool registry — agents discover and use registered tools during execution
// ---------------------------------------------------------------------------

const tools = new ToolRegistry();
registerKingdomAccess(tools, config.kingdomAccess);
// Agent conversations (docs/reference/CONVERSATIONS.md): the host's send_to_member and pass_conch, and
// the joining side's kingdom_post, reach the viewer's conversation wrapper once it exists.
let conversationService: ConversationService | null = null;
// Every Foundry: the owner's own agents join as local members with no Kingdom (§4.11), so their
// post and the plain-text controls must reach an unpaired one too.
tools.register(new ConversationTool(() => conversationService), CONVERSATION_TOOL_DESCRIPTION);
registerKingdomPost(tools, config.kingdomAccess ?? [], () => conversationService);
// The thread's own record (plan, loop, name, status), written on its meta by the viewer once it exists.
let threadRecords: ThreadRecords | null = null;
tools.register(new ThreadRecordTool(() => threadRecords), THREAD_RECORD_TOOL_DESCRIPTION);
// The secret scratch pad's tools (FEAT-005), on the viewer's pads once it exists.
let secretScratch: SecretScratch | null = null;
tools.register(new SecretScratchTool(() => secretScratch), SECRET_SCRATCH_DESCRIPTION);

// Memory as a queryable tool (agents search on demand, not just passive layers)
const memoryTool = MemoryToolAdapter.fromFileMemory(memory);
tools.register(memoryTool, 'Project memory — search conventions, signals, learnings');

// Real shell — executes against the actual filesystem with RTK output filtering
const shellTool = new BashShell({
  cwd: process.cwd(),
  outputFilter: rtkFilter,
});
tools.register(shellTool, 'Execute shell commands — file I/O, git, tests, builds');

// TypeScript execution environment (Bun subprocess isolation)
const scriptTool = new BunScript({ timeout: 15_000 });
tools.register(scriptTool, 'Execute TypeScript/JS in isolated Bun subprocess');

// Tools log deferred until after optional Postgres/Redis registration

// ---------------------------------------------------------------------------
// Build project-scoped layers and agents (shared across all threads)
// ---------------------------------------------------------------------------

// The template stack and agents are the project baseline. They are never
// registered on a thread directly: ThreadFactory clones them per thread so
// each thread owns independent layer and agent instances.
const templateStack = new ContextStack(buildLayers(config, { sourceResolver }));
await templateStack.warmAll();

const templateAgents = buildAgents(config, templateStack, { provider, tokenTracker, tools });
// Every provider a thread's agents or phases may name, shared by the runtimes and the factory.
const providers = new Map<string, LLMProvider>([
  ...decisionAlias,
  [flowLlm.id, flowLlm],
  ...[...workers].map(([id, built]) => [id, built.provider] as const),
]);

// ---------------------------------------------------------------------------
// Per-thread runtime — Librarian, Cartographer, Wardens, orchestrator, bridges
// ---------------------------------------------------------------------------

const eventStream = new EventStream();

// The Warden pre-filter (settings `prefilter`, off by default): when turned on, a local decision model
// skips a Warden on a confident "not my domain". Off, no model server starts and every Warden is
// asked. On with its model missing or down, every Warden is asked and the viewer and log say so.
const prefilterSettings = resolvePrefilterSettings(config.prefilter);
const prefilterServer = prefilterSettings.enabled
  ? await startPrefilterServer(prefilterSettings)
  : undefined;
const prefilter = prefilterSettings.enabled
  ? new WardenPrefilter(config.prefilter, {
      onHealth: (health) => {
        if (health.ok) return console.log('Warden pre-filter: ready');
        const message = `Warden pre-filter unavailable (${health.reason}); every Warden is asked`;
        console.warn(`[warden-prefilter] ${message}`);
        eventStream.pushError('warden-prefilter', message, 'warn');
      },
    })
  : undefined;
if (prefilterServer?.status === 'not-installed') {
  // Every Warden is asked; say so in the log and the viewer without probing the network.
  const message =
    'Warden pre-filter model not installed (run `foundry-acp setup`); every Warden is asked';
  console.warn(`[warden-prefilter] ${message}`);
  eventStream.pushError('warden-prefilter', message, 'warn');
} else void prefilter?.waitReady(prefilterServer?.status === 'started' ? 120_000 : 0);

// atlasRoot: first atlas-mapped project (has .atlas/ or MAP.md), else the cwd.
const atlasRoot = atlasRootOf(config);

// Every factory-created thread (main included) gets its own Librarian,
// Cartographer, Wardens, FlowOrchestrator, reactive rules, event bridges and
// persistence sinks; archiving the thread disposes them.
const runtimeManager = new ThreadRuntimeManager({
  config,
  llm: flowLlm,
  providers,
  // Review uses its explicit phase profile, otherwise the configured flow policy.
  // No provider is constructed and no live binding/settings are changed by this resolver.
  learning: resolveLearningSettings(config.learning, providers, flowLlm, decisionModel),
  eventStream,
  ...(prefilter ? { prefilter } : {}),
  atlasRoot,
  // Wardens come from settings only; their domain knowledge sources resolve like layer sources.
  resolveSource: sourceResolver,
  ...(stageHost ? { stageHost } : {}),
  // Foundry's own signals feed the memory store only while a configured "file" source reads it as
  // working memory. With none (a fresh install), nothing Foundry logs lands where a source reads it back.
  signalSinks: [
    (signal, owner) =>
      Object.values(configStore.config.sources).some(
        (source) => source.enabled && source.type === 'file',
      )
        ? writeSignal(signal, owner)
        : undefined,
  ],
  // Native session lifecycle (compaction) binds per thread, on its worker's adapter: central
  // session to the thread bus, auxiliaries (classifier/router/cartographer/wardens) to a side bus
  // that never invalidates the central ledger.
  sessionAdapters,
  // Conversation threads are always wrapped and carry their members' notes; bound once the viewer exists.
  conversations: lateConversationWrapper(() => conversationService ?? undefined),
});

const factory = new ThreadFactory({
  stack: templateStack,
  agents: templateAgents,
  runtime: runtimeManager,
  nativeTools: tools,
  configuration: {
    config,
    layers: { sourceResolver },
    agents: {
      provider,
      tokenTracker,
      tools,
      // Refuse an unavailable explicit project provider; only these providers
      // have actually been constructed above.
      providers,
    },
  },
  // A thread's worker: a subscription worker with its vendor on and a login (or, with apiTokens, the default).
  workerRequirement: (view, worker, projectId) =>
    threadWorkerRequirement(subscription, view, worker, projectId),
});

// Settings edits reach live threads on their next turn; decision providers stay as started.
configStore.onChange(async (next) => {
  const effective = (subscription ? resolveSubscriptionPolicy(next)?.config : undefined) ?? next;
  liveConfig = effective;
  for (const change of await factory.reconfigure(effective)) console.log(`[settings] ${change}`);
});
configStore.watch();

// ---------------------------------------------------------------------------
// Create main thread (lightweight handle over shared project state)
// ---------------------------------------------------------------------------

// Main joins the first enabled project at construction, so its runtime's learning owner
// (captured when the runtime is built) matches the project it is later listed under.
const mainProjectId = Object.values(config.projects ?? {}).find(
  (project) => project.enabled !== false,
)?.id;
// Main keeps the worker it ran on: a later change of the project's default is never applied to it
// silently, and a stored record without one is refused, not given the current default.
// Records from before FEAT-007 get the worker they ran on, once, before anything reads them.
const stampedWorkers = LocalSessionStore.stampWorkers(join(FOUNDRY_DIR, 'sessions.sqlite'), {
  bindings: await sessionStore.bindings(),
  // Every runtime a worker can bind, built here or not: a Codex binding stays Codex with Codex off.
  runtimeWorker: new Map<string, string>(
    Object.entries(WORKER_SESSION_RUNTIMES).map(([worker, runtime]) => [runtime, worker]),
  ),
  projectDefault: (projectId) =>
    (projectId ? effectiveProject(config, projectId)?.defaults?.provider : undefined) ??
    config.defaults.provider,
});
if (stampedWorkers.stamped.length)
  console.log(
    `[Workers] ${stampedWorkers.stamped.length} stored threads given the worker they ran on`,
  );
if (stampedWorkers.ambiguous.length)
  console.warn(
    `[Workers] bound under more than one runtime, left without a worker: ${stampedWorkers.ambiguous.join(', ')}`,
  );
const mainWorker = LocalSessionStore.storedWorker(join(FOUNDRY_DIR, 'sessions.sqlite'), 'main');
const thread = createMainThread(factory, {
  description: 'Main conversation thread',
  ...(mainProjectId ? { projectId: mainProjectId } : {}),
  ...(mainWorker ? { worker: mainWorker } : {}),
});

// Main's own stack. Everything below (reactive rules, Librarian, Cartographer,
// Wardens, FlowOrchestrator) binds to this instance, not to the template, so
// main's thread-state and cache writes stay private to main.
const stack = thread.stack;

const mainRuntime = runtimeManager.get(thread.id)!;
threadMeta = (threadId) => runtimeManager.get(threadId)?.thread.meta;

// ---------------------------------------------------------------------------
// Session adapter — long-lived HarnessSession factory with crash recovery
//
// Only meaningful for runtime-backed providers (claude-code, codex). The
// adapter:
//   - Persists (threadId → native session ID) to .foundry/sessions.json so
//     Foundry restarts resume native sessions instead of abandoning them.
//   - Bridges session_compact events from the runtime into the signal bus
//     as `session_compacted` signals, which the FlowOrchestrator observes
//     to clear the Librarian's injection ledger and re-hydrate next turn.
// ---------------------------------------------------------------------------

if (sessionAdapters.size)
  console.log(
    `Session adapters: ${[...sessionAdapters.values()].map((adapter) => adapter.runtime).join(', ')} (store: ${FOUNDRY_DIR}/sessions.json)`,
  );

// ---------------------------------------------------------------------------
// Flow — main's Cartographer, Wardens, Librarian and FlowOrchestrator are
// owned by its ThreadRuntime (see agents/thread-runtime.ts). Every other
// factory-created thread gets the same wiring automatically.
// ---------------------------------------------------------------------------

console.log(
  `Flow: Cartographer + ${mainRuntime.domainLibrarians.size} domain librarians + Librarian (${flowLlm.id}) per thread`,
);

// ---------------------------------------------------------------------------
// Build harness
// ---------------------------------------------------------------------------

const harness = new Harness(thread);

// Classifier/router/executor from config agent kinds, and invocation/activation modes.
configureHarness(harness, config);

// ---------------------------------------------------------------------------
// Postgres persistence (optional — requires DATABASE_URL)
// ---------------------------------------------------------------------------

let pgMemory: PostgresMemory | undefined;

/** An `entries` row as the Postgres memory tool reads it. */
type PgEntryRow = {
  id: string;
  kind: string;
  content: string;
  timestamp: Date | null;
  meta: unknown;
};
const pgEntry = (r: PgEntryRow): MemoryEntry => ({
  id: r.id,
  kind: r.kind,
  content: r.content,
  timestamp: r.timestamp?.getTime() ?? Date.now(),
  meta: (r.meta ?? undefined) as MemoryEntry['meta'],
});

if (process.env.DATABASE_URL) {
  try {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    pgMemory = new PostgresMemory(prisma);
    // Postgres is a memory backend only: a queryable tool for agents (journal + Archive hold the record).
    const pgTool = MemoryToolAdapter.from('postgres', {
      write: (e) => pgMemory!.writeEntry(e),
      get: (id) => pgMemory!.getEntry(id).then((r) => (r ? pgEntry(r) : undefined)),
      search: (q, limit) =>
        pgMemory!.searchEntries(q, limit).then((rows) => (rows as PgEntryRow[]).map(pgEntry)),
      recent: (limit, kind) =>
        pgMemory!.recentEntries(limit, kind).then((rows) => rows.map(pgEntry)),
      delete: (id) => pgMemory!.deleteEntry(id),
    });
    tools.register(pgTool, 'Persistent memory — postgres-backed signals, threads, history');
    console.log(`Postgres: connected (${process.env.DATABASE_URL.replace(/\/\/.*@/, '//***@')})`);
  } catch (err) {
    console.warn(`Postgres: unavailable (${(err as Error).message}). Running in-memory only.`);
  }
}

// ---------------------------------------------------------------------------
// MuninnDB neural memory (optional — requires MUNINN_URL)
// ---------------------------------------------------------------------------

if (process.env.MUNINN_URL) {
  try {
    const { MuninnMemory } = await import('./adapters/muninn-memory');
    const muninn = new MuninnMemory({
      baseUrl: process.env.MUNINN_URL,
      vault: process.env.MUNINN_VAULT ?? 'foundry',
      token: process.env.MUNINN_TOKEN,
    });

    // Wire signal persistence to MuninnDB
    runtimeManager.addSignalSink(muninn.signalWriter());

    // Register as queryable tool for agents
    const muninnTool = MemoryToolAdapter.fromMuninnMemory(muninn);
    tools.register(muninnTool, 'Neural memory — MuninnDB with decay, strengthening, associations');

    console.log(`MuninnDB: connected (${process.env.MUNINN_URL})`);
  } catch (err) {
    console.warn(
      `MuninnDB: unavailable (${(err as Error).message}). Running without neural memory.`,
    );
  }
}

console.log(
  `Tools: ${tools
    .list()
    .map((t) => t.id)
    .join(', ')}`,
);

// ---------------------------------------------------------------------------
// Event stream + viewer
// ---------------------------------------------------------------------------

// Lifecycle/signal bridges into eventStream and thread.start() are owned by
// each thread's runtime (attached at factory.create).

const interventions = new InterventionLog();

// -- Project registry --
const projectRegistry = new ProjectRegistry();

// Load projects from config and register them
if (config.projects) {
  projectRegistry.loadFromConfigs(config.projects);
  // Associate the main thread with the first project so it shows up in the viewer
  const firstProject = projectRegistry.all.values().next().value;
  if (firstProject) {
    firstProject.addThread(thread);
  }
  console.log(`Projects: ${[...projectRegistry.all.keys()].join(', ') || '(none)'}`);
}

const port = parseInt(process.env.VIEWER_PORT || '4500');

// The daemon (or an explicitly named launch path) publishes where local ACP proxies find it.
const acpLaunch =
  process.env.FOUNDRY_DAEMON === '1' || process.env.FOUNDRY_ACP_LAUNCH
    ? { path: acpLaunchPath() }
    : undefined;

const claudeProvider = workers.get('claude-code')?.provider;
const viewer = await startViewer({
  autoTunnel: true,
  logins: {
    pools: loginPools,
    runs: loginRuns,
    setup: new LoginSetup({ foundryDir: FOUNDRY_DIR, store: configStore }),
  },
  harness,
  eventStream,
  interventions,
  port,
  configDir: FOUNDRY_DIR,
  assistProvider: provider,
  assistModel: config.defaults.model,
  namingProvider: flowLlm,
  // A thread switching worker leaves its session on the old one behind (ended, never resumed).
  workerSessions: {
    retire: async (worker, threadId) => {
      const built = workers.get(worker)?.provider;
      return built instanceof SessionBackedProvider ? built.retireThread(threadId) : undefined;
    },
  },
  feedbackProvider: flowLlm,
  tokenTracker,
  analyticsDir: `${FOUNDRY_DIR}/analytics`,
  projectRegistry,
  threadFactory: factory,
  configStore,
  actionQueue,
  assistTools: tools,
  threadLaunch,
  // Every worker's subagents become observed child threads (docs/THREAD-TREE.md spec A).
  subagentSources: sessionProviders,
  taskSources: sessionProviders,
  // Turns a worker's session starts itself (Muse crons, monitors, goals) land in their thread.
  nativeTurnSources: sessionProviders,
  ...(inSession && claudeProvider instanceof SessionBackedProvider
    ? {
        threadSetup: inSessionThreadSetup({
          wardens: inSession,
          provider: claudeProvider,
          worker: (threadId) => threadMeta?.(threadId)?.worker,
          onSetup: (listener) => {
            setupListeners.push(listener);
          },
        }),
      }
    : {}),
});
toolGateFor = viewer.toolGate;
journalStore = viewer.localStore;
conversationService = viewer.conversations;
threadRecords = viewer.records;
secretScratch = viewer.secrets;

console.log(`Viewer: http://localhost:${viewer.server.port ?? port}`);
if (acpLaunch) {
  try {
    writeAcpLaunch(acpLaunch.path, { port: viewer.server.port ?? port });
    console.log(`ACP: launch file ${acpLaunch.path}`);
  } catch (error) {
    console.warn(`ACP: launch file not written: ${(error as Error).message}`);
  }
}
console.log(`Provider: ${provider.id} (${config.defaults.model})`);
console.log(`Agents: ${[...thread.agents.keys()].join(', ')}`);
console.log(`Layers: ${stack.layers.map((l) => l.id).join(', ')}`);
console.log(
  `Persistence: local SQLite${pgMemory ? ' + postgres memory' : ''}${process.env.MUNINN_URL ? ' + muninn' : ''}`,
);
console.log();

// ---------------------------------------------------------------------------
// Startup self-test — verify the LLM provider actually works
// ---------------------------------------------------------------------------

await runStartupSelfTest({
  enabled: selfTestRequested,
  provider: decisions?.provider ?? provider,
  model: decisions ? decisionModel : config.defaults.model,
  // A Foundry-owned folder, stamped for Archive: the self-test is Foundry's session, not the user's.
  cwd: stampFoundryRun(privateDirectory(resolve(FOUNDRY_DIR, 'self-test'))),
  log: console.log,
  warn: console.warn,
  error: console.error,
});

// A staged update spins the daemon down: running turns finish, new ones wait, then it restarts
// and runs them (`daemon/restart-roll.ts`).
publishDaemonRuntime({
  liveTurns: viewer.liveTurns,
  offerUpdate: (offer) => viewer.restartRoll.offerUpdate(offer),
});
// Turns a planned restart held (the spin-down) run now, in the order they arrived.
void viewer.resumeHeldTurns();

console.log();
console.log('Ready. Send messages through the harness API or viewer.');

// ---------------------------------------------------------------------------
// Keep alive
// ---------------------------------------------------------------------------

const shutdown = async () => {
  console.log('\nShutting down...');
  // A launch file outliving its daemon would point ACP proxies at whatever binds the port next.
  if (acpLaunch) removeAcpLaunch(acpLaunch.path, process.pid);
  // Native processes must exit before their profile locks (in ~/.claude, ~/.codex) are released.
  await Promise.race([
    Promise.all([
      ...[...sessionAdapters.values()].map((adapter) => adapter.releaseAll?.()),
      live?.shutdown(),
      inSession?.close(),
    ]),
    Bun.sleep(5_000),
  ]);
  runtimeManager.disposeAll();
  prefilterServer?.stop();
  viewer.server.stop();
  viewer.localStore?.close();
  await viewer.analyticsStore?.flush();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
