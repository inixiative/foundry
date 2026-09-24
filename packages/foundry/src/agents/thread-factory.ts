import type { TokenCounts } from "@inixiative/foundry-core";
import { DECISION_MODEL } from "../models/registry";
import { FoundryCredentials } from '../providers/credentials';
import { fileURLToPath } from "node:url";
import { createNativeToolProjector } from "./native-tool-projection";
import {
  ContextLayer,
  type ContextSource,
  ContextStack,
  FileMemory,
  MarkdownDocs,
  inlineSource,
  type OwnershipScope,
  Thread,
  type ThreadConfig,
  Classifier,
  type Classification,
  Router,
  type Route,
  Executor,
  type Decision,
  type BaseAgent,
  type LLMProvider,
  type LLMMessage,
  type CompletionOpts,
  type CompletionResult,
  type ExecuteMeta,
  type TokenTracker,
  type ToolRegistry,
} from "@inixiative/foundry-core";
import { toolUseLoop } from "./tool-loop";
import type { SessionAdapter } from "../providers/session-adapter";
import { auxiliarySessionId, type ThreadRuntimeManager } from "./thread-runtime";
import { nativeBridgeSource, type NativeToolJournal } from "../mcp/native-bridge";
import type {
  FoundryConfig,
  AgentSettingsConfig,
  LayerSettingsConfig,
} from "../viewer/config";
import { resolveProjectView } from "../viewer/config-resolve";
import { configuredExperts } from "./configured-experts";
import { ArchiveContextSource, archiveContextSchema } from "../archives/context-source";

// ---------------------------------------------------------------------------
// Source resolver — turns config source IDs into ContextSources
// ---------------------------------------------------------------------------

/**
 * Resolve a source ID from config into a ContextSource.
 * The adapter parameter lets callers supply memory-backed or file-backed sources.
 */
export type SourceResolver = (sourceId: string, config: FoundryConfig) => ContextSource | null;

export interface SourceResolverDeps {
  /** Project memory store backing every "file" source. */
  memory: FileMemory;
  configDir?: string;
}

/**
 * The production source resolver shared by startup and research runs.
 *
 * "file" sources are memory-backed and scope-aware: each thread's clone binds
 * them to that thread, so a thread reads its own captures plus whatever was
 * explicitly published to its project or globally. The source's configured
 * `scope` caps that ("project" or "global" never expose thread captures), and
 * legacy unowned records stay hidden unless `includeUnowned` is set.
 */
export function createSourceResolver(deps: SourceResolverDeps): SourceResolver {
  return (sourceId, cfg) => {
    const srcCfg = cfg.sources[sourceId];
    if (!srcCfg || !srcCfg.enabled) return null;

    switch (srcCfg.type) {
      case "archive":
        return new ArchiveContextSource(srcCfg.id, srcCfg.uri, archiveContextSchema.parse(srcCfg.archive), undefined, fetch, new FoundryCredentials(deps.configDir, () => cfg.kingdomRuntime));
      case "inline":
        return inlineSource(srcCfg.id, srcCfg.uri);
      case "file":
        // Bounded selection by default: the owned log stays complete and
        // searchable, the automatic input is a deterministic, reported subset.
        return deps.memory.asSource(srcCfg.id, {
          kind: srcCfg.id.includes("convention") ? "convention" : undefined,
          scope: srcCfg.scope,
          includeUnowned: srcCfg.includeUnowned,
          selection: srcCfg.selection === false ? false : { ...(srcCfg.selection ?? {}) },
        });
      case "markdown":
        // A markdown directory. For non-trivial corpora (> ~3k tokens) emitting
        // the full content blows the layer budget. topologySource() produces a
        // compact H1+H2 index (~44 tokens/file) that the domain warden can
        // reason over; file bodies get hydrated on demand.
        return new MarkdownDocs(srcCfg.uri.startsWith("file:") ? fileURLToPath(srcCfg.uri) : srcCfg.uri).topologySource(srcCfg.id);
      default:
        return inlineSource(srcCfg.id, `[${srcCfg.type} source: ${srcCfg.uri}]`);
    }
  };
}

// ---------------------------------------------------------------------------
// Project-level builders — create shared layers and agents from config
// ---------------------------------------------------------------------------

