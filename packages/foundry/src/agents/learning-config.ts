import type { CompletionOpts, LLMProvider } from "@inixiative/foundry-core";
import type { LearningConfig } from "./thread-runtime";

/** Background review only. Interactive agent settings keep their existing precedence. */
export interface LearningSettings {
  /** Disable new post-work knowledge reviews; advice and guards still run. */
  enabled?: boolean;
  softTimeoutMs?: number;
  hardTimeoutMs?: number;
  maxKnowledgeChars?: number;
  review?: { provider?: string; model?: string; maxTokens?: number; thinking?: CompletionOpts["thinking"] };
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error("Learning settings must be plain objects");
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw Error(`Unknown learning setting: ${key}`);
  return value as Record<string, unknown>;
}
export function validateLearningSettings(value: unknown): asserts value is LearningSettings | undefined {
  if (value === undefined) return;
  const settings = object(value, ["enabled", "softTimeoutMs", "hardTimeoutMs", "maxKnowledgeChars", "review"]);
  if (settings.enabled !== undefined && typeof settings.enabled !== "boolean") throw Error("Invalid learning enabled");
  for (const [key, max] of [["softTimeoutMs", 300_000], ["hardTimeoutMs", 300_000], ["maxKnowledgeChars", 4_000]] as const) {
    const n = settings[key];
    if (n !== undefined && (!Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > max)) throw Error(`Invalid learning ${key}`);
  }
  if ((settings.softTimeoutMs ?? 10_000) as number > ((settings.hardTimeoutMs ?? 60_000) as number)) throw Error("Learning soft deadline exceeds hard deadline");
  if (settings.review !== undefined) {
    const review = object(settings.review, ["provider", "model", "maxTokens", "thinking"]);
    for (const key of ["provider", "model"]) if (review[key] !== undefined && (typeof review[key] !== "string" || !(review[key] as string).trim() || (review[key] as string).length > 200)) throw Error(`Invalid review ${key}`);
    if (review.maxTokens !== undefined && (!Number.isSafeInteger(review.maxTokens) || (review.maxTokens as number) < 1 || (review.maxTokens as number) > 100_000)) throw Error("Invalid review maxTokens");
    if (review.thinking !== undefined && !["none", "low", "medium", "high"].includes(String(review.thinking))
      && !(typeof review.thinking === "number" && Number.isSafeInteger(review.thinking) && review.thinking > 0 && review.thinking <= 100_000)) throw Error("Invalid review thinking");
  }
}

/** Resolve against already constructed providers. Never create an adapter or silently fall back for an explicit provider. */
export function resolveLearningSettings(settings: LearningSettings | undefined, providers: ReadonlyMap<string, LLMProvider>, fallback: LLMProvider, fallbackModel?: string): LearningConfig {
  validateLearningSettings(settings);
  const provider = settings?.review?.provider === undefined ? fallback : providers.get(settings.review.provider);
  if (!provider) throw Error(`Requested review provider is unavailable: ${settings?.review?.provider}`);
  return { enabled: settings?.enabled, timeoutMs: settings?.softTimeoutMs, hardTimeoutMs: settings?.hardTimeoutMs, maxKnowledgeChars: settings?.maxKnowledgeChars,
    reviewProvider: provider, reviewOpts: { model: settings?.review?.model ?? (provider === fallback ? fallbackModel : undefined),
      maxTokens: settings?.review?.maxTokens ?? 1600, ...(settings?.review?.thinking !== undefined ? { thinking: settings.review.thinking } : {}) } };
}
