import { afterEach, describe, expect, test } from "bun:test";
import {
  ContextLayer,
  ContextStack,
  Executor,
  computeHash,
  newId,
  type CompletionOpts,
  type LLMMessage,
  type LLMProvider,
  type Signal,
} from "@inixiative/foundry-core";
import { ThreadFactory, buildAgents } from "../src/agents/thread-factory";
import { ThreadRuntimeManager, type ThreadRuntimeDeps } from "../src/agents/thread-runtime";
import type { InjectionPlan } from "../src/agents/flow-orchestrator";
import { starterConfig } from "../src/viewer/config";

// G3b: per-domain thread knowledge and causal post-work learning.
//
// Each domain owns three segments: its configured instructions, its configured
// domain knowledge (cache layer), and its own understanding of this thread
// (a generated, thread-private knowledge layer). Completed executor work is
// reviewed by every domain through a text-only auxiliary; a learned fact
// appears in a later revision and reaches the next provider input without the
// user repeating it. Learning never crosses threads, projects, or the template.

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Reviewer = (messages: LLMMessage[], threadId: string) => Promise<string> | string;

interface SetupOpts {
  domains?: string[];
  reviewers?: Record<string, Reviewer>;
  learning?: ThreadRuntimeDeps["learning"];
}

const LEARN = (text: string) => JSON.stringify({ decision: "learn", knowledge: text, facts: [text], reason: "observed in completed work" });
const ABSTAIN = JSON.stringify({ decision: "abstain", reason: "nothing new" });

