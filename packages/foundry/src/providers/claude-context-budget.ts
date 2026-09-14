/** Claude's native auto-compaction policy, independent of cumulative spend
 * and Foundry's per-layer caches. This is a target window, not request admission.
 */
export interface ClaudeContextBudget {
  /** Effective native compaction window. Default 200,000; native range 100k–1M. */
  maxTokens?: number;
  /** Fraction of the window at which to compact. Default 0.8 (~160k). */
  compactAt?: number;
}

export function claudeContextEnvironment(
  env: Record<string, string | undefined>,
  budget: ClaudeContextBudget | false = {},
): Record<string, string | undefined> {
  if (budget === false) return { ...env };
  const maxTokens = budget.maxTokens ?? 200_000;
  const compactAt = budget.compactAt ?? 0.8;
  if (!Number.isInteger(maxTokens) || maxTokens < 100_000 || maxTokens > 1_000_000) {
    throw new Error("Claude contextBudget.maxTokens must be an integer between 100000 and 1000000");
  }
  if (!Number.isFinite(compactAt) || compactAt < 0.01 || compactAt >= 1) {
    throw new Error("Claude contextBudget.compactAt must be >= 0.01 and < 1 to leave compaction headroom");
  }
  const result: Record<string, string | undefined> = {
    ...env,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(maxTokens),
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(compactAt * 100),
  };
  // An enabled Foundry policy must not be silently disabled by inherited env.
  delete result.DISABLE_AUTO_COMPACT;
  delete result.DISABLE_COMPACT;
  delete result.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT;
  return result;
}
