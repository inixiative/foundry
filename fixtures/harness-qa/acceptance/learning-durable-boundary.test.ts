import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextLayer, ContextStack, EventStream, Harness, InterventionLog, type LLMMessage } from "../../../packages/core/src/index";
import { ThreadRuntimeManager } from "../../../packages/foundry/src/agents/thread-runtime";
import { ThreadFactory, buildAgents } from "../../../packages/foundry/src/agents/thread-factory";
import { ConfigStore, starterConfig } from "../../../packages/foundry/src/viewer/config";
import { createViewer } from "../../../packages/foundry/src/viewer/server";

const fact = "Zephyr rollback requires migration order C before B.";
const learn = (knowledge: string) => JSON.stringify({ decision: "learn", knowledge, facts: [knowledge], reason: "Verified work evidence" });
function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>(r => { resolve = r; });
  return { promise, resolve };
}

async function fixture(dir: string, reviewer: () => Promise<string> | string) {
  const config = starterConfig("controlled", "controlled");
  config.agents = { worker: { id: "worker", kind: "executor", provider: "controlled", model: "controlled", prompt: "Work",
    temperature: 0, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
  const layer = new ContextLayer({ id: "conventions", prompt: "Configured domain instructions" });
  layer.set("Configured domain knowledge");
  const stack = new ContextStack([layer]);
  const inputs: LLMMessage[][] = [];
  const events = new EventStream();
  const manager = new ThreadRuntimeManager({ config, log() {}, warn() {}, eventStream: events,
    learning: { timeoutMs: 5, hardTimeoutMs: 1000 },
    domains: [{ domain: "conventions", layerId: "conventions", guardTriggers: [] }],
    llm: { id: "controlled-review", async complete(messages) {
      return { model: "controlled", content: messages.some(m => m.content.includes("## Completed work"))
        ? await reviewer() : '{"domains":["conventions"],"layers":["conventions"],"snippets":[],"confidence":1}' };
    } },
  });
  const factory = new ThreadFactory({ stack, runtime: manager, agents: buildAgents(config, stack, { provider: {
    id: "controlled", async complete(messages) { inputs.push(structuredClone(messages)); return { model: "controlled", content: `COMPLETED_WORK_${inputs.length}` }; },
  } }) });
  const main = factory.create("main", { projectId: "controlled-project" });
  const owned = manager.get("main")!;
  const harness = new Harness(main); harness.setDefaultExecutor("worker");
  const configStore = new ConfigStore(dir); await configStore.save(config);
  const viewer = createViewer({ harness, eventStream: events, interventions: new InterventionLog(main.signals),
    configDir: dir, configStore, threadFactory: factory });
  let closed = false;
  return { ...viewer, owned, inputs, async send(id: string) {
    return viewer.app.request("/api/messages", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "main", id, message: "Continue independent work" }) });
  }, async close() { if (closed) return; closed = true; await owned.learningSettled(); manager.disposeAll(); viewer.localStore?.close(); } };
}

test("a delayed owned fact commits and survives actual journal reconstruction without repeating it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foundry-independent-learning-"));
  const held = deferred();
  let first: Awaited<ReturnType<typeof fixture>> | undefined;
  let restored: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    first = await fixture(dir, () => held.promise);
    expect((await first.send("origin")).status).toBe(200);
    await Bun.sleep(15);
    expect(first.owned.learningState.domains.conventions.status).toBe("delayed");
    expect(JSON.stringify(first.inputs[0])).not.toContain(fact);
    held.resolve(learn(fact));
    await first.owned.learningSettled();
    const before = first.localStore!.knowledge("main")!;
    expect(before.domains.conventions.content).toBe(fact);
    expect(before.domains.conventions.revision).toBe(1);
    const history = first.localStore!.learningHistory("main");
    expect(history.filter(e => (e.signal.content as { decision?: string }).decision === "learned")).toHaveLength(1);
    await first.close();
    restored = await fixture(dir, () => '{"decision":"abstain"}');
    expect(restored.inputs).toHaveLength(0);
    expect(restored.localStore!.knowledge("main")).toEqual(before);
    expect(restored.localStore!.learningHistory("main")).toEqual(history);
    expect((await restored.send("post-reconstruction")).status).toBe(200);
    expect(JSON.stringify(restored.inputs[0])).toContain(fact);
    expect(JSON.stringify(first.inputs[0])).not.toContain(fact);
  } finally {
    held.resolve('{"decision":"abstain"}');
    await restored?.close(); await first?.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("SQL commit failure preserves the prior durable revision and completed HTTP output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foundry-independent-learning-sql-"));
  const held = deferred(); let reviews = 0;
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture(dir, () => ++reviews === 1 ? learn(fact) : held.promise);
    expect((await f.send("initial")).status).toBe(200);
    await f.owned.learningSettled();
    const before = f.localStore!.knowledge("main")!;
    const knowledge = f.owned.domainLibrarians.get("conventions")!.threadKnowledge;
    const response = await f.send("completed-before-failed-learning");
    expect(response.status).toBe(200);
    expect((await response.json()).output).toBe("COMPLETED_WORK_2");
    // The journal owns an exclusive connection. Inject a real SQL failure only for the replacement revision.
    const db = (f.localStore as unknown as { db: Database }).db;
    db.exec("CREATE TRIGGER deny_independent_learning BEFORE INSERT ON session_knowledge WHEN json_extract(NEW.record, '$.domains.conventions.revision') = 2 BEGIN SELECT RAISE(ABORT, 'CONTROLLED_LEARNING_WRITE_FAILURE'); END");
    held.resolve(learn("UNCOMMITTED_REPLACEMENT"));
    await f.owned.learningSettled();
    expect(f.localStore!.knowledge("main")!.domains).toEqual(before.domains);
    expect(knowledge.revision).toBe(1);
    expect(knowledge.content).toBe(fact);
    const inspection = await (await f.app.request("/api/threads/main/knowledge")).json();
    expect(inspection.status).toBe("blocked");
    expect(inspection.error).toContain("CONTROLLED_LEARNING_WRITE_FAILURE");
    const history = await (await f.app.request("/api/messages?threadId=main")).json();
    expect(history.messages.some((m: { content?: string }) => m.content === "COMPLETED_WORK_2")).toBe(true);
    expect(f.inputs).toHaveLength(2);
    expect(JSON.stringify(history)).not.toContain("UNCOMMITTED_REPLACEMENT");
  } finally {
    held.resolve('{"decision":"abstain"}'); await f?.close(); rmSync(dir, { recursive: true, force: true });
  }
});
