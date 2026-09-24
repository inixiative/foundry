import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { ContextLayer, ContextStack, EventStream, Harness, InterventionLog, type LLMProvider } from "@inixiative/foundry-core";
import { buildAgents, ThreadFactory } from "../src/agents/thread-factory";
import { ThreadRuntimeManager } from "../src/agents/thread-runtime";
import { ConfigStore, starterConfig } from "../src/viewer/config";
import { createViewer } from "../src/viewer/server";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function setup(knowledge = "DURABLE-PRIVATE-SENTINEL") {
  const dir = mkdtempSync(join(tmpdir(), "foundry-knowledge-recovery-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  async function make() {
    const config = starterConfig("mock", "mock");
    config.agents = { worker: { id: "worker", kind: "executor", provider: "mock", model: "mock", prompt: "Work",
      temperature: 0, maxTokens: 256, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
    const layer = new ContextLayer({ id: "security" }); layer.set("Configured domain knowledge");
    const stack = new ContextStack([layer]);
    const inputs: string[] = [];
    const provider: LLMProvider = { id: "mock", complete: async messages => {
      inputs.push(JSON.stringify(messages)); return { model: "mock", content: "Verified work result" };
    } };
    const events = new EventStream();
    const runtime = new ThreadRuntimeManager({ config, log: () => {}, warn: () => {}, eventStream: events,
      domains: [{ domain: "security", layerId: "security", guardTriggers: [] }],
      llm: { id: "flow", complete: async messages => messages.some(m => m.content.includes("## Completed work"))
        ? { model: "mock", content: JSON.stringify({ decision: "learn", knowledge, facts: ["Observed evidence"] }) }
        : { model: "mock", content: '{"layers":["security"],"domains":["security"],"snippets":[],"confidence":1}' } },
    });
    const factory = new ThreadFactory({ stack, agents: buildAgents(config, stack, { provider }), runtime });
    const main = factory.create("main");
    const harness = new Harness(main); harness.setDefaultExecutor("worker");
    const configStore = new ConfigStore(dir); await configStore.save(config);
    const viewer = createViewer({ harness, eventStream: events, interventions: new InterventionLog(main.signals),
      configDir: dir, configStore, threadFactory: factory });
    let closed = false;
    const close = () => { if (closed) return; closed = true; runtime.disposeAll(); viewer.localStore?.close(); };
    cleanup.push(close);
    return { ...viewer, factory, runtime, main, inputs, events, close };
  }
  return { make, dir };
}

async function send(viewer: Awaited<ReturnType<ReturnType<typeof setup>["make"]>>, threadId: string, id: string) {
  return viewer.app.request("/api/messages", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId, id, message: "Continue work" }) });
}

test("committed private learning survives production viewer reconstruction and reaches the next provider input", async () => {
  const { make } = setup();
  const first = await make();
  expect((await send(first, "main", "first-turn")).status).toBe(200);
  await first.runtime.get("main")!.learningSettled();
  const before = await (await first.app.request("/api/threads/main/knowledge")).json();
  expect(before.snapshot.domains.security.content).toBe("DURABLE-PRIVATE-SENTINEL");
  expect(before.history[0].signal.content.evidence.messageId).toBe("first-turn");
  first.close();

  const second = await make();
  const after = await (await second.app.request("/api/threads/main/knowledge")).json();
  expect(after.snapshot).toEqual(before.snapshot);
  expect(after.history).toEqual(before.history);
  expect((await send(second, "main", "after-restart")).status).toBe(200);
  expect(second.inputs[0]).toContain("DURABLE-PRIVATE-SENTINEL");
  const other = second.factory.create("other"); second.directory.add(other);
  expect((await send(second, "other", "other-turn")).status).toBe(200);
  expect(second.inputs[1]).not.toContain("DURABLE-PRIVATE-SENTINEL");
  await second.runtime.get("main")!.learningSettled();
  await second.runtime.get("other")!.learningSettled();
});

