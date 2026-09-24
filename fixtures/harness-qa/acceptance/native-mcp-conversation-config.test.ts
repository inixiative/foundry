import { expect, test } from "bun:test";
import { ContextStack, Thread, ToolRegistry } from "../../../packages/core/src/index";
import { ThreadRuntimeManager } from "../../../packages/foundry/src/agents/thread-runtime";
import { starterConfig } from "../../../packages/foundry/src/viewer/config";
import { nativeBridgeSource } from "../../../packages/foundry/src/mcp/native-bridge";
import { CodexSessionAdapter, InMemoryExternalSessionStore } from "../../../packages/foundry/src/providers/session-adapter";

// Unlike the older bridge fixture, this does not start a proxy from spawn argv.
// The actual native conversation receives only the first tools/call config.
async function fixture() {
  const thread = new Thread("config-owner", new ContextStack(), { projectId: "config-project" });
  const runtime = new ThreadRuntimeManager({ config: starterConfig("controlled", "controlled"), domains: [],
    llm: { id: "controlled", async complete() { return { model: "controlled", content: "{}" }; } }, log() {}, warn() {},
  });
  runtime.attach(thread);
  const lease = await nativeBridgeSource(thread, runtime, new ToolRegistry(), () => { throw Error("no SDK operations expected"); }).acquire();
  const launch = JSON.parse(lease.launch.claudeJson).mcpServers[lease.name] as { command: string; args: string[] };
  const calls: Array<{ name: string; arguments: Record<string, any> }> = [];
  let argv: readonly string[] = [], spawns = 0, closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let exited: Promise<number> | undefined, exit: ((n: number) => void) | undefined;
  const bindings = new InMemoryExternalSessionStore();
  const adapter = new CodexSessionAdapter({ store: bindings, defaults: { effort: "xhigh", timeout: 1000,
    spawn(command) {
      spawns++; argv = command;
      exited = new Promise<number>(resolve => { exit = resolve; });
      const emit = (v: unknown) => controller!.enqueue(new TextEncoder().encode(JSON.stringify(v) + "\n"));
      return {
        stdout: new ReadableStream<Uint8Array>({ start(c) { controller = c; } }),
        stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), exited,
        kill() { if (!closed) { closed = true; controller?.close(); exit?.(143); } },
        stdin: { write(line: string) {
          const request = JSON.parse(line);
          if (["initialize", "tools/list"].includes(request.method)) queueMicrotask(() => emit({ id: request.id, result: {} }));
          if (request.method === "tools/call") {
            calls.push(structuredClone(request.params));
            queueMicrotask(() => emit({ id: request.id, result: {
              structuredContent: { threadId: "controlled-conversation", content: "DONE" },
              content: [{ type: "text", text: "DONE" }],
            } }));
          }
        }, flush() {}, end() {} },
      };
    },
  } });
  return { thread, lease, launch, adapter, bindings, calls, get argv() { return argv; }, get spawns() { return spawns; },
    async close() {
      if (!closed && controller) { closed = true; controller.close(); exit?.(143); }
      await exited; await lease.close(); runtime.disposeAll();
    },
  };
}

test("production Codex adapter forwards its exact owned bridge to the first conversation config", async () => {
  const f = await fixture();
  try {
    const s = await f.adapter.createSession({ threadId: f.thread.id, cwd: process.cwd(), model: "controlled", nativeBridge: f.lease });
    await s.start(); await s.send("Independent initial task"); await s.send("Independent followup");
    expect(f.spawns).toBe(1); expect(f.calls.map(c => c.name)).toEqual(["codex", "codex-reply"]);
    expect(f.argv).toContain(`mcp_servers.${f.lease.name}.command=${JSON.stringify(f.launch.command)}`);
    const config = f.calls[0].arguments.config;
    const expected = { [`mcp_servers.${f.lease.name}.command`]: f.launch.command,
      [`mcp_servers.${f.lease.name}.args`]: f.launch.args, model_reasoning_effort: "xhigh" };
    expect(config).toEqual(expected);
    expect(f.calls[1].arguments.config).toBeUndefined();
    expect(f.calls[1].arguments.threadId).toBe("controlled-conversation");
    expect(await f.bindings.load(f.thread.id, "codex")).toBe("controlled-conversation");
  } finally { await f.close(); }
});

test("control: a conversation without a bridge retains effort and its reply binding", async () => {
  const f = await fixture();
  try {
    const s = await f.adapter.createSession({ threadId: f.thread.id, cwd: process.cwd(), model: "controlled" });
    await s.start(); await s.send("Initial"); await s.send("Followup");
    expect(f.calls[0].arguments.config).toEqual({ model_reasoning_effort: "xhigh" });
    expect(f.calls[1].name).toBe("codex-reply");
    expect(f.calls[1].arguments).toEqual({ prompt: "Followup", threadId: "controlled-conversation" });
    expect(f.argv.some(arg => arg.startsWith("mcp_servers."))).toBe(false);
  } finally { await f.close(); }
});

for (const mode of ["foreign", "tool-disabled"] as const) test(`control: ${mode} bridge grant is refused before spawning`, async () => {
  const f = await fixture();
  try {
    await expect(f.adapter.createSession({ threadId: mode === "foreign" ? "foreign-thread" : f.thread.id,
      cwd: process.cwd(), nativeBridge: f.lease, ...(mode === "tool-disabled" ? { tools: false } : {}) })).rejects.toThrow();
    expect(f.spawns).toBe(0); expect(f.calls).toHaveLength(0);
  } finally { await f.close(); }
});
