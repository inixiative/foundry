import {
  ContextLayer,
  type ContextSource,
  ContextStack,
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
  type TokenTracker,
  type ToolRegistry,
} from "@inixiative/foundry-core";
import { toolUseLoop } from "./tool-loop";
import type {
  FoundryConfig,
  AgentSettingsConfig,
  LayerSettingsConfig,
} from "../viewer/config";

// ---------------------------------------------------------------------------
// Source resolver — turns config source IDs into ContextSources
// ---------------------------------------------------------------------------

/**
 * Resolve a source ID from config into a ContextSource.
 * The adapter parameter lets callers supply memory-backed or file-backed sources.
 */
export type SourceResolver = (sourceId: string, config: FoundryConfig) => ContextSource | null;

// ---------------------------------------------------------------------------
// ThreadFactory — stamps out threads with independent layer/agent instances
// ---------------------------------------------------------------------------

export interface ThreadFactoryDeps {
  /** LLM provider for agent completions. */
  provider: LLMProvider;
  /** Optional token tracker for cost tracking. */
  tokenTracker?: TokenTracker;
  /** Resolves source IDs to ContextSources (memory, file, inline, etc). */
  sourceResolver: SourceResolver;
  /** Optional tool registry — agents can discover and use registered tools. */
  tools?: ToolRegistry;
}

/**
 * Factory that creates fully-wired Thread instances from config.
 *
 * Each thread gets:
 * - Its own ContextLayer instances (mutations are thread-local)
 * - Its own agent instances (prompts/models can differ per-thread)
 * - A RunContext layer (`run:<threadId>`) that starts empty and
 *   accumulates mid-run learnings visible to all downstream stages
 *
 * This replaces the manual wiring in start.ts and powers
 * POST /api/threads with real per-thread instantiation.
 */
export class ThreadFactory {
  private _deps: ThreadFactoryDeps;

  constructor(deps: ThreadFactoryDeps) {
    this._deps = deps;
  }

  /**
   * Create a fully-wired Thread from config.
   *
   * @param id        Thread ID
   * @param config    Resolved FoundryConfig (global or per-project via resolveProject)
   * @param opts      Thread options (description, tags, etc)
   */
  async create(
    id: string,
    config: FoundryConfig,
    opts?: ThreadConfig & { warm?: boolean },
  ): Promise<{ thread: Thread; stack: ContextStack; agents: Map<string, BaseAgent> }> {
    // 1. Build layers from config
    const layers = this._buildLayers(config);

    // 2. Add RunContext layer — ephemeral, per-thread, accumulates mid-run learnings
    const runContext = new ContextLayer({
      id: `run:${id}`,
      trust: 8,
      prompt: "Context accumulated during this thread's run. Treat as recent, high-relevance observations.",
    });
    layers.push(runContext);

    // 3. Build stack
    const stack = new ContextStack(layers);

    // 4. Warm all layers if requested (default: yes)
    if (opts?.warm !== false) {
      await stack.warmAll();
    }

    // 5. Create thread
    const thread = new Thread(id, stack, opts);

    // 6. Build and register agents
    const agents = this._buildAgents(config, stack);
    for (const agent of agents.values()) {
      thread.register(agent);
    }

    // 7. Add logger middleware
    thread.middleware.use("logger", async (ctx, next) => {
      const start = performance.now();
      const result = await next();
      const ms = (performance.now() - start).toFixed(1);
      console.log(`  [${id}] ${ctx.agentId} (${ms}ms)`);
      return result;
    });

    return { thread, stack, agents };
  }

  // ---------------------------------------------------------------------------
  // Layer building
  // ---------------------------------------------------------------------------

  private _buildLayers(config: FoundryConfig): ContextLayer[] {
    const layers: ContextLayer[] = [];

    for (const [id, layerCfg] of Object.entries(config.layers)) {
      if (!layerCfg.enabled) continue;

      const sources = this._resolveSources(layerCfg, config);

      layers.push(
        new ContextLayer({
          id,
          trust: layerCfg.trust * 10, // Config uses 0-1, ContextLayer uses 0-10
          staleness: layerCfg.staleness || undefined,
          maxTokens: layerCfg.maxTokens || undefined,
          prompt: layerCfg.prompt || undefined,
          sources,
        }),
      );
    }

    // Fallback: if no layers configured, create a basic system layer
    if (layers.length === 0) {
      layers.push(
        new ContextLayer({
          id: "system",
          trust: 10,
          sources: [{
            id: "default",
            load: async () => "You are a helpful engineering assistant.",
          }],
        }),
      );
    }

    return layers;
  }

  private _resolveSources(
    layerCfg: LayerSettingsConfig,
    config: FoundryConfig,
  ): ContextSource[] {
    return (layerCfg.sourceIds ?? [])
      .map((srcId) => this._deps.sourceResolver(srcId, config))
      .filter(Boolean) as ContextSource[];
  }

  // ---------------------------------------------------------------------------
  // Agent building
  // ---------------------------------------------------------------------------

  private _buildAgents(
    config: FoundryConfig,
    stack: ContextStack,
  ): Map<string, BaseAgent> {
    const agents = new Map<string, BaseAgent>();

    for (const [id, agentCfg] of Object.entries(config.agents)) {
      if (!agentCfg.enabled) continue;

      const agent = this._buildAgent(id, agentCfg, config, stack);
      if (agent) agents.set(id, agent);
    }

    return agents;
  }