test("learning persistence attaches to newly created viewer threads and restores them", async () => {
  const { make } = setup(); const first = await make();
  const response = await first.app.request("/api/threads", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "new-thread", description: "New work" }) });
  expect(response.status).toBe(201);
  expect((await send(first, "new-thread", "new-work")).status).toBe(200);
  await first.runtime.get("new-thread")!.learningSettled();
  first.close();
  const second = await make();
  expect(second.runtime.get("new-thread")!.knowledgeSnapshot().domains.security.content).toBe("DURABLE-PRIVATE-SENTINEL");
  expect(second.runtime.get("main")!.knowledgeSnapshot().domains.security.content).toBe("");
});

test("Zephyr causal fact reconstructs from the real journal and reaches the next HTTP dispatch without repetition", async () => {
  const fact = "Zephyr rollback requires migration order C before B.";
  const { make } = setup(fact); const first = await make();
  expect((await send(first, "main", "zephyr-origin")).status).toBe(200);
  await first.runtime.get("main")!.learningSettled();
  const before = first.localStore!.knowledge("main")!;
  expect(before.domains.security.content).toBe(fact);
  expect(first.inputs[0]).not.toContain(fact);
  first.close();
  const reconstructed = await make();
  expect(reconstructed.localStore!.knowledge("main")).toEqual(before);
  expect(reconstructed.inputs).toHaveLength(0);
  expect((await send(reconstructed, "main", "zephyr-next-independent")).status).toBe(200);
  expect(reconstructed.inputs[0]).toContain(fact);
  await reconstructed.runtime.get("main")!.learningSettled();
});

test("failed knowledge writes quarantine the owning thread instead of continuing with uncommitted state", async () => {
  const { make } = setup(); const viewer = await make();
  viewer.localStore!.saveKnowledge = () => { throw new Error("simulated disk full"); };
  expect((await send(viewer, "main", "work-before-disk-error")).status).toBe(200);
  // The successful work result is separate from its asynchronous learning outcome.
  await Bun.sleep(10);
  expect(viewer.main.disposed).toBe(true);
  const state = await (await viewer.app.request("/api/threads/main/knowledge")).json();
  expect(state.status).toBe("blocked");
  expect(state.error).toContain("simulated disk full");
  expect((await send(viewer, "main", "must-not-run")).status).toBe(409);
  expect(viewer.inputs).toHaveLength(1);
});

for (const corruption of ["checksum", "owner"] as const) {
  test(`invalid saved knowledge (${corruption}) is retained for inspection but cannot reach execution`, async () => {
    const { make, dir } = setup(); const first = await make();
    expect((await send(first, "main", "learn-before-corruption")).status).toBe(200);
    await first.runtime.get("main")!.learningSettled();
    first.close();
    const db = new Database(join(dir, "sessions.sqlite"));
    const row = db.query("SELECT record FROM session_knowledge WHERE thread_id='main'").get() as { record: string };
    const data = JSON.parse(row.record);
    data.domains.security.projectId = "foreign-project";
    const record = JSON.stringify(data);
    if (corruption === "owner") db.query("UPDATE session_knowledge SET record=?, checksum=? WHERE thread_id='main'")
      .run(record, createHash("sha256").update(record).digest("hex"));
    else db.query("UPDATE session_knowledge SET record=? WHERE thread_id='main'").run(record);
    db.close();
    const second = await make();
    const state = await (await second.app.request("/api/threads/main/knowledge")).json();
    expect(state.status).toBe("blocked");
    expect(second.main.disposed).toBe(true);
    expect((await send(second, "main", "cannot-use-corruption")).status).toBe(409);
    expect(second.inputs).toHaveLength(0);
    // The durable "requested" review record (phase history) is not an outcome; count outcome records only.
    expect(second.localStore!.learningHistory("main").filter(row => (row.signal.content as { decision?: string }).decision !== "requested")).toHaveLength(1);
  });
}
