import { describe, test, expect } from "bun:test";
import { BunScript } from "../src/tools/bun-script";

const script = new BunScript({ timeout: 10_000 });

describe("BunScript", () => {
  test("has correct metadata", () => {
    expect(script.id).toBe("script");
    expect(script.kind).toBe("script");
    expect(script.capability).toBe("exec:process");
  });

  test("evaluates simple expression", async () => {
    const result = await script.evaluate("return 2 + 2");
    expect(result.ok).toBe(true);
    expect(result.data?.result).toBe(4);
    expect(result.data?.durationMs).toBeGreaterThan(0);
  });

  test("evaluates string result", async () => {
    const result = await script.evaluate('return "hello world"');
    expect(result.ok).toBe(true);
    expect(result.data?.result).toBe("hello world");
  });

  test("evaluates object result", async () => {
    const result = await script.evaluate('return { name: "foundry", version: 1 }');
    expect(result.ok).toBe(true);
    expect(result.data?.result).toEqual({ name: "foundry", version: 1 });
  });

  test("evaluates async code", async () => {
    const result = await script.evaluate("return await Promise.resolve(42)");
    expect(result.ok).toBe(true);
    expect(result.data?.result).toBe(42);
  });

  test("captures console.log", async () => {
    const result = await script.evaluate(`
      console.log("log line 1");
      console.log("log line 2");
      return "done";
    `);
    expect(result.ok).toBe(true);
    expect(result.data?.logs).toContain("log line 1");
    expect(result.data?.logs).toContain("log line 2");
    expect(result.data?.result).toBe("done");
  });

  test("injects modules", async () => {
    const result = await script.evaluate(
      'return JSON.parse(globalThis["data"]).value',
      { modules: { data: JSON.stringify({ value: 99 }) } },
    );
    expect(result.ok).toBe(true);
    expect(result.data?.result).toBe(99);
  });

  test("returns error for failing code", async () => {
    const result = await script.evaluate("throw new Error('boom')");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
  });

  test("returns error for syntax errors", async () => {
    const result = await script.evaluate("return {{invalid}}");
    expect(result.ok).toBe(false);
  });

  test("times out on long-running code", async () => {
    const result = await script.evaluate(
      "await new Promise(r => setTimeout(r, 60000)); return 1",
      { timeout: 500 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
  }, 10_000);

  test("does not leak API keys to subprocess", async () => {
    const result = await script.evaluate(`
      return {
        anthropic: process.env.ANTHROPIC_API_KEY ?? "unset",
        openai: process.env.OPENAI_API_KEY ?? "unset",
        google: process.env.GOOGLE_API_KEY ?? "unset",
      };
    `);
    expect(result.ok).toBe(true);
    expect(result.data?.result).toEqual({
      anthropic: "unset",
      openai: "unset",
      google: "unset",
    });
  });

  test("custom id", () => {
    const custom = new BunScript({ id: "my-script" });
    expect(custom.id).toBe("my-script");
  });

  test("summary includes duration", async () => {
    const result = await script.evaluate("return 1");
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("ms");
  });

  test("handles array results", async () => {
    const result = await script.evaluate("return [1, 2, 3].filter(n => n > 1)");
    expect(result.ok).toBe(true);
    expect(result.data?.result).toEqual([2, 3]);
  });

  test("handles null/undefined return", async () => {
    const result = await script.evaluate("return null");
    expect(result.ok).toBe(true);
    expect(result.data?.result).toBeNull();
  });
});
