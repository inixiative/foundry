import { afterEach, expect, test } from "bun:test";
import { ContextLayer, ContextStack, type LLMMessage, type LLMProvider } from "../../../packages/core/src";
import { buildAgents, ThreadFactory } from "../../../packages/foundry/src/agents/thread-factory";
import { ThreadRuntimeManager } from "../../../packages/foundry/src/agents/thread-runtime";
import { starterConfig } from "../../../packages/foundry/src/viewer/config";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function setup(names: string[], review: (domain: string) => Promise<void> = async () => {}) {
  const config = starterConfig("mock", "mock");
  config.agents = { worker: { id: "worker", kind: "executor", provider: "mock", model: "mock",
    prompt: "Execute", temperature: 0, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
  const stack = new ContextStack(names.map(name => {
    const layer = new ContextLayer({ id: name }); layer.set(`Configured ${name} knowledge`); return layer;
  }));
  const inputs: LLMMessage[][] = [];
  const provider: LLMProvider = { id: "mock", complete: async messages => {
    inputs.push(structuredClone(messages)); return { model: "mock", content: "Completed evidence" };
  } };
  const runtime = new ThreadRuntimeManager({ config, log: () => {}, warn: () => {},
    domains: names.map(domain => ({ domain, layerId: domain, guardTriggers: [] })), learning: { timeoutMs: 500 },
    llm: { id: "flow", complete: async (messages, opts) => {
      if (opts?.threadId?.endsWith(":cartographer")) return { model: "mock", content: JSON.stringify({ layers: names, domains: names, confidence: 1 }) };
      const domain = names.find(name => opts?.threadId?.endsWith(`:domain:${name}`))!;
      if (messages.some(message => message.role === "user" && message.content.includes("## Completed work"))) {
        await review(domain);
        return { model: "mock", content: JSON.stringify({ decision: "learn", knowledge: `LEARNED-${domain}-PRIVATE`, facts: ["Completed evidence"], reason: "observed" }) };
      }
      return { model: "mock", content: JSON.stringify({ layers: [domain], snippets: [], confidence: 1 }) };
    } },
  });
  cleanup.push(() => runtime.disposeAll());
  const factory = new ThreadFactory({ stack, agents: buildAgents(config, stack, { provider }), runtime });
  return { factory, runtime, inputs };
}

// Replaces the serial-barrier assertion after opposite-model review; causal delivery remains required.
test("G3b: immediate work uses committed knowledge and reports pending without a serial learning wait", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const { factory, inputs, runtime } = setup(["security"], () => held);
  const thread = factory.create("a", { projectId: "P" });
  let dispatch: ReturnType<typeof thread.dispatch> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await thread.dispatch("worker", "First work");
    dispatch = thread.dispatch("worker", "Continue without repeating the fact");
    const result = await Promise.race([dispatch, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error("Immediate dispatch waited for held review")), 250);
    })]);
    expect(result.meta?.delivery).toMatchObject({ learningBarrier: { outcome: "pending", waitedMs: 0 } });
    expect(inputs).toHaveLength(2);
    expect(JSON.stringify(inputs[1])).not.toContain("LEARNED-security-PRIVATE");
  } finally {
    clearTimeout(timer); release(); await dispatch; await runtime.get("a")!.learningSettled();
  }
});

test("G3b: the first dispatch after a production learned signal receives the fact without repetition", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const { factory, inputs, runtime } = setup(["security"], () => held);
  const thread = factory.create("a", { projectId: "P" });
  let learned!: () => void;
  const committed = new Promise<void>(resolve => { learned = resolve; });
  const unsubscribe = thread.signals.on("domain_learning", signal => {
    if ((signal.content as { decision?: string }).decision === "learned") learned();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await thread.dispatch("worker", "First work");
    const originalInput = structuredClone(inputs[0]);
    release();
    await Promise.race([committed, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error("No production learned signal")), 1000);
    })]);
    await thread.dispatch("worker", "Continue without repeating the fact");
    expect(JSON.stringify(inputs[1])).toContain("LEARNED-security-PRIVATE");
    expect(inputs[0]).toEqual(originalInput);
    expect(JSON.stringify(inputs[0])).not.toContain("LEARNED-security-PRIVATE");
  } finally {
    clearTimeout(timer); unsubscribe(); release(); await runtime.get("a")!.learningSettled();
  }
});

test("G3b: independent domain reviews start concurrently, not behind another domain's latency", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started: string[] = [];
  const { factory, runtime } = setup(["security", "docs"], async domain => {
    started.push(domain);
    if (domain === "security") await held;
  });
  const thread = factory.create("a", { projectId: "P" });
  await thread.dispatch("worker", "Completed work for all domains");
  try {
    await Bun.sleep(15);
    expect([...started].sort()).toEqual(["docs", "security"]);
  } finally { release(); await runtime.get("a")!.learningSettled(); }
});

test("G3b: persisted knowledge cannot cross project ownership through a reused thread ID", async () => {
  const first = setup(["security"]);
  const a = first.factory.create("same-id", { projectId: "P" });
  await a.dispatch("worker", "Private project P work");
  await first.runtime.get(a.id)!.learningSettled();
  const bundle = first.runtime.get(a.id)!.knowledgeSnapshot();
  const second = setup(["security"]);
  const b = second.factory.create("same-id", { projectId: "Q" });
  const owned = second.runtime.get(b.id)!;
  expect(() => owned.restoreKnowledge(bundle)).toThrow();
  expect(JSON.stringify(owned.knowledgeSnapshot())).not.toContain("LEARNED-security-PRIVATE");
});
