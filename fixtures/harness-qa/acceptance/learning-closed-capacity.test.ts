import { expect, test } from "bun:test";
import { ContextLayer, ContextStack, EventStream, type LLMProvider } from "../../../packages/core/src/index";
import { ThreadFactory, buildAgents } from "../../../packages/foundry/src/agents/thread-factory";
import { ThreadRuntimeManager } from "../../../packages/foundry/src/agents/thread-runtime";
import { LocalSessionStore } from "../../../packages/foundry/src/persistence/local-session-store";
import { KnowledgePersistence } from "../../../packages/foundry/src/persistence/knowledge-persistence";
import { OpenAIProvider } from "../../../packages/foundry/src/providers/openai";
import { starterConfig } from "../../../packages/foundry/src/viewer/config";

function fixture(reviewProvider: LLMProvider) {
  const config = starterConfig("controlled", "controlled");
  config.agents = { worker: { id: "worker", kind: "executor", provider: "controlled", model: "controlled",
    prompt: "Work", temperature: 0, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
  const layer = new ContextLayer({ id: "conventions", prompt: "Domain instructions" });
  layer.set("Domain knowledge");
  const stack = new ContextStack([layer]);
  const events = new EventStream();
  const manager = new ThreadRuntimeManager({ config, log() {}, warn() {}, eventStream: events,
    domains: [{ domain: "conventions", layerId: "conventions", guardTriggers: [] }],
    learning: { reviewProvider, timeoutMs: 500, hardTimeoutMs: 2000 },
    llm: { id: "controlled-flow", async complete() {
      return { model: "controlled", content: '{"domains":["conventions"],"layers":["conventions"],"confidence":1}' };
    } },
  });
  const factory = new ThreadFactory({ stack, runtime: manager, agents: buildAgents(config, stack, { provider: {
    id: "controlled", async complete() { return { model: "controlled", content: "COMPLETED_INDEPENDENT_WORK" }; },
  } }) });
  const thread = factory.create("closed-capacity", { projectId: "owned-project" });
  const runtime = manager.get(thread.id)!;
  const store = new LocalSessionStore(":memory:");
  new KnowledgePersistence(manager, store, events, [thread]);
  return { thread, runtime, store, async send(id: string) {
    const result = await thread.dispatch("worker", `Independent request ${id}`, undefined, { messageId: id });
    await runtime.learningSettled(); return result;
  }, close() { manager.disposeAll(); store.close(); } };
}

test("closed unknown review capacity is not reported as pending", async () => {
  let calls = 0;
  const f = fixture({ id: "claude-code", async complete() { calls++; throw Error("CONTROLLED_UNKNOWN_NATIVE_OUTCOME"); } });
  try {
    await f.send("origin");
    let last;
    for (let i = 0; i < 32; i++) last = await f.send(`later-${i}`);
    expect(calls).toBe(1);
    const barrier = last!.meta?.delivery as { learningBarrier: { outcome: string } };
    expect(barrier.learningBarrier.outcome).not.toBe("pending");
  } finally { f.close(); }
});

test("a closed lease does not retain new non-admitted review payloads", async () => {
  let calls = 0;
  const f = fixture({ id: "claude-code", async complete() { calls++; throw Error("CONTROLLED_UNKNOWN_NATIVE_OUTCOME"); } });
  try {
    await f.send("origin");
    for (let i = 0; i < 32; i++) await f.send(`never-admitted-${i}`);
    expect(calls).toBe(1);
    expect(f.runtime.learningState.domains.conventions.queued).toBe(0);
  } finally { f.close(); }
});

test("new evidence refused by a closed review lease has a durable non-admission record", async () => {
  let calls = 0;
  const f = fixture({ id: "claude-code", async complete() { calls++; throw Error("CONTROLLED_UNKNOWN_NATIVE_OUTCOME"); } });
  try {
    await f.send("origin");
    for (let i = 0; i < 3; i++) await f.send(`refused-${i}`);
    expect(calls).toBe(1);
    const records = f.store.learningHistory(f.thread.id).map(item => item.signal.content as {
      evidence?: { messageId?: string }; decision?: string; reason?: string;
    });
    for (let i = 0; i < 3; i++) {
      const record = records.find(item => item.evidence?.messageId === `refused-${i}`);
      expect(record).toBeDefined();
      expect(record!.decision).not.toBe("learned");
      expect(record!.reason).toBeTruthy();
    }
  } finally { f.close(); }
});

test("a completed stateless HTTP failure does not disable reviews of later distinct work", async () => {
  const requests: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
    requests.push(await request.json());
    if (requests.length === 1) return new Response("CONTROLLED_FINISHED_HTTP_503", { status: 503 });
    return Response.json({ model: "controlled", choices: [{ message: { content: '{"decision":"abstain","reason":"Distinct work reviewed"}' }, finish_reason: "stop" }] });
  } });
  const f = fixture(new OpenAIProvider({ apiKey: "test-only-not-a-credential", defaultModel: "controlled",
    baseUrl: `http://127.0.0.1:${server.port}` }));
  try {
    await f.send("failed-review-origin");
    expect(requests).toHaveLength(1);
    await f.send("distinct-later-work");
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).toContain("distinct-later-work");
    const records = f.store.learningHistory(f.thread.id).map(item => item.signal.content as { decision?: string });
    expect(records.some(item => item.decision === "error")).toBe(true);
    expect(records.some(item => item.decision === "abstain")).toBe(true);
  } finally { f.close(); server.stop(true); }
});