export interface BuildLayersDeps {
  sourceResolver: SourceResolver;
}

/**
 * Build ContextLayer instances from project config.
 * Called once at project startup — layers are shared across all threads.
 */
export function buildLayers(config: FoundryConfig, deps: BuildLayersDeps): ContextLayer[] {
  configuredExperts(config);
  const layers: ContextLayer[] = [];

  for (const [id, layerCfg] of Object.entries(config.layers)) {
    if (!layerCfg.enabled) continue;

    const sources = (layerCfg.sourceIds ?? [])
      .map((srcId) => deps.sourceResolver(srcId, config))
      .filter(Boolean) as ContextSource[];

    layers.push(
      new ContextLayer({
        id,
        ...((layerCfg.domain !== undefined || layerCfg.writers !== undefined) ? { definition: Object.freeze({
          id, ...(layerCfg.domain !== undefined ? { domain: layerCfg.domain } : {}),
          ...(layerCfg.writers !== undefined ? { writers: Object.freeze([...layerCfg.writers]) as unknown as string[] } : {}),
        }) } : {}),
        staleness: layerCfg.staleness || undefined,
        prompt: layerCfg.prompt || undefined,
        // Configured provenance only; an unconfigured layer keeps the legacy classification.
        ...(layerCfg.segment ? { segment: layerCfg.segment } : {}),
        sources,
      }),
    );
  }

  // Fallback: if no layers configured, create a basic system layer
  if (layers.length === 0) {
    layers.push(
      new ContextLayer({
        id: "system",
        sources: [{
          id: "default",
          load: async () => "You are a helpful engineering assistant.",
        }],
      }),
    );
  }

  return layers;
}

export interface BuildAgentsDeps {
  provider: LLMProvider;
  /** When supplied, every enabled agent must resolve its configured provider. */
  providers?: ReadonlyMap<string, LLMProvider>;
  tokenTracker?: TokenTracker;
  tools?: ToolRegistry;
}

/**
 * Build agent instances from project config.
 * Called once for the project template; ThreadFactory clones agents per thread.
 */
export function buildAgents(
  config: FoundryConfig,
  stack: ContextStack,
  deps: BuildAgentsDeps,
): Map<string, BaseAgent> {
  const agents = new Map<string, BaseAgent>();

  for (const [id, agentCfg] of Object.entries(config.agents)) {
    if (!agentCfg.enabled) continue;
    // The runtime owns these pre/post actors; do not build a second executor.
    if (agentCfg.flowRole === "domain-advising") continue;
    const providerId = agentCfg.provider || config.defaults.provider;
    const provider = deps.providers ? deps.providers.get(providerId) : deps.provider;
    if (!provider) throw new Error(`No provider registered for ${providerId} (agent ${id})`);
    const agent = buildAgent(id, agentCfg, config, stack, { ...deps, provider });
    if (agent) agents.set(id, agent);
  }

  return agents;
}

// ---------------------------------------------------------------------------
// ThreadFactory — lightweight thread creation from shared project state
// ---------------------------------------------------------------------------

export interface ThreadFactoryDeps {
  /** Saved snapshot for project-specific construction through the same builders.
   * Hot edits require an explicit new factory; existing threads are untouched. */
  configuration?: { config: FoundryConfig; layers: BuildLayersDeps; agents: BuildAgentsDeps };
  /** Actual scoped registry used by the owned runtime's native read-only bridge. */
  nativeTools?: ToolRegistry;
  /**
   * Project template stack. Built and warmed once from config; every thread
   * receives independent clones of these layers seeded from the template's
   * current warm content. The template itself is never handed to a thread.
   */
  stack: ContextStack;
  /**
   * Project template agents. Every thread receives its own agent instances
   * bound to that thread's stack; the template agents are never registered
   * on a thread directly.
   */
  agents: Map<string, BaseAgent>;
  /**
   * Optional session adapter (e.g. ClaudeCodeSessionAdapter) for creating
   * long-lived HarnessSessions per thread. Made available on the factory
   * so viewer routes and future session-aware executors can resolve it
   * without reaching into start.ts.
   */
  sessionAdapter?: SessionAdapter;
  /**
   * Optional per-thread runtime manager. When present, every created thread
   * is wired (Librarian, Cartographer, Wardens, orchestrator, event bridges)
   * before it is returned, and archiving the thread tears that wiring down.
   */
  runtime?: ThreadRuntimeManager;
}

