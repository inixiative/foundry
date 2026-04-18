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
  const layers: ContextLayer[] = [];

  for (const [id, layerCfg] of Object.entries(config.layers)) {
    if (!layerCfg.enabled) continue;

    const sources = (layerCfg.sourceIds ?? [])
      .map((srcId) => deps.sourceResolver(srcId, config))
      .filter(Boolean) as ContextSource[];

    layers.push(
      new ContextLayer({
        id,
        trust: layerCfg.trust * 10, // Config uses 0-1, ContextLayer uses 0-10
        staleness: layerCfg.staleness || undefined,
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

export interface BuildAgentsDeps {
  provider: LLMProvider;
  tokenTracker?: TokenTracker;
  tools?: ToolRegistry;
}

/**
 * Build agent instances from project config.
 * Called once at project startup — agents are shared across all threads.
 */
export function buildAgents(
  config: FoundryConfig,
  stack: ContextStack,
  deps: BuildAgentsDeps,
): Map<string, BaseAgent> {
  const agents = new Map<string, BaseAgent>();

  for (const [id, agentCfg] of Object.entries(config.agents)) {
    if (!agentCfg.enabled) continue;
    const agent = buildAgent(id, agentCfg, config, stack, deps);
    if (agent) agents.set(id, agent);
  }

  return agents;
}

// ---------------------------------------------------------------------------
// ThreadFactory — lightweight thread creation from shared project state
// ---------------------------------------------------------------------------

export interface ThreadFactoryDeps {
  /** Shared project stack (layers built once, shared across threads). */
  stack: ContextStack;
  /** Shared project agents (built once, registered on each thread). */
  agents: Map<string, BaseAgent>;
}

/**
 * Factory that creates Thread instances from shared project state.
 *
 * Layers and agents are project-scoped — built once, shared across threads.
 * ThreadFactory just wraps them in a new Thread handle. The only per-thread
 * state is the Librarian's `thread-state` layer, created separately.
 */
export class ThreadFactory {
  private _stack: ContextStack;
  private _agents: Map<string, BaseAgent>;

  constructor(deps: ThreadFactoryDeps) {
    this._stack = deps.stack;
    this._agents = deps.agents;
  }

  /**
   * Create a Thread that shares the project's stack and agents.
   */
  create(
    id: string,
    opts?: ThreadConfig,
  ): Thread {
    const thread = new Thread(id, this._stack, opts);

    for (const agent of this._agents.values()) {
      thread.register(agent);
    }

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
              { ...opts, maxTokens: 256, maxTurns: 1 },
            );
            const parsed = parseJSON(result.content);
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
        handler: async (ctx, input) => {
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
              { ...opts, maxTokens: 256, maxTurns: 1 },
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
            console.warn(`[buildAgent] LLM route failed, falling back to keyword:`, (err as Error).message);
            return keywordRoute(classification, config);
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

          try {
            if (useToolLoop) {
              const result = await toolUseLoop(
                deps.provider,
                messages,
                tools,
                {
                  ...opts,
                  toolCwd: meta?.cwd,
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
            } else {
              const result = await complete(messages, { ...opts, cwd: meta?.cwd });
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
    model: agentCfg.model || (isLightweight ? "gemini-3.1-flash-lite-preview" : config.defaults.model),
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