function setup(opts: SetupOpts = {}) {
  const domains = opts.domains ?? ["security"];
  const config = starterConfig("mock", "mock");
  config.agents = { worker: { id: "worker", kind: "executor", provider: "mock", model: "mock",
    prompt: "Execute", temperature: 0, maxTokens: 256, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
  const layers = domains.map((d) => {
    const layer = new ContextLayer({ id: d, prompt: `Configured ${d} instructions` });
    layer.set(`CONFIGURED-${d}-KNOWLEDGE`);
    return layer;
  });
  const template = new ContextStack(layers);
  const providerInputs: LLMMessage[][] = [];
  const provider: LLMProvider = { id: "mock", complete: async (messages) => {
    providerInputs.push(structuredClone(messages));
    return { model: "mock", content: "WORK-OUTPUT: done" };
  } };
  const reviewCalls: Array<{ domain: string; messages: LLMMessage[] }> = [];
  const flowLlm: LLMProvider = { id: "flow", complete: async (messages, callOpts?: CompletionOpts) => {
    const id = callOpts?.threadId ?? "";
    if (id.endsWith(":cartographer")) {
      return { model: "mock", content: JSON.stringify({ domains, layers: domains, confidence: 1 }) };
    }
    const domain = domains.find((d) => id.endsWith(`:domain:${d}`)) ?? "unknown";
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    if (user.includes("## Completed work")) {
      reviewCalls.push({ domain, messages: structuredClone(messages) });
      const reviewer = opts.reviewers?.[domain];
      const content = reviewer ? await reviewer(messages, id.split(":aux:")[0]) : ABSTAIN;
      return { model: "mock", content };
    }
    return { model: "mock", content: JSON.stringify({ layers: [domain], snippets: [`ADVICE-${domain}`], confidence: 1 }) };
  } };
  const runtime = new ThreadRuntimeManager({
    config, log: () => {}, warn: () => {},
    domains: domains.map((d) => ({ domain: d, layerId: d, guardTriggers: [] })),
    llm: flowLlm,
    learning: opts.learning,
  });
  cleanups.push(() => runtime.disposeAll());
  const factory = new ThreadFactory({ stack: template, agents: buildAgents(config, template, { provider }), runtime });
  return { config, template, runtime, factory, providerInputs, reviewCalls, provider };
}

const planOf = (result: { meta?: Record<string, unknown> }) =>
  (result.meta?.injection as { plan?: InjectionPlan } | undefined)?.plan!;

describe("per-domain thread knowledge and causal learning", () => {
  test("fixed-context comparison retains advice but admits no learning reviews", async () => {
    const { runtime, factory, reviewCalls, providerInputs } = setup({ learning: { enabled: false }, reviewers: { security: () => LEARN("FORBIDDEN-LEARNING") } });
    const thread = factory.create("fixed", { projectId: "P" });
    const first = await thread.dispatch("worker", "Set up auth");
    await runtime.get("fixed")!.learningSettled();
    await thread.dispatch("worker", "Continue");
    expect(planOf(first).contributions[0].segments.instructions).toContain("security domain advisor");
    expect(JSON.stringify(providerInputs)).toContain("ADVICE-security");
    expect(reviewCalls).toHaveLength(0);
    expect(runtime.get("fixed")!.domainLibrarians.get("security")!.threadKnowledge.revision).toBe(0);
    expect(JSON.stringify(providerInputs)).not.toContain("FORBIDDEN-LEARNING");
  });
  test("a fact learned from completed work reaches the next provider input without the user repeating it", async () => {
    const { runtime, factory, providerInputs } = setup({
      reviewers: { security: () => LEARN("LEARNED-SENTINEL: this thread stores tokens in httpOnly cookies") },
    });
    const thread = factory.create("a", { projectId: "P" });
    const owned = runtime.get("a")!;

    const first = await thread.dispatch("worker", "Set up auth");
    const firstPlan = planOf(first);
    expect(firstPlan.contributions[0].segments.threadKnowledge).toBe("");
    expect(firstPlan.contributions[0].provenance.threadKnowledgeRevision).toBe(0);
    expect(JSON.stringify(providerInputs[0])).not.toContain("LEARNED-SENTINEL");

    await owned.learningSettled();
    const security = owned.domainLibrarians.get("security")!;
    expect(security.threadKnowledge.revision).toBe(1);
    expect(security.threadKnowledge.content).toContain("LEARNED-SENTINEL");
    expect(security.threadKnowledge.history.at(-1)).toMatchObject({ decision: "learned", revision: 1, author: "security-reviewer" });
    expect(security.threadKnowledge.history.at(-1)!.evidence).toMatchObject({ kind: "dispatch", agentId: "worker" });

    const second = await thread.dispatch("worker", "Continue");
    expect(JSON.stringify(providerInputs[1])).toContain("LEARNED-SENTINEL");
    const secondPlan = planOf(second);
    expect(secondPlan.contributions[0].segments.threadKnowledge).toContain("LEARNED-SENTINEL");
    expect(secondPlan.contributions[0].provenance.threadKnowledgeRevision).toBe(1);
    // The first turn's sealed artifact never gains the later fact.
    expect(firstPlan.contributions[0].segments.threadKnowledge).toBe("");
    expect(JSON.stringify(providerInputs[0])).not.toContain("LEARNED-SENTINEL");
  });

  test("segments are domain-specific: instructions, configured knowledge and this domain's own thread understanding", async () => {
    const { runtime, factory } = setup({
      domains: ["security", "docs"],
      reviewers: { security: () => LEARN("SECURITY-LEARNED"), docs: () => ABSTAIN },
    });
    const thread = factory.create("a", { projectId: "P" });
    const owned = runtime.get("a")!;
    await thread.dispatch("worker", "Do work");
    await owned.learningSettled();

    const security = owned.domainLibrarians.get("security")!;
    const docs = owned.domainLibrarians.get("docs")!;
    expect(security.threadKnowledge.content).toContain("SECURITY-LEARNED");
    expect(docs.threadKnowledge.content).toBe("");
    expect(docs.threadKnowledge.revision).toBe(0);
    expect(docs.threadKnowledge.history.at(-1)).toMatchObject({ decision: "abstain" });

    const plan = planOf(await thread.dispatch("worker", "Next"));
    const byDomain = Object.fromEntries(plan.contributions.map((c) => [c.domain, c]));
    expect(byDomain.security.segments.instructions).toContain("security");
    expect(byDomain.security.segments.domainKnowledge).toBe("CONFIGURED-security-KNOWLEDGE");
    expect(byDomain.security.segments.threadKnowledge).toContain("SECURITY-LEARNED");
    expect(byDomain.docs.segments.domainKnowledge).toBe("CONFIGURED-docs-KNOWLEDGE");
    expect(byDomain.docs.segments.threadKnowledge).toBe("");
    // Not the global Librarian thread-state string.
    expect(byDomain.security.segments.threadKnowledge).not.toBe(owned.librarian.layer.content);
    // Configured knowledge is untouched by learning; the generated layer is separate and thread-private.
    expect(security.cache.content).toBe("CONFIGURED-security-KNOWLEDGE");
    expect(thread.stack.getLayer("thread-knowledge:security")).toBe(security.threadKnowledge.layer);
  });

  test("learning never reaches another thread, another project, or the template", async () => {
    // Only thread A's reviewer learns; B and C abstain, so anything they
    // carry must have leaked from A.
    const { runtime, factory, providerInputs, template } = setup({
      reviewers: { security: (_messages, threadId) => (threadId === "a" ? LEARN("PRIVATE-A-LEARNING") : ABSTAIN) },
    });
    const a = factory.create("a", { projectId: "P" });
    const b = factory.create("b", { projectId: "P" });
    const c = factory.create("c", { projectId: "Q" });
    await a.dispatch("worker", "learn something");
    await runtime.get("a")!.learningSettled();
    expect(runtime.get("a")!.domainLibrarians.get("security")!.threadKnowledge.revision).toBe(1);

    await b.dispatch("worker", "b turn");
    await c.dispatch("worker", "c turn");
    await runtime.get("b")!.learningSettled();
    await runtime.get("c")!.learningSettled();
    expect(JSON.stringify(providerInputs[1])).not.toContain("PRIVATE-A-LEARNING");
    expect(JSON.stringify(providerInputs[2])).not.toContain("PRIVATE-A-LEARNING");
    expect(runtime.get("b")!.domainLibrarians.get("security")!.threadKnowledge.content).toBe("");
    expect(runtime.get("c")!.domainLibrarians.get("security")!.threadKnowledge.content).toBe("");
    expect(template.getLayer("thread-knowledge:security")).toBeUndefined();
    expect(template.getLayer("security")!.content).toBe("CONFIGURED-security-KNOWLEDGE");

    const later = factory.create("later", { projectId: "P" });
    expect(later.stack.getLayer("thread-knowledge:security")!.content).toBe("");
  });

  test("the same observation is never reviewed or written twice", async () => {
    const { runtime, factory, reviewCalls } = setup({
      reviewers: { security: () => LEARN("ONCE") },
    });
    const thread = factory.create("a", { projectId: "P" });
    const owned = runtime.get("a")!;
    const seen: Signal[] = [];
    thread.signals.on("dispatch", (s) => { seen.push(s); });
    await thread.dispatch("worker", "work");
    await owned.learningSettled();
    expect(reviewCalls.filter((r) => r.domain === "security")).toHaveLength(1);

    // Replay the exact same observation (same signal id).
    await thread.signals.emit(seen[0]);
    await owned.learningSettled();
    expect(reviewCalls.filter((r) => r.domain === "security")).toHaveLength(1);
    expect(owned.domainLibrarians.get("security")!.threadKnowledge.revision).toBe(1);
    expect(owned.domainLibrarians.get("security")!.threadKnowledge.history.filter((h) => h.decision === "learned")).toHaveLength(1);
  });

  test("failed work is recorded explicitly and never promoted into knowledge", async () => {
    const { runtime, factory, reviewCalls, config, template } = setup({
      reviewers: { security: () => LEARN("SHOULD-NOT-LEARN") },
    });
    const thread = factory.create("a", { projectId: "P" });
    thread.register(new Executor({ id: "worker", stack: thread.stack, handler: async () => { throw new Error("build failed"); } }));
    const owned = runtime.get("a")!;
    await expect(thread.dispatch("worker", "break")).rejects.toThrow("build failed");
    await owned.learningSettled();

    const knowledge = owned.domainLibrarians.get("security")!.threadKnowledge;
    expect(reviewCalls).toHaveLength(0);
    expect(knowledge.revision).toBe(0);
    expect(knowledge.history.at(-1)!.decision).toBe("rejected");
    expect(knowledge.history.at(-1)!.reason).toContain("failed");
    expect(knowledge.history.at(-1)!.evidence).toMatchObject({ kind: "dispatch", ok: false });
    void config; void template;
  });

  test("a malformed or oversized model update is recorded as invalid and mutates nothing", async () => {
    let call = 0;
    const { runtime, factory } = setup({
      learning: { maxKnowledgeChars: 40 },
      reviewers: { security: () => (++call === 1 ? "this is not json at all" : LEARN("x".repeat(500))) },
    });
    const thread = factory.create("a", { projectId: "P" });
    const owned = runtime.get("a")!;
    await thread.dispatch("worker", "one");
    await owned.learningSettled();
    await thread.dispatch("worker", "two");
    await owned.learningSettled();

    const knowledge = owned.domainLibrarians.get("security")!.threadKnowledge;
    expect(knowledge.revision).toBe(0);
    expect(knowledge.content).toBe("");
    const decisions = knowledge.history.map((h) => h.decision);
    expect(decisions).toEqual(["invalid", "invalid"]);
    expect(knowledge.history[1].reason).toContain("40");
  });

  test("a hard-expired review is explicit and its late answer cannot mutate state or release admission", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    cleanups.push(() => release());
    const { runtime, factory } = setup({
      learning: { timeoutMs: 5, hardTimeoutMs: 15 },
      reviewers: { security: async () => { await held; return LEARN("LATE-LEARNING"); } },
    });
    const thread = factory.create("a", { projectId: "P" });
    const owned = runtime.get("a")!;
    await thread.dispatch("worker", "slow review");
    await owned.learningSettled();

    const knowledge = owned.domainLibrarians.get("security")!.threadKnowledge;
    expect(knowledge.history.at(-1)).toMatchObject({ decision: "expired" });
    expect(knowledge.revision).toBe(0);
    expect(owned.learningOutstanding).toBe(1);

    release();
    await sleep(5);
    expect(knowledge.revision).toBe(0);
    expect(knowledge.content).toBe("");
    expect(owned.learningOutstanding).toBe(0);
    expect(thread.stack.getLayer("thread-knowledge:security")!.content).toBe("");
  });

  test("a review that settles after disposal is discarded and touches no layer", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    cleanups.push(() => release());
    const { runtime, factory } = setup({
      reviewers: { security: async () => { await held; return LEARN("AFTER-DISPOSE"); } },
    });
    const thread = factory.create("a", { projectId: "P" });
    const owned = runtime.get("a")!;
    const security = owned.domainLibrarians.get("security")!;
    await thread.dispatch("worker", "work then dispose");
    expect(owned.learningOutstanding).toBe(1);

    thread.archive();
    expect(owned.disposed).toBe(true);
    expect(thread.stack.getLayer("thread-knowledge:security")).toBeUndefined();

    release();
    await owned.learningSettled();
    expect(security.threadKnowledge.revision).toBe(0);
    expect(security.threadKnowledge.content).toBe("");
    expect(security.threadKnowledge.history.at(-1)!.decision).toBe("discarded");
    expect(security.threadKnowledge.history.at(-1)!.reason).toContain("disposed");
    expect(owned.learningOutstanding).toBe(0);
  });

  test("learning outcomes are observable signals attributed to the thread", async () => {
    const { runtime, factory } = setup({ reviewers: { security: () => LEARN("SIGNALLED") } });
    const thread = factory.create("a", { projectId: "P" });
    const seen: Signal[] = [];
    thread.signals.on("domain_learning", (s) => { seen.push(s); });
    await thread.dispatch("worker", "work");
    await runtime.get("a")!.learningSettled();
    expect(seen).toHaveLength(1);
    expect(seen[0].source).toBe("security-reviewer");
    expect(seen[0].content).toMatchObject({ domain: "security", decision: "learned", revision: 1, evidence: { kind: "dispatch", agentId: "worker" } });
    const activity = runtime.get("a")!.librarian.state.recentActivity.join("\n");
    expect(activity).toContain("security");
    expect(activity).not.toContain("[object Object]");
  });

  test("knowledge state snapshots and restores through a validated API", async () => {
    const { runtime, factory } = setup({ reviewers: { security: () => LEARN("PERSIST-ME") } });
    const thread = factory.create("a", { projectId: "P" });
    const owned = runtime.get("a")!;
    await thread.dispatch("worker", "work");
    await owned.learningSettled();

    const snapshot = owned.knowledgeSnapshot();
    expect(snapshot.threadId).toBe("a");
    // Direct assertions: bun's toMatchObject swaps asymmetric matchers into the
    // received object, which would corrupt the snapshot before restore.
    const security0 = snapshot.domains.security;
    expect(security0.domain).toBe("security");
    expect(security0.revision).toBe(1);
    expect(security0.content).toContain("PERSIST-ME");
    expect(security0.hash).toBe(computeHash(security0.content));
    expect(security0.author).toBe("security-reviewer");
    expect(security0.evidence[0].kind).toBe("dispatch");
    expect(security0.evidence[0].agentId).toBe("worker");
    expect(typeof snapshot.domains.security.updatedAt).toBe("number");

    const { runtime: runtime2, factory: factory2 } = setup();
    const restored = factory2.create("a", { projectId: "P" });
    const owned2 = runtime2.get("a")!;
    owned2.restoreKnowledge(snapshot);
    const security = owned2.domainLibrarians.get("security")!;
    expect(security.threadKnowledge.revision).toBe(1);
    expect(security.threadKnowledge.content).toContain("PERSIST-ME");
    expect(restored.stack.getLayer("thread-knowledge:security")!.content).toContain("PERSIST-ME");
    expect(security.threadKnowledge.history.at(-1)).toMatchObject({ decision: "restored", revision: 1 });

    expect(() => owned2.restoreKnowledge({ ...snapshot, threadId: "someone-else" })).toThrow(/thread/);
    const tampered = structuredClone(snapshot);
    tampered.domains.security.content = "TAMPERED";
    expect(() => owned2.restoreKnowledge(tampered)).toThrow(/hash/);
    const badRevision = structuredClone(snapshot);
    (badRevision.domains.security as { revision: number }).revision = -1;
    expect(() => owned2.restoreKnowledge(badRevision)).toThrow(/revision/);
    expect(security.threadKnowledge.revision).toBe(1);
  });

  test("the immediate dispatch reports pending learning without waiting; the first post-commit dispatch carries the fact", async () => {
    const { runtime, factory, providerInputs } = setup({
      reviewers: { security: async () => { await sleep(25); return LEARN("BARRIER-SENTINEL"); } },
    });
    const thread = factory.create("a", { projectId: "P" });
    await thread.dispatch("worker", "First work");
    const second = await thread.dispatch("worker", "Continue");

    expect(JSON.stringify(providerInputs[1])).not.toContain("BARRIER-SENTINEL");
    const delivery = second.meta?.delivery as { learningBarrier?: { outcome: string; waitedMs: number; pending: Array<{ domain: string; reviews: number }>; stale: string[] } };
    expect(delivery.learningBarrier).toMatchObject({ outcome: "pending", waitedMs: 0, stale: ["security"] });
    expect(delivery.learningBarrier!.pending).toEqual([{ domain: "security", reviews: 1 }]);
    expect(delivery.learningBarrier!.waitedMs).toBeGreaterThanOrEqual(0);
    expect(planOf(second).contributions[0].provenance.threadKnowledgeRevision).toBe(0);
    await runtime.get("a")!.learningSettled();
    await thread.dispatch("worker", "Independent later request");
    expect(JSON.stringify(providerInputs[2])).toContain("BARRIER-SENTINEL");
    expect(planOf(second).contributions[0].provenance.threadKnowledgeRevision).toBe(0);
    await runtime.get("a")!.learningSettled();
  });

  test("a slow review yields an explicit stale barrier outcome and never blocks the turn beyond its bound", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    cleanups.push(() => release());
    const { runtime, factory } = setup({
      learning: { timeoutMs: 1_000, barrierMs: 20 },
      reviewers: { security: async () => { await held; return LEARN("LATE-SENTINEL"); } },
    });
    const thread = factory.create("a", { projectId: "P" });
    await thread.dispatch("worker", "First work");
    const startedAt = Date.now();
    const second = await thread.dispatch("worker", "Continue");
    expect(Date.now() - startedAt).toBeLessThan(500);

    const delivery = second.meta?.delivery as { learningBarrier?: { outcome: string; stale: string[] } };
    expect(delivery.learningBarrier).toMatchObject({ outcome: "pending", waitedMs: 0, stale: ["security"] });
    expect(planOf(second).contributions[0].provenance.threadKnowledgeRevision).toBe(0);

    release();
    await runtime.get("a")!.learningSettled();
    // Both completed turns were reviewed once each, in order, once released.
    const knowledge = runtime.get("a")!.domainLibrarians.get("security")!.threadKnowledge;
    expect(knowledge.revision).toBe(2);
    expect(knowledge.history.filter((h) => h.decision === "learned").map((h) => h.revision)).toEqual([1, 2]);
  });

  test("the barrier never waits on reviews created by the current turn", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    cleanups.push(() => release());
    const { runtime, factory } = setup({
      reviewers: { security: async () => { await held; return ABSTAIN; } },
    });
    const thread = factory.create("a", { projectId: "P" });
    const outcome = await Promise.race([thread.dispatch("worker", "Only turn"), sleep(300).then(() => "blocked" as const)]);
    expect(outcome).not.toBe("blocked");
    const delivery = (outcome as { meta?: { delivery?: { learningBarrier?: { outcome: string } } } }).meta?.delivery;
    expect(delivery?.learningBarrier).toMatchObject({ outcome: "none" });
    expect(runtime.get("a")!.learningOutstanding).toBe(1);
    release();
    await runtime.get("a")!.learningSettled();
  });

  test("independent domains review concurrently while each domain keeps observation order", async () => {
    let releaseSecurity!: () => void;
    const held = new Promise<void>((r) => { releaseSecurity = r; });
    cleanups.push(() => releaseSecurity());
    const started: string[] = [];
    const { runtime, factory } = setup({
      domains: ["security", "docs"],
      learning: { timeoutMs: 1_000, barrierMs: 10 },
      reviewers: {
        security: async (messages) => { started.push("security"); await held; return LEARN(`SEC:${messages.find((m) => m.role === "user")!.content.match(/### Request\n(.*)/)?.[1]}`); },
        docs: async (messages) => { started.push("docs"); return LEARN(`DOCS:${messages.find((m) => m.role === "user")!.content.match(/### Request\n(.*)/)?.[1]}`); },
      },
    });
    const thread = factory.create("a", { projectId: "P" });
    await thread.dispatch("worker", "turn-1");
    await sleep(5);
    expect([...started].sort()).toEqual(["docs", "security"]);
    await thread.dispatch("worker", "turn-2");
    await sleep(5);
    expect(started.filter((s) => s === "docs")).toHaveLength(2);
    expect(started.filter((s) => s === "security")).toHaveLength(1);

    releaseSecurity();
    await runtime.get("a")!.learningSettled();
    const security = runtime.get("a")!.domainLibrarians.get("security")!.threadKnowledge;
    expect(security.history.filter((h) => h.decision === "learned").map((h) => h.revision)).toEqual([1, 2]);
    expect(security.content).toBe("SEC:turn-2");
    expect(runtime.get("a")!.domainLibrarians.get("docs")!.threadKnowledge.content).toBe("DOCS:turn-2");
  });

  test("bundle ownership and shape are validated atomically before any mutation", async () => {
    const { runtime, factory } = setup({ domains: ["security", "docs"], reviewers: { security: () => LEARN("OWNED-BY-P"), docs: () => LEARN("DOCS-P") } });
    const a = factory.create("same-id", { projectId: "P" });
    await a.dispatch("worker", "work");
    await runtime.get("same-id")!.learningSettled();
    const bundle = runtime.get("same-id")!.knowledgeSnapshot();
    expect(bundle.projectId).toBe("P");
    expect(bundle.domains.security.projectId).toBe("P");
    expect(bundle.domains.security.threadId).toBe("same-id");

    const other = setup({ domains: ["security", "docs"] });
    other.factory.create("same-id", { projectId: "Q" });
    const target = other.runtime.get("same-id")!;
    expect(() => target.restoreKnowledge(bundle)).toThrow(/project/);

    const sameProject = setup({ domains: ["security", "docs"] });
    sameProject.factory.create("same-id", { projectId: "P" });
    const ok = sameProject.runtime.get("same-id")!;
    const childOwner = structuredClone(bundle);
    (childOwner.domains.security as { threadId: string }).threadId = "other-thread";
    expect(() => ok.restoreKnowledge(childOwner)).toThrow(/owner/);
    const childProject = structuredClone(bundle);
    (childProject.domains.docs as { projectId?: string }).projectId = "Q";
    expect(() => ok.restoreKnowledge(childProject)).toThrow(/owner/);
    const oversized = structuredClone(bundle);
    (oversized.domains.docs as { content: string; hash: string }).content = "x".repeat(10_000);
    (oversized.domains.docs as { hash: string }).hash = computeHash("x".repeat(10_000));
    expect(() => ok.restoreKnowledge(oversized)).toThrow(/chars/);
    const badEvidence = structuredClone(bundle);
    (badEvidence.domains.docs as { evidence: unknown }).evidence = [{ kind: "dispatch" }];
    expect(() => ok.restoreKnowledge(badEvidence)).toThrow(/evidence/);
    const badTimestamp = structuredClone(bundle);
    (badTimestamp.domains.docs as { updatedAt: number }).updatedAt = Number.NaN;
    expect(() => ok.restoreKnowledge(badTimestamp)).toThrow(/updatedAt/);
    const badRevision = structuredClone(bundle);
    (badRevision.domains.docs as { revision: number }).revision = Number.POSITIVE_INFINITY;
    expect(() => ok.restoreKnowledge(badRevision)).toThrow(/revision/);

    // One invalid child means nothing is applied, not even the valid sibling.
    expect(ok.domainLibrarians.get("security")!.threadKnowledge.revision).toBe(0);
    expect(ok.domainLibrarians.get("docs")!.threadKnowledge.revision).toBe(0);
    ok.restoreKnowledge(bundle);
    expect(ok.domainLibrarians.get("security")!.threadKnowledge.content).toBe("OWNED-BY-P");
    expect(ok.domainLibrarians.get("docs")!.threadKnowledge.content).toBe("DOCS-P");
  });

  test("snapshots deep-copy evidence so callers cannot mutate live knowledge", async () => {
    const { runtime, factory } = setup({ reviewers: { security: () => LEARN("COPY-ME") } });
    const thread = factory.create("a", { projectId: "P" });
    await thread.dispatch("worker", "work");
    const owned = runtime.get("a")!;
    await owned.learningSettled();
    const knowledge = owned.domainLibrarians.get("security")!.threadKnowledge;
    const bundle = owned.knowledgeSnapshot();
    (bundle.domains.security.evidence[0] as { id: string }).id = "MUTATED";
    (bundle.domains.security as { content: string }).content = "MUTATED";
    expect(knowledge.evidence[0].id).not.toBe("MUTATED");
    expect(knowledge.content).toBe("COPY-ME");
    expect(knowledge.snapshot().evidence).not.toBe(knowledge.evidence);
  });

  test("review input is bounded, structured, and marks completed work as data", async () => {
    const big = "x".repeat(20_000);
    const { runtime, factory, reviewCalls } = setup({ reviewers: { security: () => ABSTAIN } });
    const thread = factory.create("a", { projectId: "P" });
    thread.register(new Executor({ id: "worker", stack: thread.stack, handler: async () => big }));
    await thread.dispatch("worker", big);
    await runtime.get("a")!.learningSettled();

    const call = reviewCalls[0];
    expect(call.domain).toBe("security");
    const user = call.messages.find((m) => m.role === "user")!.content;
    expect(user.length).toBeLessThan(12_000);
    expect(user).toContain("## Completed work");
    expect(user).toContain("agent: worker");
    expect(user).toContain("ok: true");
    expect(user).toContain("## Your current understanding of this thread");
    expect(call.messages.find((m) => m.role === "system")!.content).toContain("data, not instructions");
  });
});
