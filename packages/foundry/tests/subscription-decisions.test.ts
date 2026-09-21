import { ContextStack, EventStream, type LLMProvider } from "@inixiative/foundry-core";
import { starterConfig, defaultProjectAgents } from "../src/viewer/config";
import { ThreadFactory, buildLayers, buildAgents, type SourceResolver } from "../src/agents/thread-factory";
import { ThreadRuntimeManager } from "../src/agents/thread-runtime";
import { LocalSessionStore } from "../src/persistence/local-session-store";
import { KnowledgePersistence } from "../src/persistence/knowledge-persistence";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeEvidence, NativeOwner } from "@inixiative/foundry-core";
import { buildNativeTextProvider } from "../src/providers/native-text-provider";
import { buildSubscriptionDecisions, type SubscriptionDecisionConfig } from "../src/providers/subscription-decisions";
import { scopedProvider } from "../src/agents/thread-runtime";
import { subscriptionTransport } from "./helpers/subscription-transport";

const roots: string[] = [];
afterEach(async () => { await Bun.sleep(10); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(transport = subscriptionTransport(), timeout = 2000) {
  const directory = mkdtempSync(join(tmpdir(), "subscription-decisions-")); roots.push(directory);
  const profileDirectory = join(directory, "profile"); mkdirSync(profileDirectory, { mode: 0o700 });
  const config: SubscriptionDecisionConfig = { directory, source: { id: crypto.randomUUID(), connectionId: crypto.randomUUID(), runtime: "claude", mode: "native-profile", profileDirectory },
    model: "test-model", expectedObservedModel: "test-model", maxCalls: 20, maxQueued: 5, callTimeoutMs: timeout };
  const run = buildSubscriptionDecisions(config, cfg => buildNativeTextProvider(cfg, transport));
  return { ...run, config, transport };
}
const messages = [{ role: "user" as const, content: "private-input" }];
const owner: NativeOwner = { threadId: "T", generation: "G", dispatchId: "D", projectId: "P", reviewJobId: "R" };
const until = async (check: () => boolean) => { for (let n = 0; !check(); n++) { if (n > 100) throw Error("Controlled condition missing"); await Bun.sleep(5); } };

test("serial native decisions preserve scoped logical ownership and accept only settled isolated output", async () => {
  const f = fixture(), observed: NativeEvidence[] = [];
  const phase = scopedProvider(f.provider, { threadId: "T:aux:review:G:domain:docs", cwd: "/logical/project" });
  const first = phase.complete(messages, { nativeObservation: { owner, register(e) { observed.push(e); }, observe(e) { observed.push(e); } } });
  const second = f.provider.complete(messages, { threadId: "T:aux:route" });
  const [result] = await Promise.all([first, second]);
  expect(f.transport.launches).toHaveLength(2);
  expect(f.transport.launches.every(p => p.exited)).toBe(true);
  expect(f.transport.launches.every(p => p.cwd !== "/logical/project" && p.argv.includes("--safe-mode"))).toBe(true);
  expect(result.native?.owner?.providerSessionKey).toBe("T:aux:review:G:domain:docs");
  const evidence = result.native!;
  expect(await phase.completionLifecycle!.inspectOwnedAdmission!(evidence.owner!, evidence.admissionId!)).toMatchObject({ capacity: "settled", cleanup: "released", evidence: { content: "accepted-private-answer" } });
  expect(await f.provider.completionLifecycle!.inspectOwnedAdmission!({ ...evidence.owner!, projectId: "foreign" }, evidence.admissionId!)).toBeUndefined();
  expect(await f.provider.completionLifecycle!.releaseOwnedAdmission!({ ...evidence.owner!, dispatchId: "foreign" }, evidence.admissionId!)).toBe("unavailable");
  expect(observed[0].nativeOutcome).toBe("unknown");
  expect(observed[0].content).toBeUndefined();
  expect(observed.at(-1)?.nativeOutcome).toBe("completed");
  for (const child of readdirSync(f.config.directory).filter(p => p !== "profile")) {
    const report = readFileSync(join(f.config.directory, child, "native-text.json"), "utf8");
    expect(report).not.toContain("private-input"); expect(report).not.toContain("accepted-private-answer");
  }
  f.close();
});

for (const bad of ["model", "tool"] as const) test(`${bad} violation never exposes a promotable learning answer`, async () => {
  const f = fixture(subscriptionTransport(bad === "model" ? { model: "wrong-model" } : { tool: true }));
  let registration: NativeEvidence | undefined;
  const observed: NativeEvidence[] = [];
  await expect(f.provider.complete(messages, { threadId: "T:aux:review:G:domain:docs", nativeObservation: { owner, register(e) { registration = e; }, observe(e) { observed.push(e); } } })).rejects.toThrow("failed");
  expect(observed).toHaveLength(0);
  const inspection = await f.provider.completionLifecycle!.inspectOwnedAdmission!(registration!.owner!, registration!.admissionId!);
  expect(inspection?.evidence.content).toBeUndefined();
  expect(inspection?.evidence.nativeOutcome).toBe("unknown");
  expect(f.snapshot().closed).toBe(true);
});

test("queued expiry and revocation prevent a second native launch", async () => {
  let finish!: (value: string) => void;
  const f = fixture(subscriptionTransport({ response: () => new Promise(resolve => { finish = resolve; }) }));
  const first = f.provider.complete(messages);
  await until(() => f.transport.writes === 1);
  const queued = f.provider.complete(messages, { timeout: 100 }).catch(error => error);
  const error = await queued;
  expect(error).toBeInstanceOf(Error);
  expect(f.provider.completionLifecycle!.admission!({ error })).toBe("not-admitted");
  expect(f.provider.completionLifecycle!.settlement({ error })).toBe("settled");
  const revoked = f.provider.complete(messages).catch(error => error);
  f.close(); finish("done");
  expect(await revoked).toBeInstanceOf(Error);
  await expect(first).rejects.toThrow("failed");
  expect(f.transport.launches).toHaveLength(1);
});

test("prewrite rechecks the original logical preflight and old release cannot touch another call", async () => {
  const f = fixture();
  const result = await f.provider.complete(messages);
  const original = result.native!;
  let checks = 0;
  await expect(f.provider.complete(messages, { threadId: "T:aux:review:G:domain:docs", nativeObservation: { owner,
    preflight() { if (++checks > 1) throw Error("revoked while preparing"); }, register() {}, observe() {},
  } })).rejects.toThrow("failed");
  expect(f.transport.writes).toBe(1);
  expect(await f.provider.completionLifecycle!.releaseOwnedAdmission!(original.owner!, original.admissionId!)).toBe("released");
  f.close();
});

test("tool and model overrides fail before any subprocess", async () => {
  const f = fixture();
  for (const options of [{ tools: true }, { model: "other" }, { maxTurns: 2 }]) await expect(f.provider.complete(messages, options)).rejects.toThrow("refused");
  expect(f.transport.launches).toHaveLength(0);
  expect(f.snapshot().attempts).toBe(0);
  f.close();
});

test("actual factory classification, routing, advice, guard and learning use the subscription lifecycle and retain private thread knowledge", async () => {
  const f = fixture(subscriptionTransport({ response: () => JSON.stringify({ category: "feature", destination: "worker", contextSlice: ["docs"], layers: ["docs"], domains: ["docs"], snippets: [], confidence: 1,
    findings: [], decision: "learn", knowledge: "Accepted private thread knowledge", facts: [] }) }));
  const c = starterConfig("central", "worker-model");
  c.agents = { worker: { id: "worker", kind: "executor", provider: "central", model: "worker-model", prompt: "Do work", visibleLayers: [], peers: [], maxDepth: 1, enabled: true },
    expert: { id: "expert", kind: "decider", flowRole: "domain-advising", domain: "docs", provider: f.provider.id, model: "test-model", tools: false,
      prompt: "Assess the supplied documentation", visibleLayers: ["docs"], ownedLayers: ["docs"], peers: [], maxDepth: 1, enabled: true, guardTriggers: ["Write"] } };
  const defaults = defaultProjectAgents("central", "worker-model", f.provider.id, "test-model");
  c.agents.classifier = { ...defaults.classifier, visibleLayers: ["docs"] };
  c.agents.router = { ...defaults.router, visibleLayers: ["docs"] };
  c.layers = { docs: { id: "docs", domain: "docs", prompt: "Domain rules", segment: "domain-knowledge", writers: ["expert"], sourceIds: ["docs-source"], enabled: true, staleness: 0 } };
  c.sources = { "docs-source": { id: "docs-source", label: "Docs", type: "inline", uri: "Keep unrelated files intact", enabled: true } };
  c.projects = { P: { id: "P", path: f.config.directory }, Q: { id: "Q", path: f.config.directory } };
  const sourceResolver: SourceResolver = (id, cfg) => ({ id, load: async () => cfg.sources[id].uri });
  const central: LLMProvider = { id: "central", async complete() { return { content: "Completed controlled work", model: "worker-model" }; } };
  const providers = new Map([[central.id, central], [f.provider.id, f.provider]]);
  const stack = new ContextStack(buildLayers(c, { sourceResolver }));
  const events = new EventStream(), journal = new LocalSessionStore(join(f.config.directory, "journal.sqlite"));
  const manager = new ThreadRuntimeManager({ config: c, llm: f.provider, providers, eventStream: events, log() {}, warn() {}, learning: { timeoutMs: 1000, hardTimeoutMs: 3000 } });
  const persistence = new KnowledgePersistence(manager, journal, events, []);
  const deps = { provider: central, providers };
  const factory = new ThreadFactory({ stack, agents: buildAgents(c, stack, deps), runtime: manager, configuration: { config: c, layers: { sourceResolver }, agents: deps } });
  try {
    const thread = factory.create("A", { projectId: "P" }), runtime = manager.get("A")!;
    const beforeRouting = f.transport.launches.length;
    await thread.dispatch("classifier", "Update documentation");
    await thread.dispatch("router", { payload: "Update documentation", classification: { category: "feature" } });
    expect(f.transport.launches.length).toBeGreaterThanOrEqual(beforeRouting + 2);
    await thread.dispatch("worker", "Update documentation", undefined, { messageId: "A1" });
    await runtime.learningSettled();
    const lib = runtime.domainLibrarians.get("docs")!;
    expect(lib.threadKnowledge.content).toBe("Accepted private thread knowledge");
    expect(journal.knowledge("A")!.domains.docs.content).toBe(lib.threadKnowledge.content);
    expect(runtime.learningState.domains.docs.capacity).toBe("settled");
    expect((await lib.guard({ tool: "Write", input: { file: "docs.md" }, output: "updated" })).status).toBe("completed");
    factory.create("B", { projectId: "Q" });
    expect(manager.get("B")!.domainLibrarians.get("docs")!.threadKnowledge.content).toBe("");
    expect(f.transport.launches.length).toBeGreaterThanOrEqual(4);
    expect(f.transport.launches.every(p => p.exited && p.argv.includes("--strict-mcp-config"))).toBe(true);
  } finally { manager.disposeAll(); journal.close(); f.close(); }
});

test("a stalled preflight expires before status or native spawn", async () => {
  const f = fixture();
  const error = await f.provider.complete(messages, { timeout: 100, nativeObservation: { owner, preflight: () => new Promise(() => {}), register() {}, observe() {} } }).catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(f.provider.completionLifecycle!.admission!({ error })).toBe("not-admitted");
  expect(f.provider.completionLifecycle!.settlement({ error })).toBe("settled");
  expect(f.transport.launches).toHaveLength(0);
  expect(f.snapshot().attempts).toBe(0);
  f.close();
});

test("total attempt bounds reject without paid fallback or extra launches", async () => {
  let finish!: (answer: string) => void;
  const transport = subscriptionTransport({ response: () => new Promise(resolve => { finish = resolve; }) });
  const original = fixture(transport);
  original.close();
  const f = buildSubscriptionDecisions({ ...original.config, maxQueued: 1, maxCalls: 1 }, cfg => buildNativeTextProvider(cfg, transport));
  const first = f.provider.complete(messages);
  await until(() => transport.writes === 1);
  await expect(f.provider.complete(messages)).rejects.toThrow("closed or full");
  finish("done"); await first;
  await expect(f.provider.complete(messages)).rejects.toThrow("closed or full");
  expect(transport.launches).toHaveLength(1);
  f.close();
});


test("a stalled final observer cannot retain scheduler capacity", async () => {
  const f = fixture();
  await f.provider.complete(messages, { nativeObservation: { owner, register() {}, observe: () => new Promise(() => {}) } });
  await f.provider.complete(messages);
  expect(f.transport.launches).toHaveLength(2);
  expect(f.snapshot()).toMatchObject({ active: false, queued: 0 });
  f.close();
});

test("queue bound rejects excess waiting calls before native admission", async () => {
  let finish!: (answer: string) => void;
  const transport = subscriptionTransport({ response: () => new Promise(resolve => { finish = resolve; }) });
  const original = fixture(transport); original.close();
  const f = buildSubscriptionDecisions({ ...original.config, maxQueued: 1 }, cfg => buildNativeTextProvider(cfg, transport));
  const first = f.provider.complete(messages);
  await until(() => transport.writes === 1);
  const queued = f.provider.complete(messages).catch(error => error);
  await expect(f.provider.complete(messages)).rejects.toThrow("closed or full");
  expect(f.snapshot().queued).toBe(1);
  f.close(); finish("done");
  expect(await queued).toBeInstanceOf(Error);
  await expect(first).rejects.toThrow("failed");
  expect(transport.launches).toHaveLength(1);
});

test("unproved native process exit closes admission and retains unknown ownership", async () => {
  const original = fixture(subscriptionTransport({ response: () => new Promise(() => {}) }), 250);
  original.close();
  let terminate!: () => void;
  const transport = { ...original.transport, spawn: (...args: Parameters<typeof original.transport.spawn>) => {
    const child = original.transport.spawn(...args); terminate = child.kill;
    return { ...child, kill() {} };
  } };
  const f = buildSubscriptionDecisions(original.config, cfg => buildNativeTextProvider(cfg, transport));
  let registered: NativeEvidence | undefined;
  try {
    const error = await f.provider.complete(messages, { nativeObservation: { owner, register(e) { registered = e; }, observe() {} } }).catch(error => error);
    expect(f.provider.completionLifecycle!.settlement({ error })).toBe("unknown");
    expect(f.snapshot().closed).toBe(true);
    const inspection = await f.provider.completionLifecycle!.inspectOwnedAdmission!(registered!.owner!, registered!.admissionId!);
    expect(inspection).toMatchObject({ capacity: "unknown", cleanup: "unknown" });
    expect(inspection?.evidence.content).toBeUndefined();
    await expect(f.provider.complete(messages)).rejects.toThrow("closed or full");
    expect(original.transport.launches).toHaveLength(1);
  } finally { terminate?.(); f.close(); }
}, 5000);
