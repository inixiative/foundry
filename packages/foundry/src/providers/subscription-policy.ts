import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AgentSettingsConfig, AgentSettingsOverride, FoundryConfig } from "../viewer/config";
import { resolveProjectView } from "../viewer/config-resolve";
import { assertPrivateProfile, assertProfile } from "./private-profile";
import { DECISION_MODEL } from "./decision-provider";
import { defaultProfileSource, type NativeProfileSource } from "./default-profiles";

export const SUBSCRIPTION_DECISIONS = "subscription-decisions";
const model = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/);
/** Optional overrides of subscription mode. Every field has a default. */
export const subscriptionSettingsSchema = z.object({
  decisionSourceId: z.string().uuid().optional(), model: model.optional(), expectedObservedModel: model.optional(),
  directory: z.string().startsWith("/").optional(), maxCalls: z.number().int().min(1).max(10_000).optional(),
  maxQueued: z.number().int().min(1).max(128).optional(), callTimeoutMs: z.number().int().min(100).max(30_000).optional(),
}).strict();
export type SubscriptionSettings = z.infer<typeof subscriptionSettingsSchema>;
export interface SubscriptionPolicy {
  model: string; expectedObservedModel?: string; directory: string; maxCalls: number; maxQueued: number; callTimeoutMs: number;
}
export const SUBSCRIPTION_DEFAULTS = { maxCalls: 1_000, maxQueued: 8, callTimeoutMs: 30_000 } as const;

export interface SubscriptionResolution {
  policy: SubscriptionPolicy;
  worker: NativeProfileSource;
  decision: NativeProfileSource;
  /** Effective configuration: every enabled decision role runs on the subscription decision profile. */
  config: FoundryConfig;
  /** Decision roles whose saved provider/model differed from the subscription decision profile. */
  rerouted: string[];
}

/**
 * Subscription-only is the default. `apiTokens: true` is the only way to construct API
 * providers. Without it the Claude worker and the decision profile (Codex by default)
 * both use subscription logins, referenced in place, with no paid fallback.
 *
 * `startup` also checks the default login locations and prepares the default receipt
 * directory; configuration saves validate structure and explicit profiles only.
 */
