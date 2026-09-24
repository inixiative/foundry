import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNativeTextProvider, type NativeTextConfig } from "../src/providers/native-text-provider";

const roots: string[] = [];
afterEach(async () => { await new Promise(r => setTimeout(r, 10)); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function config(): NativeTextConfig {
  const directory = mkdtempSync(join(tmpdir(), "native-text-controlled-")); roots.push(directory);
  const profileDirectory = join(directory, "profile"); mkdirSync(profileDirectory, { mode: 0o700 });
  return { directory, source: { id: crypto.randomUUID(), connectionId: crypto.randomUUID(), runtime: "claude", mode: "native-profile", profileDirectory },
    runId: crypto.randomUUID(), model: "synthetic-model", maxCalls: 2, callTimeoutMs: 500 };
}
function statusProcess(valid = true, stalled = false) {
  let resolve!: (code: number) => void;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const exited = new Promise<number>(r => { resolve = r; });
  const stdout = new ReadableStream<Uint8Array>({ start(c) {
    controller = c;
    if (!stalled) { c.enqueue(new TextEncoder().encode(JSON.stringify({ loggedIn: valid, authMethod: valid ? "claude.ai" : "api_key" }))); c.close(); resolve(0); }
  } });
  return { stdout, stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), exited,
    kill() { try { controller.close(); } catch {} resolve(143); } };
}
function transport(mode: "ok" | "stall" | "tool" = "ok", observedModel: string | null = "synthetic-model") {
  const launches: { argv: string[]; env: Record<string, string | undefined> }[] = [];
  let writes = 0, kills = 0;
  return { launches, get writes() { return writes; }, get kills() { return kills; },
    spawn: (argv: string[], options: { cwd: string; env: Record<string, string | undefined> }) => {
      launches.push({ argv, env: options.env });
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stdout = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
      const stderr = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
      let resolve!: (code: number) => void;
      const exited = new Promise<number>(r => { resolve = r; });
      const emit = (event: unknown) => controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n"));
      return { stdout, stderr, exited, stdin: {
        write() {
          writes++;
          if (mode === "stall") return;
          queueMicrotask(() => {
            emit({ type: "system", subtype: "init", session_id: "synthetic-session", ...(observedModel ? { model: observedModel } : {}) });
            if (mode === "tool") emit({ type: "assistant", session_id: "synthetic-session", message: { role: "assistant", content: [{ type: "tool_use", id: "tool", name: "Bash", input: { command: "synthetic" } }] } });
            else emit({ type: "result", subtype: "success", is_error: false, result: "synthetic-output", session_id: "synthetic-session", usage: { input_tokens: 1, output_tokens: 1 } });
          });
        }, flush() {}, end() {},
      }, kill() { kills++; try { controller.close(); } catch {} resolve(143); } };
    }, statusSpawn: () => statusProcess(),
  };
}

test("shared adapter enforces text-only flags and records settled release with call cap", async () => {
  const cfg = config(), t = transport(), run = buildNativeTextProvider(cfg, t);
  const result = await run.provider.complete([{ role: "user", content: "synthetic-private-prompt" }]);
  expect(result.content).toBe("synthetic-output");
  expect(run.snapshot().calls[0].valid).toBe(true);
  expect(run.snapshot().calls[0].release).toBe("released");
  expect(run.snapshot().calls[0].processExit).toBe("exited");
  expect(t.launches[0].argv).toContain("--safe-mode");
  expect(t.launches[0].argv.slice(t.launches[0].argv.indexOf("--tools"), t.launches[0].argv.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
  expect(t.launches[0].argv).toContain("--strict-mcp-config");
  expect(t.launches[0].argv).toContain("--disable-slash-commands");
  expect(t.launches[0].argv).toContain("--no-chrome");
  expect(t.launches[0].env.CLAUDE_CONFIG_DIR).toBe(realpathSync(cfg.source.profileDirectory));
  expect(existsSync(join(cfg.source.profileDirectory, ".foundry-auth-lock"))).toBe(false);
  const report = readFileSync(run.reportPath, "utf8");
  expect(report).not.toContain("synthetic-private-prompt");
  expect(report).not.toContain("synthetic-output");
  expect(JSON.parse(report).mode).toBe("controlled-transport");
  await run.provider.complete([{ role: "user", content: "second" }]);
  await expect(run.provider.complete([{ role: "user", content: "third" }])).rejects.toThrow("admission");
  expect(t.writes).toBe(2);
});

test("unavailable subscription refuses native launch", async () => {
  const t = transport(), run = buildNativeTextProvider(config(), { ...t, statusSpawn: () => statusProcess(false) });
  await expect(run.provider.complete([{ role: "user", content: "test" }])).rejects.toThrow("failed");
  expect(t.launches).toHaveLength(0);
  expect(run.snapshot().closed).toBe(true);
});

test("deadline retains failure and blocks additional admission", async () => {
  const cfg = { ...config(), callTimeoutMs: 100 }, t = transport("stall"), run = buildNativeTextProvider(cfg, t);
  await expect(run.provider.complete([{ role: "user", content: "test" }])).rejects.toThrow("failed");
  expect(run.snapshot().calls[0].deadline).toBe(true);
  expect(run.snapshot().calls[0].valid).toBe(false);
  expect(t.kills).toBeGreaterThan(0);
  await expect(run.provider.complete([{ role: "user", content: "again" }])).rejects.toThrow("admission");
});

test("tool evidence closes the supposedly text-only run", async () => {
  const run = buildNativeTextProvider(config(), transport("tool"));
  await expect(run.provider.complete([{ role: "user", content: "test" }])).rejects.toThrow("failed");
  expect(run.snapshot().closed).toBe(true);
  expect(run.snapshot().calls[0].valid).toBe(false);
});

test("caller registration failure prevents the native work write", async () => {
  const t = transport(), run = buildNativeTextProvider(config(), t);
  await expect(run.provider.complete([{ role: "user", content: "test" }], {
    nativeObservation: { owner: { threadId: "caller", generation: "g", dispatchId: "d" },
      register() { throw Error("synthetic-durable-write-failed"); }, observe() {} },
  })).rejects.toThrow("failed");
  expect(t.writes).toBe(0);
  expect(run.snapshot().closed).toBe(true);
});

test("scope and oversized input fail before spawning or consuming a call", async () => {
  const t = transport(), run = buildNativeTextProvider(config(), t);
  await expect(run.provider.complete([{ role: "user", content: "test" }], { tools: true })).rejects.toThrow("scope");
  await expect(run.provider.complete([{ role: "user", content: "test" }], { model: "other" })).rejects.toThrow("scope");
  await expect(run.provider.complete([{ role: "user", content: "x".repeat(100_001) }])).rejects.toThrow("input cap");
  expect(t.launches).toHaveLength(0);
  expect(run.snapshot().calls).toHaveLength(0);
});

test("concurrent admission is refused without starting a second model", async () => {
  const t = transport("stall"), run = buildNativeTextProvider({ ...config(), callTimeoutMs: 100 }, t);
  const first = run.provider.complete([{ role: "user", content: "one" }]);
  await expect(run.provider.complete([{ role: "user", content: "two" }])).rejects.toThrow("occupied");
  await expect(first).rejects.toThrow("failed");
  expect(t.launches).toHaveLength(1);
});


test("deadline owns and settles a stalled status process before any model launch", async () => {
  const t = transport(), run = buildNativeTextProvider({ ...config(), callTimeoutMs: 100 }, { ...t, statusSpawn: () => statusProcess(true, true) });
  await expect(run.provider.complete([{ role: "user", content: "test" }])).rejects.toThrow("failed");
  expect(t.launches).toHaveLength(0);
  expect(run.snapshot().calls[0].deadline).toBe(true);
  expect(run.snapshot().calls[0].statusProcessExit).toBe("exited");
});

test("missing or mismatched native model acknowledgement cannot pass", async () => {
  for (const observedModel of [null, "other-model"]) {
    const run = buildNativeTextProvider(config(), transport("ok", observedModel));
    await expect(run.provider.complete([{ role: "user", content: "test" }])).rejects.toThrow("failed");
    expect(run.snapshot().calls[0].valid).toBe(false);
  }
});

test("explicit canonical model acknowledgement permits a configured alias", async () => {
  const run = buildNativeTextProvider({ ...config(), expectedObservedModel: "canonical-model" }, transport("ok", "canonical-model"));
  await expect(run.provider.complete([{ role: "user", content: "test" }])).resolves.toMatchObject({ content: "synthetic-output" });
});
