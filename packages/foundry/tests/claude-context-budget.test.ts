import { describe, expect, test } from "bun:test";
import { claudeContextEnvironment } from "../src/providers/claude-context-budget";
import { ClaudeCodeProvider } from "../src/providers/claude-code";

describe("Claude native context budget", () => {
  test("defaults to a 200k window and 80% native trigger, overriding inherited disabling flags", () => {
    const env = { PATH: "/test/bin", CLAUDE_CODE_OAUTH_TOKEN: "test-token", DISABLE_COMPACT: "1", DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000", CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1" };
    expect(claudeContextEnvironment(env)).toEqual({ PATH: "/test/bin", CLAUDE_CODE_OAUTH_TOKEN: "test-token", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80" });
    expect(env.DISABLE_COMPACT).toBe("1");
    expect(claudeContextEnvironment(env, false)).toEqual(env);
  });

  test("supports configured headroom and rejects invalid policies before spawning", () => {
    expect(claudeContextEnvironment({}, { maxTokens: 150000, compactAt: 0.7 })).toMatchObject({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "150000", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "70" });
    for (const maxTokens of [0, 99999, 1000001, 200000.5, NaN, Infinity]) {
      expect(() => new ClaudeCodeProvider({ contextBudget: { maxTokens } })).toThrow("maxTokens");
    }
    for (const compactAt of [0, 1, -1, NaN, Infinity]) {
      expect(() => new ClaudeCodeProvider({ contextBudget: { compactAt } })).toThrow("compactAt");
    }
  });
});
