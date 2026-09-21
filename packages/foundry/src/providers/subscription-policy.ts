import { realpathSync } from "node:fs";
import { z } from "zod";
import type { FoundryConfig } from "../viewer/config";
import { resolveProjectView } from "../viewer/config-resolve";
import { assertPrivateProfile } from "./private-profile";

const model = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/);
export const subscriptionPolicySchema = z.object({
  decisionSourceId: z.string().uuid(), model, expectedObservedModel: model,
  directory: z.string().startsWith("/"), maxCalls: z.number().int().min(1).max(10_000),
  maxQueued: z.number().int().min(1).max(128), callTimeoutMs: z.number().int().min(100).max(30_000),
}).strict();
export type SubscriptionPolicy = z.infer<typeof subscriptionPolicySchema>;

export function resolveSubscriptionPolicy(config: FoundryConfig) {
  if (config.subscriptionOnly === undefined) return undefined;
  const policy = subscriptionPolicySchema.parse(config.subscriptionOnly);
  const source = (id: string | undefined) => {
    const found = config.nativeAuthentication?.find(item => item.id === id);
    if (!found || found.runtime !== "claude" || found.mode !== "native-profile") throw Error("Subscription-only execution requires explicit Claude native profiles");
    assertPrivateProfile(found.profileDirectory);
    return found;
  };
  if (config.kastles?.length || config.defaults.kastleId || Object.keys(config.kastleAssignments ?? {}).length
    || Object.keys(config.nativeAuthenticationSelections ?? {}).length)
    throw Error("Subscription-only startup requires fixed native profile selections, without gateway or per-thread overrides");
  const worker = source(config.defaults.nativeAuthenticationId), decision = source(policy.decisionSourceId);
  if (realpathSync(worker.profileDirectory) === realpathSync(decision.profileDirectory))
    throw Error("Subscription decisions require a separate private profile from the warm worker");
  assertPrivateProfile(policy.directory);
  const check = (view: FoundryConfig) => {
    if (view.defaults.model !== config.defaults.model || view.defaults.provider !== "claude-code" || view.defaults.nativeAuthenticationId !== worker.id
      || view.defaults.kastleId || view.defaults.classifierProvider !== "subscription-decisions"
      || view.defaults.classifierModel !== policy.model)
      throw Error("Subscription-only defaults require the explicit Claude worker and subscription decision model");
    model.parse(view.defaults.model);
    for (const agent of Object.values(view.agents)) {
      if (!agent.enabled) continue;
      const central = agent.kind === "executor";
      if ((agent.provider ?? view.defaults.provider) !== (central ? "claude-code" : "subscription-decisions")
        || (agent.model ?? (central ? view.defaults.model : undefined)) !== (central ? config.defaults.model : policy.model)
        || (!central && agent.tools === true)) throw Error("Subscription-only agent provider, model or tool override refused");
      if (!central && (agent.thinking !== undefined && agent.thinking !== "none" || agent.cacheControl !== undefined || (agent.temperature !== undefined && agent.temperature !== 0)))
        throw Error("Subscription decision sampling override cannot be enforced");
    }
    const review = view.learning?.review;
    if (review && ((review.provider !== undefined && review.provider !== "subscription-decisions")
      || (review.model !== undefined && review.model !== policy.model) || review.thinking !== undefined))
      throw Error("Subscription-only review override refused");
  };
  check(config);
  for (const id of Object.keys(config.projects)) check(resolveProjectView(config, id)!.config);
  return structuredClone({ policy, worker, decision });
}