/**
 * Factory that creates Thread instances from a project template.
 *
 * Layer definitions and agent configuration are project-scoped and built once.
 * Each thread gets its own layer instances (cloned from the warm template) and
 * its own agent instances bound to that stack, so one thread's writes, private
 * layers, and dispatches never reach another thread.
 */
export class ThreadFactory {
  private _stack: ContextStack;
  private _agents: Map<string, BaseAgent>;
  private _sessionAdapter?: SessionAdapter;
  private _runtime?: ThreadRuntimeManager;
  private _nativeTools?: ToolRegistry;
  private _configuration?: ThreadFactoryDeps["configuration"];

  constructor(deps: ThreadFactoryDeps) {
    this._stack = deps.stack;
    this._agents = deps.agents;
    this._sessionAdapter = deps.sessionAdapter;
    this._runtime = deps.runtime;
    this._nativeTools = deps.nativeTools;
    if (deps.configuration) this._configuration = { ...deps.configuration, config: structuredClone(deps.configuration.config) };
  }

  /** The runtime session adapter, if one was configured. */
  get sessionAdapter(): SessionAdapter | undefined {
    return this._sessionAdapter;
  }

  /** The per-thread runtime manager, if one was configured. */
  get runtime(): ThreadRuntimeManager | undefined {
    return this._runtime;
  }

  nativeBridge(thread: Thread, journal: NativeToolJournal, deviceIdentityPath?: string) {
    if (!this._nativeTools) return undefined;
    if (!this._runtime) throw Error("Native tools require a registered live runtime");
    return nativeBridgeSource(thread, this._runtime, this._nativeTools, journal, deviceIdentityPath);
  }

  /**
   * Attach a session adapter after construction. The adapter typically needs
   * access to a thread's signal bus, which doesn't exist until a thread is
   * created — so the factory often has to be built first, then retrofitted
   * with the adapter once the main thread's signals are available.
   */
  attachSessionAdapter(adapter: SessionAdapter): void {
    this._sessionAdapter = adapter;
  }

  /**
   * Create a Thread with its own stack and agents, seeded from the template.
   * Scope-aware sources are bound to this thread; the project is resolved
   * lazily so assignment after creation (project.addThread) is honored on
   * every later warm and refresh.
   */
  create(
    id: string,
    opts?: ThreadConfig,
  ): Thread {
    let thread: Thread | undefined;
    const scope: OwnershipScope = {
      threadId: id,
      get projectId() { return thread?.meta.projectId ?? opts?.projectId; },
    };
    const base = this._configuration;
    if (opts?.projectId && base?.config.projects[opts.projectId]?.enabled === false) throw Error("Cannot construct a thread for a disabled project");
    const config = base && (opts?.projectId ? resolveProjectView(base.config, opts.projectId)?.config : undefined) || base?.config;
    const template = config && base ? new ContextStack(buildLayers(config, base.layers)) : this._stack;
    const agents = config && base ? buildAgents(config, template, base.agents) : this._agents;
    const stack = template.clone(scope);
    thread = new Thread(id, stack, opts);

    for (const agent of agents.values()) {
      thread.register(agent.withStack(stack));
    }

    // Match startup's initial warm, but bind sources to the owning thread first.
    // A failed load does not admit a provider call or use another project's cache.
    if (base) { let initialized = false; thread.middleware.use("factory:configured-sources", async (_ctx, next) => {
      if (!initialized) { await stack.warmAll(); initialized = true; }
      return next();
    }); }
    try { this._runtime?.attach(thread, config); }
    catch (error) { thread.dispose(); throw error; }

    return thread;
  }
}

// ---------------------------------------------------------------------------
// Single-agent builder (used by buildAgents and research runner)
// ---------------------------------------------------------------------------

