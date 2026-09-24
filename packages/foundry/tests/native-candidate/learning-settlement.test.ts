import { expect, test } from "bun:test";
import { ClaudeCodeSession, CodexMcpSession } from "@inixiative/agent-session";
import { ContextLayer, ContextStack, EventStream } from "@inixiative/foundry-core";
import { ClaudeCodeSessionAdapter, CodexSessionAdapter, InMemoryExternalSessionStore, type SessionAdapter } from "../../src/providers/session-adapter";
import { SessionBackedProvider } from "../../src/providers/session-backed";
import { ThreadFactory, buildAgents } from "../../src/agents/thread-factory";
import { ThreadRuntimeManager } from "../../src/agents/thread-runtime";
import { starterConfig } from "../../src/viewer/config";
import { KnowledgePersistence } from "../../src/persistence/knowledge-persistence";
import { LocalSessionStore } from "../../src/persistence/local-session-store";

const answer = JSON.stringify({ decision: "learn", knowledge: "Zephyr rollback C before B", facts: ["Zephyr rollback C before B"] });
async function until(predicate: () => boolean) { for (let i = 0; i < 1000 && !predicate(); i++) await Bun.sleep(1); expect(predicate()).toBe(true); }

for (const engine of ["claude", "mcp"] as const) for (const mode of ["eligible", "expired", "rpc-pending", "transport"] as const) {
  if (engine === "claude" && mode === "rpc-pending") continue;
  test(`${engine} installed class: ${mode} review reconciles only original job without another native write`, async () => {
    expect((new ClaudeCodeSession() as any).admissionProtocol).toBe("prewrite-v1");
    let output!: ReadableStreamDefaultController<Uint8Array>, exit!: (code: number) => void;
    let writes = 0, spawns = 0, kills = 0, closed = false, requestId = 0;
    let registered = () => false;
    const emit = (value: unknown) => { if (!closed) output.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n")); };
    const event = (msg: object, id = "owned-turn") => emit({ method: "codex/event", params: { id, msg } });
    const spawn = () => { spawns++; return { stdout: new ReadableStream<Uint8Array>({ start(c) { output = c; } }),
      stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), exited: new Promise<number>(r => { exit = r; }),
      kill() { kills++; if (!closed) { closed = true; output.close(); exit(0); } },
      stdin: { write(line: string) { const v = JSON.parse(line);
        if (["initialize", "tools/list"].includes(v.method)) { queueMicrotask(() => emit({ id: v.id, result: {} })); return; }
        if (v.type !== "user" && v.method !== "tools/call") return;
        writes++; requestId = v.id; expect(registered()).toBe(true);
        queueMicrotask(() => {
          if (engine === "claude") emit({ type: "system", subtype: "init", session_id: "owned-binding", model: "controlled" });
          else { event({ type: "task_started", turn_id: "owned-turn" }); event({ type: "agent_message", message: answer }); }
        });
      }, flush() {}, end() {} } }; };
    const bindings = new InMemoryExternalSessionStore();
    // Claude exercises its production restriction/cleanup adapter. MCP's production
    // adapter correctly refuses tools:false (separate test below). This injected
    // adapter exercises ONLY the installed MCP class's evidence/lease semantics.
    // It is not an authorized MCP reviewer launch policy or native model execution.
    let mcp: CodexMcpSession | undefined;
    const adapter: SessionAdapter = engine === "claude" ? new ClaudeCodeSessionAdapter({ store: bindings, defaults: { spawn } }) : {
      runtime: "codex", async getExternalSessionId() { return "owned-binding"; }, async clearSession() { throw Error("no rebind"); },
      async createSession() { mcp = new CodexMcpSession({ spawn, externalSessionId: "owned-binding", model: "controlled" }); return mcp; },
      async releaseIdleSession(session) { session.kill(); return "released"; },
    };
    const provider = new SessionBackedProvider({ id: "native-controlled", adapter, defaultModel: "controlled" });
    const complete = provider.complete.bind(provider);
    // Explicit local-failure injection; normal owned review configuration remains timeout:0.
    provider.complete = (messages, opts) => complete(messages, { ...opts, timeout: mode === "rpc-pending" ? 0 : 5 });
    const config = starterConfig("mock", "mock");
    config.agents = { worker: { id: "worker", kind: "executor", provider: "mock", model: "mock", prompt: "Work", temperature: 0,
      visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
    const layer = new ContextLayer({ id: "security" }); layer.set("Configured domain knowledge");
    const stack = new ContextStack([layer]);
    const manager = new ThreadRuntimeManager({ config, log() {}, warn() {}, domains: [{ domain: "security", layerId: "security", guardTriggers: [] }],
      learning: { timeoutMs: 2, hardTimeoutMs: mode === "expired" ? 30 : 500, reviewProvider: provider },
      llm: { id: "flow", async complete() { return { model: "flow", content: '{"domains":["security"],"layers":["security"],"confidence":1}' }; } } });
    const factory = new ThreadFactory({ stack, runtime: manager, agents: buildAgents(config, stack, { provider: { id: "mock", async complete() {
      return { model: "mock", content: "CENTRAL_COMPLETED" };
    } } }) });
    const store = new LocalSessionStore(":memory:"); new KnowledgePersistence(manager, store, new EventStream(), []);
    const thread = factory.create("installed-learning", { projectId: "P" }), runtime = manager.get(thread.id)!;
    registered = () => store.learningHistory(thread.id).some(row => (row.signal.content as any).decision === "native-admission");
    try {
      const completed = await thread.dispatch("worker", "Original evidence", undefined, { messageId: "original" });
      await until(() => writes === 1 && (mode === "rpc-pending" || runtime.learningState.domains.security.localSettled === true));
      const job = runtime.learningState.domains.security.job!;
      const frozen = runtime.learningState;
      if (mode === "expired") { await thread.dispatch("worker", "Queued evidence"); await runtime.learningSettled(); }
      if (engine === "mcp") { event({ type: "task_complete", turn_id: "foreign" }, "foreign"); await Bun.sleep(1);
        expect(runtime.learningState.domains.security.nativeOutcome).toBe("unknown"); }
      if (mode === "transport") {
        closed = true; output.close(); exit(1); await Bun.sleep(5);
        await runtime.reconcileNativeReview("security", job.id);
        expect(runtime.learningState.domains.security).toMatchObject({ nativeOutcome: "unknown", capacity: "unknown" });
        expect(kills).toBe(0); expect(store.knowledge(thread.id)).toBeUndefined();
      } else {
        if (engine === "claude") emit({ type: "result", subtype: "success", is_error: false, uuid: "owned-terminal", session_id: "owned-binding", result: answer });
        else {
          event({ type: "task_complete", turn_id: "owned-turn" });
          if (mode === "rpc-pending") {
            await until(() => runtime.learningState.domains.security.nativeOutcome === "completed");
            expect(runtime.learningState.domains.security.capacity).toBe("unknown"); expect(kills).toBe(0);
            expect(runtime.learningState.domains.security.localSettled).toBe(false);
            await until(() => !!store.knowledge(thread.id));
            expect(store.knowledge(thread.id)?.domains.security.content).toBe("Zephyr rollback C before B");
            expect(await provider.completionLifecycle.releaseIdle!({ threadId: `installed-learning:aux:review:${runtime.generation}:domain:security` })).toBe("unknown");
          }
          emit({ id: requestId, result: { structuredContent: { threadId: "owned-binding", content: answer } } });
        }
        if (mode === "expired") { await until(() => runtime.learningState.domains.security.nativeOutcome === "completed");
          await runtime.reconcileNativeReview("security", job.id); await Bun.sleep(1);
          expect(runtime.learningState.domains.security).toMatchObject({ status: "expired", closed: true });
          expect(store.knowledge(thread.id)).toBeUndefined();
        } else { await runtime.learningSettled(); expect(store.knowledge(thread.id)?.domains.security.content).toBe("Zephyr rollback C before B"); }
      }
      expect(completed.output).toBe("CENTRAL_COMPLETED"); expect(writes).toBe(1); expect(spawns).toBe(1);
      expect(frozen.domains.security.nativeOutcome).toBe("unknown");
      expect(runtime.learningState.domains.security.native?.owner).toMatchObject({ reviewJobId: job.id, messageId: "original", generation: job.generation });
      if (mcp) expect(mcp.externalSessionId).toBe("owned-binding");
    } finally { manager.disposeAll(); if (!closed) { closed = true; output?.close(); exit?.(0); } await Bun.sleep(1); store.close(); }
  });
}

test("production MCP reviewer policy refusal remains explicit and creates no native process", async () => {
  let spawns = 0;
  const adapter = new CodexSessionAdapter({ store: new InMemoryExternalSessionStore(), defaults: { spawn() { spawns++; throw Error("no process"); } } });
  await expect(adapter.createSession({ threadId: "owner:aux:review:job", cwd: process.cwd(), tools: false, model: "explicit-model" }))
    .rejects.toThrow("cannot enforce text-only");
  expect(spawns).toBe(0);
});
