import { expect, test } from "bun:test";
import { ContextStack, Harness, type LLMProvider } from "@inixiative/foundry-core";
import { starterConfig, type AgentSettingsConfig, type FoundryConfig } from "../src/viewer/config";
import { buildAgents, buildLayers, ThreadFactory, type SourceResolver } from "../src/agents/thread-factory";
import { ThreadRuntimeManager } from "../src/agents/thread-runtime";
import { DECISION_LATENCY_BUDGET } from "../src/providers/decision-budget";

const DOMAINS = ["api", "db", "ui", "auth", "security", "testing"];
const expert = (domain: string): AgentSettingsConfig => ({
  id: `${domain}-expert`, kind: "decider", flowRole: "domain-advising", domain, prompt: `Advise on ${domain}.`,
  provider: "decisions", model: "luna", tools: false, visibleLayers: [`${domain}-reference`], ownedLayers: [`${domain}-reference`], peers: [], maxDepth: 1, enabled: true,
});

/** Six experts, classifier, router and Cartographer on one decision provider; a central worker. */
function config(): FoundryConfig {
  const c = starterConfig("central", "central-model");
  c.agents = {
    classifier: { id: "classifier", kind: "classifier", prompt: "Classify the message.", provider: "decisions", model: "luna", visibleLayers: [], peers: [], maxDepth: 1, enabled: true },
    router: { id: "router", kind: "router", prompt: "Route to worker.", provider: "decisions", model: "luna", visibleLayers: [], peers: [], maxDepth: 1, enabled: true },
    worker: { id: "worker", kind: "executor", prompt: "Implement the requested change", provider: "central", model: "central-model", visibleLayers: [], peers: [], maxDepth: 1, enabled: true },
    ...Object.fromEntries(DOMAINS.map(d => [`${d}-expert`, expert(d)])),
  };
  c.layers = Object.fromEntries(DOMAINS.map(d => [`${d}-reference`, { id: `${d}-reference`, domain: d, segment: "domain-knowledge", prompt: `${d} context`,
    sourceIds: [`${d}-source`], writers: [`${d}-expert`], staleness: 0, enabled: true }]));
  c.sources = Object.fromEntries(DOMAINS.map(d => [`${d}-source`, { id: `${d}-source`, label: d, type: "inline", uri: `${d.toUpperCase()}: owned knowledge`, enabled: true }]));
  return c;
}

/** Every decision takes `delayMs`; records how many run at once and when the worker is first called. */
function providers(delayMs: number) {
  let live = 0, peak = 0, calls = 0, workerStartedAt = 0;
  const decisions: LLMProvider = { id: "decisions", async complete(messages, opts = {}) {
    const id = opts.threadId ?? "";
    // Post-turn learning review runs after the worker; only pre-message decisions are measured.
    if (id.includes(":aux:review:")) return { content: JSON.stringify({ decision: "skip", facts: [], reason: "controlled" }), model: "luna" };
    calls++; live++; peak = Math.max(peak, live);
    await Bun.sleep(delayMs); live--;
    const content = id.includes(":aux:agent:classifier") ? JSON.stringify({ category: "feature", tags: [], complexity: "low" })
      : id.includes(":aux:agent:router") ? JSON.stringify({ destination: "worker", contextSlice: [], priority: 5 })
      : id.endsWith(":cartographer") ? JSON.stringify({ domains: DOMAINS, layers: DOMAINS.map(d => `${d}-reference`), confidence: 1 })
      : JSON.stringify({ layers: [], snippets: [], confidence: 1 });
    void messages;
    return { content, model: "luna" };
  } };
  const central: LLMProvider = { id: "central", async complete() { workerStartedAt ||= performance.now(); return { content: "done", model: "central-model" }; } };
  return { decisions, central, get peak() { return peak; }, get calls() { return calls; }, get workerStartedAt() { return workerStartedAt; } };
}

test("the pre-message phase is one concurrent round: message to worker start costs about one decision", async () => {
  const delayMs = 150;
  const c = config(), p = providers(delayMs);
  const sourceResolver: SourceResolver = (id, cfg) => cfg.sources[id] ? { id, load: async () => cfg.sources[id].uri } : null;
  const stack = new ContextStack(buildLayers(c, { sourceResolver }));
  const map = new Map<string, LLMProvider>([[p.decisions.id, p.decisions], [p.central.id, p.central]]);
  const manager = new ThreadRuntimeManager({ config: c, llm: p.decisions, providers: map, log() {}, warn() {} });
  const deps = { provider: p.central, providers: map };
  const factory = new ThreadFactory({ stack, agents: buildAgents(c, stack, deps), runtime: manager, configuration: { config: c, layers: { sourceResolver }, agents: deps } });
  const thread = factory.create("lead", { cwd: "/tmp" });
  const harness = new Harness(thread);
  harness.setClassifier("classifier"); harness.setRouter("router"); harness.setDefaultExecutor("worker");
  try {
    for (const layer of stack.layers) await layer.warm?.();
    const started = performance.now();
    const result = await harness.send({ id: "m1", payload: "Add a login endpoint" });
    const toWorker = p.workerStartedAt - started;
    expect(result.result.output).toBe("done");
    // classifier + router + Cartographer + six experts
    expect(p.calls).toBe(9);
    expect(p.peak).toBe(9);
    // One round of decisions, not classify -> route -> advise (3 rounds), within the structural budget.
    expect(toWorker).toBeLessThan(delayMs * DECISION_LATENCY_BUDGET.messageToWorkerInDecisionRounds);
    expect(toWorker).toBeGreaterThanOrEqual(delayMs);
    console.log(JSON.stringify({ decisionMs: delayMs, messageToWorkerMs: Math.round(toWorker), concurrentDecisions: p.peak }));
  } finally { manager.disposeAll(); }
});