function buildAgent(
  id: string,
  agentCfg: AgentSettingsConfig,
  config: FoundryConfig,
  stack: ContextStack,
  deps: BuildAgentsDeps,
): BaseAgent | null {
  const complete = trackedComplete(id, deps);
  const opts = resolveAgentOpts(agentCfg, config);

  switch (agentCfg.kind) {
    case "classifier":
      return new Classifier<string>({
        id,
        stack,
        handler: async (ctx, payload, meta) => {
          if (!agentCfg.prompt) return keywordClassify(payload);
          try {
            const result = await complete(
              [
                {
                  role: "system",
                  content: `${ctx}\n\n${agentCfg.prompt}\n\nYou are a classifier. You have no tools. Respond with JSON only — no tool calls, no code execution, no file operations.`,
                },
                { role: "user", content: payload },
              ],
              { ...opts, maxTokens: 256, maxTurns: 1, ...auxiliaryIdentity(meta, `agent:${id}`, deps.provider) },
            );
            const parsed = parseJSON(result.content);
            if (!parsed || typeof parsed.category !== "string" || !parsed.category.trim() || parsed.reasoning === "parse failure") {
              throw new Error("Invalid classifier JSON");
            }
            return {
              value: { category: parsed.category as string || "general", subcategory: parsed.subcategory as string },
              confidence: 0.9,
              reasoning: (parsed.reasoning as string) || "LLM classification",
            };
          } catch (err) {
            console.warn(`[buildAgent] LLM classify failed, falling back to keyword:`, (err as Error).message);
            return keywordClassify(payload);
          }
        },
      });

    case "router":
      return new Router<{ payload: string; classification: Classification } | string>({
        id,
        stack,
        handler: async (ctx, input, meta) => {
          const payload = typeof input === "string" ? input : input.payload;
          const classification = typeof input === "string" ? null : input.classification;

          if (!classification) {
            return keywordRoute(keywordClassify(payload).value, config);
          }

          if (!agentCfg.prompt) return keywordRoute(classification, config);
          try {
            const result = await complete(
              [
                {
                  role: "system",
                  content: `${ctx}\n\n${agentCfg.prompt}\n\nYou are a router. You have no tools. Respond with JSON only — no tool calls, no code execution, no file operations.`,
                },
                {
                  role: "user",
                  content: `Classification: ${JSON.stringify(classification)}\nMessage: ${payload}`,
                },
              ],
              { ...opts, maxTokens: 256, maxTurns: 1, ...auxiliaryIdentity(meta, `agent:${id}`, deps.provider) },
            );
            const parsed = parseJSON(result.content);
            const target = typeof parsed?.destination === "string" ? config.agents[parsed.destination] : undefined;
            if (!target || target.kind !== "executor" || !target.enabled || !target.prompt) {
              throw new Error("Router did not select an enabled configured executor");
            }
            if (parsed.contextSlice !== undefined && (!Array.isArray(parsed.contextSlice)
              || !parsed.contextSlice.every(id => typeof id === "string" && !!config.layers[id]))) {
              throw new Error("Router returned an invalid context slice");
            }
            return {
              value: {
                destination: parsed.destination as string,
                contextSlice: (parsed.contextSlice as string[]) || Object.keys(config.layers),
                priority: (parsed.priority as number) ?? 5,
              },
              confidence: 0.9,
              reasoning: (parsed.reasoning as string) || "LLM routing",
            };
          } catch (err) {
            console.warn(`[buildAgent] LLM route failed, falling back to keyword:`, (err as Error).message);
            const fallback = keywordRoute(classification, config);
            return { ...fallback, confidence: 0,
              reasoning: `fallback: ${(err as Error).message}; ${fallback.reasoning}` };
          }
        },
      });

    case "executor":
    default: {
      if (!agentCfg.prompt) {
        console.warn(`[buildAgent] Agent "${id}" has no prompt configured — skipping.`);
        return null;
      }

      const tools = deps.tools;
      const useToolLoop = tools && tools.size > 0 && opts.tools !== false;

      return new Executor<string, string>({
        id,
        stack,
        handler: async (ctx, payload, meta) => {
          const systemParts = [ctx, agentCfg.prompt];

          if (tools && tools.size > 0) {
            systemParts.push(`\n## Available Tools\n${tools.summary()}`);
          }

          const messages: LLMMessage[] = [
            { role: "system", content: systemParts.join("\n\n") },
            { role: "user", content: payload },
          ];
          meta?.recordProviderInput?.(messages);
          // Owned public native tool events feed the dispatch's ordinary tool observation channel
          // (the same one the local tool loop uses), so post-review input sees what the native
          // engine ran. The raw journal write comes first and is independent of this projection.
          // The central executor's provider pool is the thread id; the provider adds it to the admitted
          // owner at registration, so the projector validates the logical owner plus this expected pool.
          const projector = meta?.nativeObservation?.owner && meta.observeTool && meta.threadId
            ? createNativeToolProjector({ owner: meta.nativeObservation.owner, expectedPool: meta.threadId, observeTool: meta.observeTool }) : undefined;
          const nativeObservation = meta?.nativeObservation && deps.provider.nativeOwnership === "required-prewrite" ? {
            ...meta.nativeObservation,
            register: async (evidence: import("@inixiative/foundry-core").NativeEvidence) => {
              await meta.nativeObservation!.register(evidence);
              projector?.register(evidence);
            },
            observe: async (evidence: import("@inixiative/foundry-core").NativeEvidence) => {
              meta.recordNative?.(evidence);
              if ((evidence.kind === "text" || evidence.kind === "text_delta") && evidence.text) meta.onDelta?.(evidence.text);
              await meta.nativeObservation!.observe(evidence);
              projector?.observe(evidence);
            },
          } : undefined;

          try {
            if (useToolLoop) {
              const result = await toolUseLoop(
                deps.provider,
                messages,
                tools,
                {
                  ...opts,
                  nativeObservation,
                  threadId: meta?.threadId,
                  toolCwd: meta?.cwd,
                  // Memory tools read and write within the dispatching thread's ownership.
                  toolScope: meta?.threadId ? { threadId: meta.threadId, projectId: meta.projectId } : undefined,
                  // Every executed tool is attributed to this dispatch, never to the next completion.
                  dispatchId: meta?.dispatchId,
                  onToolObservation: meta?.observeTool,
                  maxIterations: 10,
                  onToolCall: (name, input, resultStr) => {
                    console.log(`    [${id}] tool: ${name}(${Object.values(input).map((v) => String(v).slice(0, 40)).join(", ")})`);
                  },
                },
              );

              if (deps.tokenTracker && result.tokens) {
                deps.tokenTracker.record({
                  provider: deps.provider.id,
                  model: result.model,
                  agentId: id,
                  tokens: result.tokens,
                });
              }

              return result.content;
            } else if (meta?.onDelta && typeof deps.provider.stream === "function") {
              // Streaming path — forward text deltas to the sink, accumulate
              // full content for the return value + single DB write upstream.
              let full = "";
              let tokens: TokenCounts | undefined;
              for await (const ev of deps.provider.stream(messages, { ...opts, nativeObservation, cwd: meta?.cwd, threadId: meta?.threadId })) {
                if (ev.type === "text" && ev.text) {
                  full += ev.text;
                  meta.onDelta(ev.text);
                } else if (ev.type === "usage" && ev.tokens) {
                  tokens = ev.tokens;
                } else if (ev.type === "error") {
                  throw new Error(ev.error ?? "stream error");
                }
              }
              if (deps.tokenTracker && tokens) {
                deps.tokenTracker.record({
                  provider: deps.provider.id,
                  model: opts.model ?? "unknown",
                  agentId: id,
                  tokens,
                });
              }
              return full;
            } else {
              const result = await complete(messages, { ...opts, nativeObservation, cwd: meta?.cwd, threadId: meta?.threadId });
              if (result.native) meta?.recordNative?.(result.native);
              return result.content;
            }
          } catch (err) {
            throw err;
          }
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Provider helpers
// ---------------------------------------------------------------------------

/**
 * Session identity for a thread's auxiliary decision (classifier/router).
 * Never the bare thread id: that belongs to the central executor session.
 */
function auxiliaryIdentity(meta: ExecuteMeta | undefined, role: string, provider: LLMProvider): Pick<CompletionOpts, "threadId" | "cwd" | "nativeObservation"> {
  if (!meta?.threadId) return {};
  return { threadId: auxiliarySessionId(meta.threadId, role), cwd: meta.cwd,
    ...(meta.nativeObservation && provider.nativeOwnership === "required-prewrite" ? { nativeObservation: { ...meta.nativeObservation, bridge: undefined, observe: evidence => {
      meta.recordNative?.(evidence); return meta.nativeObservation!.observe(evidence);
    } } } : {}) };
}

function trackedComplete(agentId: string, deps: BuildAgentsDeps) {
  const { provider, tokenTracker } = deps;
  return async (messages: LLMMessage[], opts?: CompletionOpts): Promise<CompletionResult> => {
    const result = await provider.complete(messages, opts);
    if (tokenTracker && result.tokens) {
      tokenTracker.record({
        provider: provider.id,
        model: result.model,
        agentId,
        tokens: result.tokens,
      });
    }
    return result;
  };
}

// ---------------------------------------------------------------------------
// Shared fallback handlers (no LLM needed)
// ---------------------------------------------------------------------------

export function keywordClassify(payload: string): Decision<Classification> {
  const lower = payload.toLowerCase();
  let category = "general";
  if (lower.includes("bug") || lower.includes("fix") || lower.includes("error")) category = "bug";
  else if (lower.includes("feature") || lower.includes("add") || lower.includes("build")) category = "feature";
  else if (lower.includes("refactor") || lower.includes("clean")) category = "refactor";
  else if (lower.includes("question") || lower.includes("how") || lower.includes("why")) category = "question";
  else if (lower.includes("convention") || lower.includes("style")) category = "convention";
  return { value: { category }, confidence: 0.7, reasoning: `keyword: ${category}` };
}

export function keywordRoute(
  classification: Classification,
  config: FoundryConfig,
): Decision<Route> {
  const layerIds = Object.keys(config.layers);
  const routeMap: Record<string, { dest: string; layers: string[] }> = {
    bug: { dest: "artificer", layers: layerIds },
    feature: { dest: "artificer", layers: ["system", "conventions"] },
    refactor: { dest: "artificer", layers: ["system", "conventions"] },
    question: { dest: "artificer", layers: ["system", "memory"] },
    convention: { dest: "artificer", layers: ["conventions", "memory"] },
    general: { dest: "artificer", layers: ["system"] },
  };
  const route = routeMap[classification.category] ?? routeMap.general;
  const candidates = Object.entries(config.agents).filter(([, agent]) => agent.enabled && agent.kind === "executor" && !!agent.prompt);
  const destination = candidates.find(([id]) => id === route.dest)?.[0] ?? candidates[0]?.[0];
  if (!destination) throw new Error("Routing failed and no enabled executor is configured");
  return {
    value: { destination, contextSlice: route.layers.filter(id => !!config.layers[id]), priority: 5 },
    confidence: 0.8,
    reasoning: `rule: ${classification.category} → ${destination}`,
  };
}

// ---------------------------------------------------------------------------
// Config → CompletionOpts resolver
// ---------------------------------------------------------------------------

/**
 * Resolve canonical agent config into CompletionOpts.
 *
 * Per-kind defaults (maxTokens chosen automatically):
 * - classifier/router: tools=false, 256 max output tokens, no thinking
 * - executor: tools=true, 16384 max output tokens, thinking from config
 */
export function resolveAgentOpts(
  agentCfg: AgentSettingsConfig,
  config: FoundryConfig,
): CompletionOpts {
  const isLightweight = agentCfg.kind === "classifier" || agentCfg.kind === "router";

  return {
    model: agentCfg.model || (isLightweight ? config.defaults.classifierModel ?? DECISION_MODEL : config.defaults.model),
    temperature: agentCfg.temperature ?? 0,
    maxTokens: isLightweight ? 256 : 16384,
    tools: agentCfg.tools ?? !isLightweight,
    thinking: agentCfg.thinking ?? "none",
    permissions: agentCfg.permissions,
    timeout: agentCfg.timeout,
    cacheControl: agentCfg.cacheControl,
  };
}

export function parseJSON(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  try {
    return JSON.parse(raw.trim());
  } catch {
    const braced = raw.match(/\{[\s\S]*\}/);
    if (braced) {
      try { return JSON.parse(braced[0]); } catch { /* fall through */ }
    }
    return { category: "general", reasoning: "parse failure" };
  }
}
