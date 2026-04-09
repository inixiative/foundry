import { describe, test, expect } from "bun:test";
import { AnthropicProvider } from "../src/providers/anthropic";
import { OpenAIProvider } from "../src/providers/openai";
import { GeminiProvider } from "../src/providers/gemini";
import type { LLMStreamEvent } from "@inixiative/foundry-core";
import { estimateTokens } from "@inixiative/foundry-core";

// ---------------------------------------------------------------------------
// Provider stream method existence
// ---------------------------------------------------------------------------

describe("AnthropicProvider", () => {
  test("has stream method", () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    expect(typeof provider.stream).toBe("function");
  });

  test("stream method is an async generator function", () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    // AsyncGeneratorFunction has a specific constructor name
    const result = provider.stream([{ role: "user", content: "hi" }]);
    expect(typeof result[Symbol.asyncIterator]).toBe("function");
  });

  test("stream accepts same params as complete", () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    // Both methods exist and accept messages + opts
    expect(provider.stream.length).toBeLessThanOrEqual(
      provider.complete.length
    );
  });
});

describe("OpenAIProvider", () => {
  test("has stream method", () => {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    expect(typeof provider.stream).toBe("function");
  });

  test("stream method returns async iterable", () => {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    const result = provider.stream([{ role: "user", content: "hi" }]);
    expect(typeof result[Symbol.asyncIterator]).toBe("function");
  });

  test("stream accepts same params as complete", () => {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    expect(provider.stream.length).toBeLessThanOrEqual(
      provider.complete.length
    );
  });
});

describe("GeminiProvider", () => {
  test("has stream method", () => {
    const provider = new GeminiProvider({ apiKey: "test-key" });
    expect(typeof provider.stream).toBe("function");
  });

  test("stream method returns async iterable", () => {
    const provider = new GeminiProvider({ apiKey: "test-key" });
    const result = provider.stream([{ role: "user", content: "hi" }]);
    expect(typeof result[Symbol.asyncIterator]).toBe("function");
  });

  test("stream accepts same params as complete", () => {
    const provider = new GeminiProvider({ apiKey: "test-key" });
    expect(provider.stream.length).toBeLessThanOrEqual(
      provider.complete.length
    );
  });
});

// ---------------------------------------------------------------------------
// LLMStreamEvent type structure
// ---------------------------------------------------------------------------

describe("LLMStreamEvent type structure", () => {
  test("text event has correct shape", () => {
    const event: LLMStreamEvent = { type: "text", text: "hello" };
    expect(event.type).toBe("text");
    expect(event.text).toBe("hello");
  });

  test("usage event has correct shape", () => {
    const event: LLMStreamEvent = {
      type: "usage",
      tokens: { input: 100, output: 50 },
    };
    expect(event.type).toBe("usage");
    expect(event.tokens).toEqual({ input: 100, output: 50 });
  });

  test("done event has correct shape", () => {
    const event: LLMStreamEvent = {
      type: "done",
      finishReason: "end_turn",
    };
    expect(event.type).toBe("done");
    expect(event.finishReason).toBe("end_turn");
  });

  test("error event has correct shape", () => {
    const event: LLMStreamEvent = {
      type: "error",
      error: "Connection failed",
    };
    expect(event.type).toBe("error");
    expect(event.error).toBe("Connection failed");
  });
});

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  test("empty string returns 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("whitespace-only string returns 0", () => {
    expect(estimateTokens("   \n\t  ")).toBe(0);
  });

  test("code detection — text with code signals uses character-based estimation", () => {
    const code = `
      import { foo } from './bar';
      export function hello() {
        const x = 42;
        return x;
      }
    `;
    const tokens = estimateTokens(code);
    // Code uses ~0.4 tokens per character
    expect(tokens).toBeGreaterThan(0);
    // Should be roughly 0.4 * trimmed length
    const expected = Math.ceil(code.trim().length * 0.4);
    expect(tokens).toBe(expected);
  });

  test("prose — normal English text uses word-based estimation", () => {
    const prose =
      "The quick brown fox jumps over the lazy dog near the riverbank";
    const tokens = estimateTokens(prose);
    // Prose uses ~0.75 tokens per word
    const wordCount = prose.trim().split(/\s+/).length;
    const expected = Math.ceil(wordCount * 0.75);
    expect(tokens).toBe(expected);
    expect(tokens).toBeGreaterThan(0);
  });

  test("mixed content — code + prose", () => {
    // If the sample contains code signals, it gets treated as code
    const mixed = `
      This is a description of the module.
      import { something } from 'somewhere';
      function doStuff() { return true; }
    `;
    const tokens = estimateTokens(mixed);
    expect(tokens).toBeGreaterThan(0);
    // Since code signals are present, it should use the code path (0.4 * chars)
    const expected = Math.ceil(mixed.trim().length * 0.4);
    expect(tokens).toBe(expected);
  });

  test("single word returns at least 1", () => {
    expect(estimateTokens("hello")).toBeGreaterThanOrEqual(1);
  });

  test("model parameter is accepted but does not change basic behavior", () => {
    const text = "A simple sentence for testing token estimation.";
    const tokensDefault = estimateTokens(text);
    const tokensWithModel = estimateTokens(text, "gpt-4o");
    expect(tokensDefault).toBe(tokensWithModel);
  });
});