export function resolveSubscriptionPolicy(config: FoundryConfig, options: { startup?: boolean; cwd?: string } = {}): SubscriptionResolution | undefined {
  if (config.apiTokens !== undefined && typeof config.apiTokens !== "boolean") throw Error("apiTokens must be true or false");
  if (config.apiTokens) {
    if (config.subscriptionOnly !== undefined) throw Error("apiTokens and subscriptionOnly are exclusive; remove one of them");
    return undefined;
  }
  const settings = subscriptionSettingsSchema.parse(config.subscriptionOnly ?? {});
  if (config.kastles?.length || config.defaults.kastleId || Object.keys(config.kastleAssignments ?? {}).length
    || Object.keys(config.nativeAuthenticationSelections ?? {}).length)
    throw Error("Subscription-only startup requires fixed native profile selections, without gateway or per-thread overrides; set apiTokens: true for other sources");
  const explicit = (id: string) => {
    const found = config.nativeAuthentication?.find(item => item.id === id);
    if (!found || found.mode !== "native-profile") throw Error("Subscription-only execution requires native profile sources");
    assertProfile(found.profileDirectory, found.runtime);
    return found;
  };
  const worker = config.defaults.nativeAuthenticationId ? explicit(config.defaults.nativeAuthenticationId) : defaultProfileSource("claude");
  if (worker.runtime !== "claude") throw Error("The subscription worker runs on a Claude profile");
  const decision = settings.decisionSourceId ? explicit(settings.decisionSourceId) : defaultProfileSource("codex");
  if (decision.runtime === "claude" && !settings.model) throw Error("A Claude decision profile requires an explicit subscriptionOnly.model");
  if (decision.runtime === "codex" && settings.expectedObservedModel !== undefined && settings.expectedObservedModel !== settings.model)
    throw Error("Codex decisions cannot acknowledge a different observed model");
  const policy: SubscriptionPolicy = {
    // The setup wizard records a Codex decision model as the subscription classifier default.
    model: settings.model ?? (decision.runtime === "codex" && config.defaults.classifierProvider === SUBSCRIPTION_DECISIONS
      ? config.defaults.classifierModel : undefined) ?? DECISION_MODEL,
    ...(settings.expectedObservedModel ? { expectedObservedModel: settings.expectedObservedModel } : {}),
    directory: settings.directory ?? join(options.cwd ?? process.cwd(), ".foundry", "decision-receipts"),
    maxCalls: settings.maxCalls ?? SUBSCRIPTION_DEFAULTS.maxCalls,
    maxQueued: settings.maxQueued ?? SUBSCRIPTION_DEFAULTS.maxQueued,
    callTimeoutMs: settings.callTimeoutMs ?? SUBSCRIPTION_DEFAULTS.callTimeoutMs,
  };
  if (options.startup) {
    for (const source of [worker, decision]) {
      try { assertProfile(source.profileDirectory, source.runtime); }
      catch (error) { throw Error(`${source.runtime} subscription profile unavailable at ${source.profileDirectory}: ${(error as Error).message}`); }
    }
    if (!settings.directory) mkdirSync(policy.directory, { recursive: true, mode: 0o700 });
  }
  if (options.startup || settings.directory) assertPrivateProfile(policy.directory);
  const canonical = (path: string) => { try { return realpathSync(path); } catch { return path; } };
  if (canonical(worker.profileDirectory) === canonical(decision.profileDirectory))
    throw Error("Subscription decisions require a separate private profile from the warm worker");

  const { config: effective, rerouted } = routeDecisions(config, policy.model);
  const check = (view: FoundryConfig) => {
    if (view.defaults.provider !== "claude-code")
      throw Error(`Subscription-only mode runs the worker on claude-code; set apiTokens: true to use ${view.defaults.provider}`);
    if (view.defaults.model !== config.defaults.model || view.defaults.nativeAuthenticationId !== config.defaults.nativeAuthenticationId
      || view.defaults.kastleId || view.defaults.classifierProvider !== SUBSCRIPTION_DECISIONS || view.defaults.classifierModel !== policy.model)
      throw Error("Subscription-only defaults require the Claude worker and subscription decision model");
    model.parse(view.defaults.model);
    for (const agent of Object.values(view.agents)) {
      if (!agent.enabled) continue;
      const central = agent.kind === "executor";
      if ((agent.provider ?? view.defaults.provider) !== (central ? "claude-code" : SUBSCRIPTION_DECISIONS)
        || (agent.model ?? (central ? view.defaults.model : undefined)) !== (central ? config.defaults.model : policy.model)
        || (!central && agent.tools === true)) throw Error("Subscription-only agent provider, model or tool override refused");
      if (!central && (agent.thinking !== undefined && agent.thinking !== "none" || agent.cacheControl !== undefined || (agent.temperature !== undefined && agent.temperature !== 0)))
        throw Error("Subscription decision sampling override cannot be enforced");
    }
    const review = view.learning?.review;
    if (review && ((review.provider !== undefined && review.provider !== SUBSCRIPTION_DECISIONS)
      || (review.model !== undefined && review.model !== policy.model) || review.thinking !== undefined))
      throw Error("Subscription-only review override refused");
  };
  check(effective);
  for (const id of Object.keys(effective.projects)) check(resolveProjectView(effective, id)!.config);
  return structuredClone({ policy, worker, decision, config: effective, rerouted });
}

/** Decision roles (every enabled non-executor agent) run on the subscription decision profile.
 * Explicit sampling, tool and review overrides are still refused by the policy check. */
function routeDecisions(config: FoundryConfig, decisionModel: string): { config: FoundryConfig; rerouted: string[] } {
  const effective = structuredClone(config), rerouted: string[] = [];
  const route = (scope: string, id: string, agent: Pick<AgentSettingsOverride, "kind" | "enabled" | "provider" | "model">, inherited?: AgentSettingsConfig) => {
    if ((agent.kind ?? inherited?.kind) === "executor" || (agent.enabled ?? inherited?.enabled) === false) return;
    if (inherited && agent.provider === undefined && agent.model === undefined) return;
    if (agent.provider === SUBSCRIPTION_DECISIONS && agent.model === decisionModel) return;
    rerouted.push(`${scope}${id} (${agent.provider ?? inherited?.provider ?? "default"}/${agent.model ?? inherited?.model ?? "default"})`);
    agent.provider = SUBSCRIPTION_DECISIONS; agent.model = decisionModel;
  };
  effective.defaults = { ...effective.defaults, classifierProvider: SUBSCRIPTION_DECISIONS, classifierModel: decisionModel };
  for (const [id, agent] of Object.entries(effective.agents)) route("", id, agent);
  for (const [projectId, project] of Object.entries(effective.projects)) {
    if (project.defaults && ("classifierProvider" in project.defaults || "classifierModel" in project.defaults))
      project.defaults = { ...project.defaults, classifierProvider: SUBSCRIPTION_DECISIONS, classifierModel: decisionModel };
    for (const [id, agent] of Object.entries(project.agents ?? {})) route(`${projectId}/`, id, agent, config.agents[id]);
  }
  return { config: effective, rerouted };
}
