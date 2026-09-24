import { expect, test } from "bun:test";
import { ContextLayer, ContextStack, computeHash, type LLMMessage, type LLMProvider } from "../../../packages/core/src/index";
import { ThreadFactory, buildAgents } from "../../../packages/foundry/src/agents/thread-factory";
import { ThreadRuntimeManager } from "../../../packages/foundry/src/agents/thread-runtime";
import { starterConfig } from "../../../packages/foundry/src/viewer/config";

function fixture() {
  let release!: () => void;
  let reviewStarted!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { reviewStarted = resolve; });
  const config = starterConfig("controlled", "controlled");
  config.agents = { worker: { id: "worker", kind: "executor", provider: "controlled", model: "controlled",
    prompt: "Execute", temperature: 0, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
  const layer = new ContextLayer({ id: "conventions", prompt: "Configured migration instructions" });
  layer.set("DOMAIN_POLICY: preserve rollback order");
  const template = new ContextStack([layer]);
  const providerInputs: LLMMessage[][] = [];
  const provider: LLMProvider = { id: "controlled", async complete(messages) {
    providerInputs.push(structuredClone(messages));
    return { model: "controlled", content: "Completed work" };
  } };
  let reviews = 0;
  const flow: LLMProvider = { id: "controlled-flow", async complete(messages, opts) {
    if (opts?.threadId?.endsWith(":cartographer")) return { model: "controlled", content: JSON.stringify({ domains: ["conventions"], layers: ["conventions"], confidence: 1 }) };
    if (messages.some(m => m.content.includes("## Completed work"))) {
      reviews++;
      if (reviews === 1) {
        reviewStarted();
        await held;
        return { model: "controlled", content: JSON.stringify({ decision: "learn", knowledge: "OLD_REVIEW_DRAFT", facts: ["OLD_REVIEW_DRAFT"] }) };
      }
      return { model: "controlled", content: JSON.stringify({ decision: "abstain", reason: "No new fact" }) };
    }
    return { model: "controlled", content: JSON.stringify({ layers: ["conventions"], snippets: [], confidence: 1 }) };
  } };
  const runtime = new ThreadRuntimeManager({ config, log() {}, warn() {},
    domains: [{ domain: "conventions", layerId: "conventions", guardTriggers: [] }], llm: flow,
    learning: { timeoutMs: 2000, barrierMs: 2000 },
  });
  const factory = new ThreadFactory({ stack: template, agents: buildAgents(config, template, { provider }), runtime });
  const thread = factory.create("controlled-work", { projectId: "controlled-project" });
  const owned = runtime.get("controlled-work")!;
  return { runtime, thread, owned, providerInputs, started, release, async close() { release(); await owned.learningSettled(); runtime.disposeAll(); } };
}

test("a pending background review does not add a serial wait to the next central request", async () => {
  const f = fixture();
  let pending: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await f.thread.dispatch("worker", "First work");
    await f.started;
    pending = f.thread.dispatch("worker", "Continue without repeating the fact");
    const outcome = await Promise.race([
      pending.then(() => "executed"),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve("waiting-on-background"), 500); }),
    ]);
    expect(outcome).toBe("executed");
    expect(f.providerInputs).toHaveLength(2);
    expect(JSON.stringify(f.providerInputs[1])).not.toContain("OLD_REVIEW_DRAFT");
  } finally {
    clearTimeout(timer);
    f.release();
    await pending;
    await f.close();
  }
});

test("a draft based on an older knowledge revision cannot overwrite a newer restored revision", async () => {
  const f = fixture();
  try {
    await f.thread.dispatch("worker", "First work");
    await f.started;
    const bundle = structuredClone(f.owned.knowledgeSnapshot());
    const content = "NEWER_COMMITTED_KNOWLEDGE: retain migration checkpoint";
    bundle.domains.conventions = { ...bundle.domains.conventions, revision: 2, content,
      hash: computeHash(content), updatedAt: Date.now(), author: "controlled-restore",
      evidence: [{ kind: "restore", id: "controlled-newer-snapshot", timestamp: Date.now() }] };
    f.owned.restoreKnowledge(bundle);
    f.release();
    await f.owned.learningSettled();
    const current = f.owned.domainLibrarians.get("conventions")!.threadKnowledge;
    expect(current.content).toBe(content);
    expect(current.revision).toBe(2);
    await f.thread.dispatch("worker", "Continue");
    expect(JSON.stringify(f.providerInputs[1])).toContain(content);
    expect(JSON.stringify(f.providerInputs[1])).not.toContain("OLD_REVIEW_DRAFT");
  } finally { await f.close(); }
});
