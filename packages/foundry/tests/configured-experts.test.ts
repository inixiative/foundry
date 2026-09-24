import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextLayer, ContextStack, EventStream, Thread, type CompletionOpts, type LLMMessage, type LLMProvider } from "@inixiative/foundry-core";
import { ConfigStore, starterConfig, type AgentSettingsConfig, type FoundryConfig } from "../src/viewer/config";
import { resolveProjectView } from "../src/viewer/config-resolve";
import { buildAgents, buildLayers, ThreadFactory, type SourceResolver } from "../src/agents/thread-factory";
import { ThreadRuntimeManager } from "../src/agents/thread-runtime";
import { LocalSessionStore } from "../src/persistence/local-session-store";
import { KnowledgePersistence } from "../src/persistence/knowledge-persistence";
import { SessionBackedProvider } from "../src/providers/session-backed";
import { DOCS_ADVISE_PROMPT } from "../src/setup/scan-docs";

const expert = (domain = "compatibility", id = `${domain}-expert`, layerId = `${domain}-reference`): AgentSettingsConfig => ({
  id, kind: "decider", flowRole: "domain-advising", domain, prompt: `INSTRUCTIONS_${domain}: interpret only your domain's evidence.`,
  provider: "expert", model: "explicit-fable", tools: false, visibleLayers: [layerId], ownedLayers: [layerId], peers: [], maxDepth: 1, enabled: true,
});
function config() {
  const c = starterConfig("central", "central-model");
  c.agents = { worker: { id: "worker", kind: "executor", prompt: "Implement the requested change", provider: "central", model: "central-model", visibleLayers: [], peers: [], maxDepth: 1, enabled: true },
    "compatibility-expert": expert() };
  c.layers = { "compatibility-reference": { id: "compatibility-reference", domain: "compatibility", segment: "domain-knowledge", prompt: "Compatibility context",
    sourceIds: ["compatibility-source"], writers: ["compatibility-expert"], staleness: 0, enabled: true } };
  c.sources = { "compatibility-source": { id: "compatibility-source", label: "Compatibility", type: "inline", uri: "DOMAIN_COMPAT: old readers still work", enabled: true } };
  return c;
}
interface Call { phase: "central" | "pre" | "post" | "route"; provider: string; messages: LLMMessage[]; opts: CompletionOpts }
function setup(c: FoundryConfig, store?: LocalSessionStore, review?: (call: Call) => Promise<string> | string, extra?: LLMProvider) {
  const calls: Call[] = [];
  const provider = (id: string): LLMProvider => ({ id, async complete(messages, opts = {}) {
    const phase: Call["phase"] = opts.threadId?.endsWith(":cartographer") ? "route" : opts.threadId?.includes(":review:") ? "post" : opts.threadId?.includes(":aux:") ? "pre" : "central";
    const call = { phase, provider: id, messages: structuredClone(messages), opts: { ...opts } }; calls.push(call);
    const domain = opts.threadId?.split(":domain:").at(-1) ?? "compatibility";
    return { model: opts.model ?? "controlled", content: phase === "central" ? "COMPLETED: additive migration and regression verified"
      : phase === "route" ? JSON.stringify({ domains: ["compatibility", "testing"], layers: ["compatibility-reference", "testing-reference"], confidence: 1 })
      : phase === "pre" ? JSON.stringify({ layers: [`${domain}-reference`], snippets: [], confidence: 1 })
      : review ? await review(call) : JSON.stringify({ decision: "learn", knowledge: `PRIVATE_${domain}: ${messages.some(m => m.content.includes("additive migration")) ? "additive migration verified" : "observed completed work"}`, facts: [], reason: `OWNED_${domain}_REASON` }) };
  } });
  const central = provider("central"), flow = provider("flow"), experts = provider("expert"), phase = provider("phase");
  const providers = new Map([central, flow, experts, phase, ...(extra ? [extra] : [])].map(p => [p.id, p]));
  const sourceResolver: SourceResolver = (id, cfg) => cfg.sources[id] ? { id, load: async () => cfg.sources[id].uri } : null;
  const stack = new ContextStack(buildLayers(c, { sourceResolver }));
  const manager = new ThreadRuntimeManager({ config: c, llm: flow, providers, log() {}, warn() {}, learning: { timeoutMs: 20, hardTimeoutMs: 1000 } });
  const persistence = store && new KnowledgePersistence(manager, store, new EventStream(), []);
  const deps = { provider: central, providers };
  const factory = new ThreadFactory({ stack, agents: buildAgents(c, stack, deps), runtime: manager,
    configuration: { config: c, layers: { sourceResolver }, agents: deps } });
  return { factory, manager, stack, calls, persistence,
    async close() { for (const runtime of manager.runtimes.values()) await runtime.learningSettled(); manager.disposeAll(); } };
}

