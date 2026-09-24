import { expect, test } from "bun:test";
import { ClaudeCodeSessionAdapter, InMemoryExternalSessionStore, type ClaudeCodeSessionAdapterConfig } from "../../../packages/foundry/src/providers/session-adapter";
import { SessionBackedProvider } from "../../../packages/foundry/src/providers/session-backed";

type Proc = ReturnType<NonNullable<NonNullable<ClaudeCodeSessionAdapterConfig["defaults"]>["spawn"]>>;

function fixture() {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let errors!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (code: number) => void;
  let closed = false;
  let sends = 0;
  const commands: string[][] = [];
  const stdout = new ReadableStream<Uint8Array>({ start(c) { output = c; } });
  const stderr = new ReadableStream<Uint8Array>({ start(c) { errors = c; } });
  const exited = new Promise<number>(resolve => { exit = resolve; });
  const emit = (raw: object) => output.enqueue(new TextEncoder().encode(JSON.stringify(raw) + "\n"));
  const close = () => {
    if (closed) return;
    closed = true; output.close(); errors.close(); exit(0);
  };
  const proc: Proc = { stdout, stderr, exited, kill: close, stdin: {
    write(data: string) {
      for (const line of data.split("\n")) if (line.trim()) {
        const n = ++sends;
        queueMicrotask(() => emit({ type: "result", subtype: "success", is_error: false,
          result: "CONTROLLED_BUDGET_RESULT", session_id: "controlled-budget-binding", uuid: `controlled-${n}` }));
      }
    }, flush() {}, end() {},
  } };
  // Actual installed session class and production adapter/provider, but only
  // synthetic streams: capture launch arguments without any OS/model process.
  const adapter = new ClaudeCodeSessionAdapter({ store: new InMemoryExternalSessionStore(), defaults: {
    spawn(cmd) {
      commands.push([...cmd]);
      queueMicrotask(() => emit({ type: "system", subtype: "init", session_id: "controlled-budget-binding" }));
      return proc;
    },
  } });
  return { commands, close, get sends() { return sends; }, provider: new SessionBackedProvider({
    id: "claude-code", adapter, defaultModel: "fable", defaultCwd: "/controlled/offline-budget",
  }) };
}

test("central coding without an operator turn budget does not acquire a hidden harness limit", async () => {
  const f = fixture();
  try {
    const result = await f.provider.complete([{ role: "user", content: "Continue coding" }], { threadId: "work" });
    expect(result.content).toBe("CONTROLLED_BUDGET_RESULT");
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]).not.toContain("--max-turns");
    expect(f.sends).toBe(1);
  } finally { f.close(); }
});

test("an explicit central turn budget reaches the native launch unchanged", async () => {
  const f = fixture();
  try {
    await f.provider.complete([{ role: "user", content: "Bounded coding" }], { threadId: "work", maxTurns: 48 });
    expect(f.commands).toHaveLength(1);
    const at = f.commands[0].indexOf("--max-turns");
    expect(at).toBeGreaterThan(-1);
    expect(f.commands[0][at + 1]).toBe("48");
    expect(f.sends).toBe(1);
  } finally { f.close(); }
});

test("removing a hidden central limit must not remove the auxiliary one-turn and tool restrictions", async () => {
  const f = fixture();
  try {
    await f.provider.complete([{ role: "user", content: "Classify only" }], { threadId: "work:aux:classifier" });
    expect(f.commands).toHaveLength(1);
    const cmd = f.commands[0];
    expect(cmd[cmd.indexOf("--max-turns") + 1]).toBe("1");
    expect(cmd[cmd.indexOf("--tools") + 1]).toBe("");
    expect(cmd).toContain("--strict-mcp-config");
    expect(cmd).toContain("--disable-slash-commands");
    expect(f.sends).toBe(1);
  } finally { f.close(); }
});