  private _buildAgent(
    id: string,
    agentCfg: AgentSettingsConfig,
    config: FoundryConfig,
    stack: ContextStack,
  ): BaseAgent | null {
    const complete = this._trackedComplete(id);

    // Resolve all completion opts from agent config
    const opts = resolveAgentOpts(agentCfg, config);

    switch (agentCfg.kind) {
      case "classifier":
        return new Classifier<string>({
          id,
          stack,
          handler: async (ctx, payload) => {
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
                { ...opts, maxTokens: agentCfg.maxTokens || 256, maxTurns: 1 },
              );
              const parsed = parseJSON(result.content);
              return {
                value: { category: parsed.category as string || "general", subcategory: parsed.subcategory as string },
                confidence: 0.9,
                reasoning: (parsed.reasoning as string) || "LLM classification",
              };
            } catch (err) {
              console.warn(`[ThreadFactory] LLM classify failed, falling back to keyword:`, (err as Error).message);
              return keywordClassify(payload);
            }
          },
        });

      case "router":
        return new Router<{ payload: string; classification: Classification } | string>({
          id,
          stack,
          handler: async (ctx, input) => {
            // input may be a string (raw payload) or { payload, classification } from harness
            const payload = typeof input === "string" ? input : input.payload;
            const classification = typeof input === "string" ? null : input.classification;

            if (!classification) {
              // No classification available — use keyword fallback on the raw payload
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
                { ...opts, maxTokens: agentCfg.maxTokens || 256, maxTurns: 1 },
              );
              const parsed = parseJSON(result.content);
              return {
                value: {
                  destination: (parsed.destination as string) || "executor-answer",
                  contextSlice: (parsed.contextSlice as string[]) || Object.keys(config.layers),
                  priority: (parsed.priority as number) ?? 5,
                },
                confidence: 0.9,
                reasoning: (parsed.reasoning as string) || "LLM routing",
              };
            } catch (err) {
              console.warn(`[ThreadFactory] LLM route failed, falling back to keyword:`, (err as Error).message);
              return keywordRoute(classification, config);
            }
          },
        });

      case "executor":
      default: {
        if (!agentCfg.prompt) {
          console.warn(`[ThreadFactory] Agent "${id}" has no prompt configured — skipping.`);
          return null;
        }

        const tools = this._deps.tools;
        const useToolLoop = tools && tools.size > 0 && opts.tools !== false;

        return new Executor<string, string>({
          id,
          stack,
          handler: async (ctx, payload) => {
            const systemParts = [ctx, agentCfg.prompt];

            if (tools && tools.size > 0) {
              systemParts.push(`\n## Available Tools\n${tools.summary()}`);
            }

            const messages: LLMMessage[] = [
              { role: "system", content: systemParts.join("\n\n") },
              { role: "user", content: payload },
            ];

            try {
              if (useToolLoop) {
                // Tool-use loop — agent can call tools and iterate
                const result = await toolUseLoop(
                  this._deps.provider,
                  messages,
                  tools,
                  {
                    ...opts,
                    maxIterations: agentCfg.maxTokens ? undefined : 10,
                    onToolCall: (name, input, resultStr) => {
                      console.log(`    [${id}] tool: ${name}(${Object.values(input).map((v) => String(v).slice(0, 40)).join(", ")})`);
                    },
                  },
                );

                // Track tokens
                if (this._deps.tokenTracker && result.tokens) {
                  this._deps.tokenTracker.record({
                    provider: this._deps.provider.id,
                    model: result.model,
                    agentId: id,
                    tokens: result.tokens,
                  });
                }

                return result.content;
              } else {
                // Simple one-shot completion (no tools)
                const result = await complete(messages, opts);
                return result.content;
              }
            } catch (err) {
              return `[${id}] Error: ${(err as Error).message}`;
            }
          },
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Provider helpers
  // ---------------------------------------------------------------------------

  private _trackedComplete(agentId: string) {
    const { provider, tokenTracker } = this._deps;
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
  return {
    value: { destination: route.dest, contextSlice: route.layers, priority: 5 },
    confidence: 0.8,
    reasoning: `rule: ${classification.category} → ${route.dest}`,
  };
}

// ---------------------------------------------------------------------------
// Config → CompletionOpts resolver
// ---------------------------------------------------------------------------

/**
 * Resolve canonical agent config into CompletionOpts.
 *
 * This is the adapter layer: AgentSettingsConfig holds the canonical knobs,
 * this function maps them into the provider-agnostic CompletionOpts that
 * each provider then translates into its native API.
 *
 * Per-kind defaults:
 * - classifier/router: tools=false, low maxTokens, no thinking
 * - executor: tools=true, higher maxTokens, thinking from config
 */
export function resolveAgentOpts(
  agentCfg: AgentSettingsConfig,
  config: FoundryConfig,
): CompletionOpts {
  const isLightweight = agentCfg.kind === "classifier" || agentCfg.kind === "router";

  return {
    model: agentCfg.model || (isLightweight ? "gemini-3.1-flash-lite-preview" : config.defaults.model),
    temperature: agentCfg.temperature ?? 0,
    maxTokens: agentCfg.maxTokens ?? (isLightweight ? 256 : 4096),
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