test("saved experts learn through production factory/journal, remain separate and survive a fresh configuration/factory reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "e1-saved-experts-")); let f: ReturnType<typeof setup> | undefined; let journal: LocalSessionStore | undefined;
  try {
    const c = config(); c.agents["testing-expert"] = expert("testing");
    c.layers["testing-reference"] = { ...c.layers["compatibility-reference"], id: "testing-reference", domain: "testing", writers: ["testing-expert"], sourceIds: ["testing-source"] };
    c.sources["testing-source"] = { id: "testing-source", label: "Testing", type: "inline", uri: "DOMAIN_TEST: require a legacy reader regression", enabled: true };
    c.projects.P = { id: "P", path: dir }; c.projects.Q = { id: "Q", path: dir };
    const settings = new ConfigStore(dir); await settings.save(c); const loaded = await new ConfigStore(dir).load();
    const savedBytes = await readFile(join(dir, "settings.json"), "utf8"); journal = new LocalSessionStore(join(dir, "sessions.sqlite")); f = setup(loaded, journal);
    const a = f.factory.create("A", { projectId: "P" }), runtime = f.manager.get("A")!;
    expect([...runtime.domainLibrarians.keys()]).toEqual(["compatibility", "testing"]);
    expect(a.stack.getLayer("compatibility-reference")!.definition).toMatchObject({ domain: "compatibility", writers: ["compatibility-expert"] });
    const first = await a.dispatch("worker", "Implement the migration", undefined, { messageId: "A1" });
    const frozen = JSON.stringify(first.meta?.injection); await runtime.learningSettled();
    for (const domain of ["compatibility", "testing"]) {
      const lib = runtime.domainLibrarians.get(domain)!;
      expect(lib.threadKnowledge.revision).toBe(1); expect(lib.threadKnowledge.content).toContain(`PRIVATE_${domain}`);
      expect(journal.knowledge("A")!.domains[domain].content).toBe(lib.threadKnowledge.content);
      const post = f.calls.find(call => call.phase === "post" && call.opts.threadId?.endsWith(`:domain:${domain}`))!;
      expect(post.provider).toBe("expert"); expect(post.opts).toMatchObject({ model: "explicit-fable", tools: false, maxTurns: 1, timeout: 0 });
      expect(post.messages[0].content).toContain(`INSTRUCTIONS_${domain}`);
      expect(post.messages[1].content).toContain(domain === "compatibility" ? "DOMAIN_COMPAT" : "DOMAIN_TEST");
      expect(post.messages[1].content).not.toContain(domain === "compatibility" ? "DOMAIN_TEST" : "DOMAIN_COMPAT");
    }
    await a.dispatch("worker", "Continue", undefined, { messageId: "A2" }); await runtime.learningSettled();
    const central = f.calls.filter(call => call.phase === "central").at(-1)!;
    expect(JSON.stringify(central.messages)).toContain("PRIVATE_compatibility"); expect(JSON.stringify(central.messages)).toContain("PRIVATE_testing");
    expect(JSON.stringify(central.messages)).not.toContain("OWNED_compatibility_REASON"); expect(JSON.stringify(first.meta?.injection)).toBe(frozen);
    const advice = f.calls.filter(call => call.phase === "pre" && call.opts.threadId?.endsWith(":domain:compatibility")).at(-1)!;
    expect(advice.opts).toMatchObject({ model: "explicit-fable", tools: false, maxTurns: 1 });
    expect(JSON.stringify(advice.messages)).toContain("PRIVATE_compatibility"); expect(JSON.stringify(advice.messages)).not.toContain("PRIVATE_testing");
    const b = f.factory.create("B", { projectId: "Q" });
    for (const lib of f.manager.get(b.id)!.domainLibrarians.values()) expect(lib.threadKnowledge.content).toBe("");
    await b.dispatch("worker", "Unrelated work"); await f.manager.get(b.id)!.learningSettled();
    const unrelatedInput = f.calls.find(call => call.phase === "central" && call.opts.threadId === "B")!;
    expect(JSON.stringify(unrelatedInput.messages)).not.toContain("PRIVATE_compatibility");
    expect(JSON.stringify(unrelatedInput.messages)).not.toContain("PRIVATE_testing");
    expect(JSON.stringify(first.meta?.injection)).toBe(frozen);
    expect(f.stack.getLayer("thread-knowledge:compatibility")).toBeUndefined();
    const snapshot = journal.knowledge("A")!; const callCount = f.calls.length;
    await f.close(); journal.close(); journal = new LocalSessionStore(join(dir, "sessions.sqlite"));
    f = setup(await new ConfigStore(dir).load(), journal); const restored = f.factory.create("A", { projectId: "P" });
    expect(f.calls).toHaveLength(0); expect(callCount).toBeGreaterThan(0);
    for (const d of ["compatibility", "testing"]) expect(f.manager.get("A")!.knowledgeSnapshot().domains[d]).toEqual(snapshot.domains[d]);
    expect(restored.stack.getLayer("thread-knowledge:compatibility")!.content).toContain("PRIVATE_compatibility");
    expect(await readFile(join(dir, "settings.json"), "utf8")).toBe(savedBytes);
  } finally { await f?.close(); journal?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("project-only/override/disabled definitions use resolved sources and profiles without affecting another project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "e1-project-resolution-"));
  const c = config();
  c.learning = { review: { provider: "phase", model: "explicit-review", maxTokens: 1700, thinking: "high" } };
  c.projects.P = { id: "P", path: "/controlled/P", agents: { "compatibility-expert": { model: "project-fable", prompt: "PROJECT_INSTRUCTIONS" } },
    sources: { "compatibility-source": { ...c.sources["compatibility-source"], uri: "PROJECT_COMPAT_KNOWLEDGE" } } };
  c.projects.Q = { id: "Q", path: "/controlled/Q", agents: { "compatibility-expert": { enabled: false }, "testing-expert": {
    ...expert("testing"), browser: undefined, condition: undefined, visibleLayers: { replace: ["testing-reference"] }, ownedLayers: { replace: ["testing-reference"] }, peers: { replace: [] } } },
    layers: { "compatibility-reference": { enabled: false }, "testing-reference": { id: "testing-reference", domain: "testing", segment: "domain-knowledge", enabled: true,
      sourceIds: { replace: ["testing-source"] }, writers: { replace: ["testing-expert"] }, prompt: "Project testing", staleness: 0 } },
    sources: { "testing-source": { id: "testing-source", label: "Project testing", type: "inline", uri: "ONLY_Q_TEST_KNOWLEDGE", enabled: true } } };
  let f: ReturnType<typeof setup> | undefined;
  try {
    const store = new ConfigStore(dir); await store.save(c);
    const saved = await new ConfigStore(dir).load(); f = setup(saved);
    // Factory holds its saved snapshot; a later source object edit is not a live replacement.
    saved.agents["compatibility-expert"].prompt = "MUTATED_AFTER_CONSTRUCTION";
    const p = f.factory.create("P-thread", { projectId: "P" }), q = f.factory.create("Q-thread", { projectId: "Q" }), g = f.factory.create("global-thread");
    expect([...f.manager.get(p.id)!.domainLibrarians.keys()]).toEqual(["compatibility"]);
    expect([...f.manager.get(q.id)!.domainLibrarians.keys()]).toEqual(["testing"]);
    expect(q.stack.getLayer("compatibility-reference")).toBeUndefined(); expect(p.stack.getLayer("testing-reference")).toBeUndefined();
    for (const thread of [p, q, g]) { await thread.dispatch("worker", "Work"); await f.manager.get(thread.id)!.learningSettled(); }
    const pre = f.calls.find(call => call.phase === "pre" && call.opts.threadId?.startsWith(p.id))!;
    expect(pre.provider).toBe("expert"); expect(pre.opts.model).toBe("project-fable"); expect(pre.messages[0].content).toContain("PROJECT_INSTRUCTIONS");
    expect(JSON.stringify(pre.messages)).toContain("PROJECT_COMPAT_KNOWLEDGE"); expect(JSON.stringify(pre.messages)).not.toContain("ONLY_Q_TEST_KNOWLEDGE");
    const post = f.calls.find(call => call.phase === "post" && call.opts.threadId?.startsWith(p.id))!;
    expect(post.provider).toBe("phase"); expect(post.opts).toMatchObject({ model: "explicit-review", thinking: "high", maxTokens: 1700, tools: false });
    const global = f.calls.find(call => call.phase === "pre" && call.opts.threadId?.startsWith(g.id))!;
    expect(global.opts.model).toBe("explicit-fable"); expect(JSON.stringify(global.messages)).toContain("DOMAIN_COMPAT");
    expect(JSON.stringify(global.messages)).not.toContain("MUTATED_AFTER_CONSTRUCTION");
    expect(resolveProjectView(c, "P")!.config.learning).toEqual(c.learning);
  } finally { await f?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("configured review pending does not block Continue or create another same-domain review", async () => {
  let release!: (value: string) => void; const held = new Promise<string>(resolve => { release = resolve; });
  const f = setup(config(), undefined, () => held);
  try {
    const t = f.factory.create("pending"), runtime = f.manager.get(t.id)!;
    await t.dispatch("worker", "Work");
    const next = await Promise.race([t.dispatch("worker", "Continue"), Bun.sleep(200).then(() => { throw Error("Central waited for expert review"); })]);
    expect((next.meta?.delivery as { learningBarrier?: unknown })?.learningBarrier).toMatchObject({ outcome: "pending", waitedMs: 0 });
    expect(f.calls.filter(c => c.phase === "post")).toHaveLength(1);
    expect(JSON.stringify(next.meta?.injection)).not.toContain("PENDING_FACT");
    release(JSON.stringify({ decision: "learn", knowledge: "PENDING_FACT", facts: [] })); await runtime.learningSettled();
    await t.dispatch("worker", "Continue"); await runtime.learningSettled();
    expect(JSON.stringify(f.calls.filter(c => c.phase === "central").at(-1)?.messages)).toContain("PENDING_FACT");
    expect(JSON.stringify(next.meta?.injection)).not.toContain("PENDING_FACT");
  } finally { release('{"decision":"abstain"}'); await f.close(); }
});

for (const state of ["disabled-agent", "disabled-layer", "passive", "generated"] as const) test(`${state} cannot resurrect a configured or built-in expert`, async () => {
  const c = config(); c.agents = { worker: c.agents.worker, "security-expert": expert("security", "security-expert", "security") };
  c.layers = { security: { ...c.layers["compatibility-reference"], id: "security", domain: "security", writers: ["security-expert"] } };
  if (state === "disabled-agent") c.agents["security-expert"].enabled = false;
  if (state === "disabled-layer") c.layers.security.enabled = false;
  if (state === "passive" || state === "generated") { delete c.agents["security-expert"]; delete c.layers.security.writers; }
  if (state === "generated") c.layers.security.segment = "thread-knowledge";
  const f = setup(c); try { const t = f.factory.create(state); expect(f.manager.get(t.id)!.domainLibrarians.size).toBe(0); expect(f.calls).toHaveLength(0); }
  finally { await f.close(); }
});

for (const [label, mutate] of [
  ["duplicate-domain", (c: FoundryConfig) => { c.agents.duplicate = { ...expert(), id: "duplicate" }; }],
  ["foreign-writer", (c: FoundryConfig) => { c.layers["compatibility-reference"].writers = ["somebody-else"]; }],
  ["multiple-writers", (c: FoundryConfig) => { c.layers["compatibility-reference"].writers!.push("worker"); }],
  ["conflicting-owner", (c: FoundryConfig) => { c.agents.worker.ownedLayers = ["compatibility-reference"]; }],
  ["multiple-layers", (c: FoundryConfig) => { c.layers.extra = { ...c.layers["compatibility-reference"], id: "extra" }; }],
  ["foreign-domain", (c: FoundryConfig) => { c.layers["compatibility-reference"].domain = "testing"; }],
  ["generated-owner", (c: FoundryConfig) => { c.layers["compatibility-reference"].segment = "thread-knowledge"; }],
  ["tool-policy", (c: FoundryConfig) => { c.agents["compatibility-expert"].tools = true; }],
  ["foreign-visible-context", (c: FoundryConfig) => { c.agents["compatibility-expert"].visibleLayers.push("another-expert"); }],
  ["invalid-thinking", (c: FoundryConfig) => { c.agents["compatibility-expert"].thinking = "unsupported" as never; }],
  ["invalid-timeout", (c: FoundryConfig) => { c.agents["compatibility-expert"].timeout = 0; }],
  ["invalid-enable", (c: FoundryConfig) => { c.agents["compatibility-expert"].enabled = "false" as never; }],
] as const) test(`reject ${label} before any partial runtime attachment`, () => {
  const c = config(); mutate(c); let calls = 0, binds = 0;
  const stack = new ContextStack([new ContextLayer({ id: "compatibility-reference" })]), t = new Thread("invalid", stack);
  const manager = new ThreadRuntimeManager({ config: c, llm: { id: "expert", complete: async () => { calls++; throw Error("No send permitted"); } },
    sessionAdapter: { runtime: "controlled", bindSignals() { binds++; return () => {}; }, createSession: async () => { throw Error("No process permitted"); }, getExternalSessionId: async () => null, clearSession: async () => {} } });
  try { expect(() => manager.attach(t)).toThrow(); expect(manager.runtimes.size).toBe(0); expect(manager.stacks.size).toBe(0);
    expect(stack.layers.map(l => l.id)).toEqual(["compatibility-reference"]); expect(calls).toBe(0); expect(binds).toBe(0); }
  finally { t.dispose(); manager.disposeAll(); }
});

test("missing provider and unsupported actual native profiles are refused before native construction", async () => {
  for (const mode of ["missing", "codex", "claude-thinking"] as const) {
    const c = config(); let creates = 0; const id = mode === "claude-thinking" ? "claude-code" : "codex";
    const native = new SessionBackedProvider({ id, defaultModel: "explicit-model", adapter: { runtime: id,
      createSession: async () => { creates++; throw Error("No native construction permitted"); }, getExternalSessionId: async () => null, clearSession: async () => {} } });
    c.agents["compatibility-expert"].provider = mode === "missing" ? "absent" : id;
    if (mode === "claude-thinking") c.agents["compatibility-expert"].thinking = "high";
    const f = setup(c, undefined, undefined, native);
    try { expect(() => f.factory.create("unsupported")).toThrow(); expect(creates).toBe(0); expect(f.calls).toHaveLength(0); expect(f.manager.runtimes.size).toBe(0); }
    finally { await f.close(); }
  }
});

test("legacy built-in docs prompt remains an explicit default only when ownership metadata is absent", () => {
  const c = config(); c.agents = { worker: c.agents.worker }; c.layers = {};
  const layer = new ContextLayer({ id: "docs" }); layer.set("LEGACY_DOCS");
  const manager = new ThreadRuntimeManager({ config: c, llm: { id: "flow", complete: async () => { throw Error("No inspection model call"); } },
    legacyDomains: [{ domain: "docs", layerId: "docs", advisePrompt: DOCS_ADVISE_PROMPT, guardTriggers: [] }], log() {}, warn() {} });
  const thread = new Thread("legacy", new ContextStack([layer]));
  try { expect(manager.attach(thread).domainLibrarians.get("docs")!.advisePrompt).toBe(DOCS_ADVISE_PROMPT); }
  finally { thread.dispose(); manager.disposeAll(); }
});

test("an explicit built-in expert retains its guard triggers without replacing its configured instructions", async () => {
  const c = config(); c.agents = { worker: c.agents.worker, "security-expert": expert("security", "security-expert", "security") };
  c.layers = { security: { ...c.layers["compatibility-reference"], id: "security", domain: "security", writers: ["security-expert"] } };
  const f = setup(c);
  try {
    const thread = f.factory.create("security-guard"), lib = f.manager.get(thread.id)!.domainLibrarians.get("security")!;
    expect(lib.shouldGuard("Write")).toBe(true); expect(lib.shouldGuard("Bash")).toBe(true);
    expect(lib.advisePrompt).toContain("INSTRUCTIONS_security"); expect(lib.reviewPrompt).toContain("INSTRUCTIONS_security"); expect(f.calls).toHaveLength(0);
  } finally { await f.close(); }
});

test("metadata-only/generated layers and a conflicting generated ID never silently become legacy expert state", () => {
  for (const generated of [false, true]) {
    const c = config(); c.layers = {}; c.agents = { worker: c.agents.worker };
    const layer = new ContextLayer({ id: "security", ...(generated ? { segment: "thread-knowledge" as const } : { definition: { id: "security", domain: "security" } }) });
    const manager = new ThreadRuntimeManager({ config: c, llm: { id: "flow", complete: async () => { throw Error("No call allowed"); } }, log() {}, warn() {} });
    const t = new Thread("passive", new ContextStack([layer]));
    try { expect(manager.attach(t).domainLibrarians.size).toBe(0); }
    finally { t.dispose(); manager.disposeAll(); }
  }
  const c = config(); const stack = new ContextStack([new ContextLayer({ id: "compatibility-reference" }), new ContextLayer({ id: "thread-knowledge:compatibility" })]);
  const t = new Thread("collision", stack); const manager = new ThreadRuntimeManager({ config: c, llm: { id: "expert", complete: async () => { throw Error("No call allowed"); } } });
  try { expect(() => manager.attach(t)).toThrow("Generated expert layer already exists"); expect(manager.runtimes.size).toBe(0); expect(stack.layers).toHaveLength(2); }
  finally { t.dispose(); manager.disposeAll(); }
});
