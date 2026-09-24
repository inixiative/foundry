import { afterEach, describe, expect, test } from "bun:test";
import {
  ContextLayer,
  ContextStack,
  Executor,
  SignalBus,
  computeHash,
  type LLMMessage,
  type LLMProvider,
  type MessageDecoration,
} from "@inixiative/foundry-core";
import { Cartographer } from "../src/agents/cartographer";
import { DomainLibrarian } from "../src/agents/domain-librarian";
import { FlowOrchestrator, type InjectionPlan } from "../src/agents/flow-orchestrator";
import { Librarian } from "../src/agents/librarian";
import { ThreadFactory, buildAgents } from "../src/agents/thread-factory";
import { ThreadRuntimeManager } from "../src/agents/thread-runtime";
import { starterConfig } from "../src/viewer/config";

// Parallel message decoration (CORE-002 "Message Decoration", CORE-003 G3a).
// Every enabled domain assesses the same frozen input concurrently with
// routing; decisions, provenance and three named segments are explicit;
// composition order is the configured order; late results cannot mutate a
// sealed plan; hydration prepares without committing the delivery ledger.

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Responder = (messages: LLMMessage[]) => Promise<string> | string;

interface SetupOpts {
  responders?: Record<string, Responder>;
  routeDomains?: string[];
  limit?: number;
  timeoutMs?: number;
  planTimeoutMs?: number;
  budget?: number;
  cold?: string[];
  stale?: string[];
}

function setup(names: string[], opts: SetupOpts = {}) {
  const signals = new SignalBus();
  const layers = names.map((name) => {
    const layer = new ContextLayer({ id: name, prompt: `Instructions for ${name}`, staleness: 1 });
    if (!opts.cold?.includes(name)) layer.set(`DOMAIN-${name}-REVISION-A`);
    if (opts.stale?.includes(name)) layer.invalidate();
    return layer;
  });
  const stack = new ContextStack(layers);
  const librarian = new Librarian({ stack, signals });
  const calls = new Map<string, number>();
  const route: LLMProvider = {
    id: "route",
    complete: async () => ({
      model: "mock",
      content: JSON.stringify({ layers: opts.routeDomains ?? [names[0]], domains: opts.routeDomains ?? [names[0]], confidence: 1 }),
    }),
  };
  const cartographer = new Cartographer({ stack, signals, llm: route });
  const domains = new Map(names.map((name, index) => [name, new DomainLibrarian({
    domain: name,
    cache: layers[index],
    signals,
    advisePrompt: `ADVISE-PROMPT-${name}`,
    llm: {
      id: name,
      complete: async (messages) => {
        calls.set(name, (calls.get(name) ?? 0) + 1);
        const responder = opts.responders?.[name];
        const content = responder
          ? await responder(messages)
          : JSON.stringify({ layers: [name], snippets: [`ADVICE-${name}`], confidence: 1 });
        return { model: "mock", content };
      },
    },
  })]));
  const flow = new FlowOrchestrator({
    stack, signals, librarian, cartographer, domainLibrarians: domains,
    maxAdviseParallel: opts.limit, adviseTimeoutMs: opts.timeoutMs, planTimeoutMs: opts.planTimeoutMs, contributionBudget: opts.budget,
  });
  cleanups.push(() => { flow.dispose(); cartographer.dispose(); librarian.dispose(); });
  return { flow, stack, librarian, signals, calls, layers };
}

const contribute = (name: string) => JSON.stringify({ layers: [name], snippets: [`ADVICE-${name}`], confidence: 1 });

describe("parallel message decoration", () => {
  test("reversed completion order still composes contributions in configured order", async () => {
    const { flow } = setup(["alpha", "beta", "gamma"], {
      responders: {
        alpha: async () => { await sleep(30); return contribute("alpha"); },
        beta: async () => { await sleep(15); return contribute("beta"); },
        gamma: () => contribute("gamma"),
      },
    });
    const plan = await flow.preMessage("Compose deterministically");
    expect(plan.contributions.map((c) => c.domain)).toEqual(["alpha", "beta", "gamma"]);
    expect(plan.snippets).toEqual(["ADVICE-alpha", "ADVICE-beta", "ADVICE-gamma"]);
    const finished = plan.contributions.map((c) => c.provenance.finishedAt!);
    expect(finished[2]).toBeLessThanOrEqual(finished[0]);
  });

  test("a bounded pool still consults every enabled domain", async () => {
    const { flow, calls } = setup(["a", "b", "c", "d"], { limit: 1 });
    const plan = await flow.preMessage("All of you");
    expect([...calls.keys()].sort()).toEqual(["a", "b", "c", "d"]);
    expect(plan.contributions.filter((c) => c.decision === "contribute").map((c) => c.domain)).toEqual(["a", "b", "c", "d"]);
  });

  test("timeout is an explicit decision and a late result cannot mutate the sealed plan", async () => {
    let lateResolved = false;
    const { flow } = setup(["fast", "slow"], {
      timeoutMs: 10,
      responders: {
        fast: () => contribute("fast"),
        slow: async () => { await sleep(40); lateResolved = true; return contribute("slow"); },
      },
    });
    const plan = await flow.preMessage("Wait for nobody");
    const slow = plan.contributions.find((c) => c.domain === "slow")!;
    expect(slow.decision).toBe("timeout");
    expect(plan.snippets).toEqual(["ADVICE-fast"]);
    expect(plan.domainsConsulted).toEqual(["fast", "slow"]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.contributions)).toBe(true);

    const snapshot = JSON.stringify(plan);
    await sleep(50);
    expect(lateResolved).toBe(true);
    expect(JSON.stringify(plan)).toBe(snapshot);
  });

  test("an adviser failure is an explicit error decision, never a silent abstention", async () => {
    const { flow } = setup(["ok", "broken"], {
      responders: {
        ok: () => contribute("ok"),
        broken: () => { throw new Error("adviser exploded"); },
      },
    });
    const plan = await flow.preMessage("Some fail");
    const broken = plan.contributions.find((c) => c.domain === "broken")!;
    expect(broken.decision).toBe("error");
    expect(broken.reason).toContain("adviser exploded");
    expect(plan.contributions.find((c) => c.domain === "ok")!.decision).toBe("contribute");
    expect(plan.snippets).toEqual(["ADVICE-ok"]);
  });

  test("cold caches abstain explicitly without a model call and stale caches are marked", async () => {
    const { flow, calls } = setup(["cold", "stale", "warm"], { cold: ["cold"], stale: ["stale"] });
    const plan = await flow.preMessage("Freshness matters");
    const byDomain = Object.fromEntries(plan.contributions.map((c) => [c.domain, c]));
    expect(byDomain.cold.decision).toBe("abstain");
    expect(byDomain.cold.reason).toBe("cold-cache");
    expect(calls.has("cold")).toBe(false);
    expect(byDomain.stale.decision).toBe("contribute");
    expect(byDomain.stale.provenance.cacheState).toBe("stale");
    expect(byDomain.warm.provenance.cacheState).toBe("warm");
  });

  test("every contribution carries three named segments and explicit provenance", async () => {
    const { flow, librarian, layers } = setup(["security"]);
    const message = "Provenance please";
    const threadState = librarian.layer.content;
    const plan = await flow.preMessage(message);
    const c = plan.contributions[0];
    // Thread knowledge is the domain's own (generated) understanding, empty
    // until it learns; the global thread-state is a separate input.
    expect(c.segments).toEqual({
      instructions: "ADVISE-PROMPT-security",
      domainKnowledge: "DOMAIN-security-REVISION-A",
      threadKnowledge: "",
    });
    expect(c.provenance.threadKnowledgeRevision).toBe(0);
    expect(c.provenance.inputHash).toBe(computeHash(message));
    expect(c.provenance.cacheHash).toBe(layers[0].hash);
    expect(c.provenance.threadStateHash).toBe(computeHash(threadState));
    expect(plan.input).toMatchObject({ message, hash: computeHash(message) });

    const prepared = await flow.hydrateDelta(plan);
    const block = prepared.decoration.blocks.find((b) => b.source === "security")!;
    expect(block.segment).toBe("domain-knowledge");
    expect(block.text).toContain("ADVICE-security");
    expect(prepared.decoration.participants.map((p) => [p.id, p.decision])).toEqual([["security", "contribute"]]);
  });

  test("budget exclusions are recorded as omissions, not silently dropped", async () => {
    const { flow } = setup(["first", "second"], { budget: "ADVICE-first".length });
    const plan = await flow.preMessage("Tight budget");
    expect(plan.snippets).toEqual(["ADVICE-first"]);
    expect(plan.contributions.find((c) => c.domain === "second")!.decision).toBe("omitted");
    expect(plan.omissions).toEqual([{ domain: "second", reason: "budget" }]);
  });

  test("a domain contributing against the router's selection is an observable conflict", async () => {
    const { flow } = setup(["chosen", "unchosen"], { routeDomains: ["chosen"] });
    const plan = await flow.preMessage("Router disagrees");
    expect(plan.contributions.map((c) => c.decision)).toEqual(["contribute", "contribute"]);
    expect(plan.conflicts).toEqual([{ kind: "routing-excluded", domain: "unchosen", detail: expect.any(String) }]);
    expect(plan.routing.domains).toEqual(["chosen"]);
  });

  test("hydration prepares pending ledger records and commit only happens on explicit delivery evidence", async () => {
    const { flow, librarian, layers, signals } = setup(["security"]);
    const loaded: string[] = [];
    signals.on("context_loaded", (s) => { loaded.push((s.content as { layerId: string }).layerId); });
    const plan = await flow.preMessage("Prepare");
    const prepared = await flow.hydrateDelta(plan);
    expect(prepared.pending).toEqual([{ id: "security", hash: layers[0].hash }]);
    expect(loaded).toEqual([]);
    expect(librarian.state.injectedLayers).toEqual([]);

    flow.commitDelivery({ layers: prepared.pending });
    await sleep(0);
    expect(loaded).toEqual(["security"]);
    expect(librarian.state.injectedLayers.map((r) => [r.id, r.hash])).toEqual([["security", layers[0].hash]]);
  });
});

describe("bounded routing and whole-plan deadlines", () => {
  function routerStub(fn: () => Promise<unknown>): Cartographer {
    return { route: fn, dispose() {}, buildMap() {} } as unknown as Cartographer;
  }

  function withRouter(names: string[], router: Cartographer, extra: Partial<ConstructorParameters<typeof FlowOrchestrator>[0]> = {}) {
    const signals = new SignalBus();
    const layers = names.map((name) => {
      const layer = new ContextLayer({ id: name, prompt: `Instructions for ${name}` });
      layer.set(`DOMAIN-${name}-REVISION-A`);
      return layer;
    });
    const stack = new ContextStack(layers);
    const librarian = new Librarian({ stack, signals });
    const domains = new Map(names.map((name, i) => [name, new DomainLibrarian({
      domain: name, cache: layers[i], signals,
      llm: { id: name, complete: async () => ({ model: "mock", content: contribute(name) }) },
    })]));
    const flow = new FlowOrchestrator({ stack, signals, librarian, cartographer: router, domainLibrarians: domains, ...extra });
    cleanups.push(() => { flow.dispose(); librarian.dispose(); });
    return { flow, librarian };
  }

  test("a stalled router is recorded as a timeout, never as a confident empty route", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let lateRouted = false;
    const router = routerStub(async () => { await held; lateRouted = true; return { layers: ["security"], domains: ["late"], confidence: 1 }; });
    const { flow } = withRouter(["security"], router, { routingTimeoutMs: 10 });

    const plan = await flow.preMessage("Route me");
    expect(plan.routing.status).toBe("timeout");
    expect(plan.routing.reason).toContain("10ms");
    expect(plan.routing.confidence).toBe(0);
    expect(plan.routing.domains).toEqual([]);
    expect(plan.confidence).toBe(0);
    expect(plan.snippets).toEqual(["ADVICE-security"]);
    expect(plan.outstanding).toEqual([expect.objectContaining({ kind: "route", participant: "cartographer" })]);
    expect(flow.outstandingCalls).toBe(1);

    const sealed = JSON.stringify(plan);
    release();
    await sleep(5);
    expect(lateRouted).toBe(true);
    expect(JSON.stringify(plan)).toBe(sealed);
    expect(flow.outstandingCalls).toBe(0);
  });

  test("a router error is recorded as an error with its reason", async () => {
    const router = routerStub(async () => { throw new Error("router down"); });
    const { flow } = withRouter(["security"], router);
    const plan = await flow.preMessage("Route me");
    expect(plan.routing.status).toBe("error");
    expect(plan.routing.reason).toContain("router down");
    expect(plan.snippets).toEqual(["ADVICE-security"]);
  });

  test("the real Cartographer's keyword fallback is labelled fallback, not a model route", async () => {
    const signals = new SignalBus();
    const layer = new ContextLayer({ id: "security-patterns", prompt: "Security" });
    layer.set("OWASP top 10");
    const stack = new ContextStack([layer]);
    const librarian = new Librarian({ stack, signals });
    const cartographer = new Cartographer({ stack, signals, llm: { id: "broken", complete: async () => { throw new Error("model unavailable"); } } });
    const flow = new FlowOrchestrator({ stack, signals, librarian, cartographer, domainLibrarians: new Map() });
    cleanups.push(() => { flow.dispose(); cartographer.dispose(); librarian.dispose(); });
    const plan = await flow.preMessage("Check the security patterns");
    expect(plan.routing.status).toBe("fallback");
    expect(plan.routing.reason).toContain("model unavailable");
  });

  test("bounded settings must be finite positive numbers", () => {
    const signals = new SignalBus();
    const stack = new ContextStack([]);
    const librarian = new Librarian({ stack, signals });
    const cartographer = routerStub(async () => ({ layers: [], domains: [], confidence: 0 }));
    cleanups.push(() => librarian.dispose());
    const make = (extra: Record<string, unknown>) =>
      new FlowOrchestrator({ stack, signals, librarian, cartographer, domainLibrarians: new Map(), ...extra });

    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => make({ maxAdviseParallel: bad })).toThrow(/maxAdviseParallel/);
    }
    for (const key of ["adviseTimeoutMs", "routingTimeoutMs", "planTimeoutMs"]) {
      for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => make({ [key]: bad })).toThrow(new RegExp(key));
      }
    }
    for (const bad of [0, -1, Number.NaN]) {
      expect(() => make({ contributionBudget: bad })).toThrow(/contributionBudget/);
    }
    expect(() => make({ contributionBudget: Number.POSITIVE_INFINITY, maxAdviseParallel: 3, adviseTimeoutMs: 5 })).not.toThrow();
  });

  test("a whole-plan deadline distinguishes timed-out participants from never-started ones", async () => {
    const { flow, calls } = setup(["first", "second", "third"], {
      limit: 1, timeoutMs: 500, planTimeoutMs: 20,
      responders: { first: async () => { await sleep(60); return contribute("first"); } },
    });
    const plan = await flow.preMessage("Plan deadline");
    const byDomain = Object.fromEntries(plan.contributions.map((c) => [c.domain, c]));
    expect(byDomain.first.decision).toBe("timeout");
    expect(byDomain.first.reason).toContain("plan deadline");
    expect(byDomain.second.decision).toBe("excluded");
    expect(byDomain.second.reason).toBe("deadline-queued");
    expect(byDomain.third.decision).toBe("excluded");
    expect(calls.has("second")).toBe(false);
    expect(calls.has("third")).toBe(false);
    expect(plan.outstanding.map((o) => o.participant)).toEqual(["first"]);
    expect(flow.outstandingCalls).toBe(1);
    await sleep(70);
    expect(flow.outstandingCalls).toBe(0);
  });

  test("hydration reports the assessed revision and the delivered revision separately", async () => {
    const { flow, layers } = setup(["security"]);
    const plan = await flow.preMessage("Assess A, deliver B");
    const assessedHash = layers[0].hash;
    layers[0].set("DOMAIN-security-REVISION-B");
    const prepared = await flow.hydrateDelta(plan);
    expect(plan.contributions[0].provenance.cacheHash).toBe(assessedHash);
    expect(prepared.revisions).toEqual([{ id: "security", domain: "security", assessedHash, deliveredHash: layers[0].hash, changed: true }]);
    expect(prepared.decoration.participants[0].provenance).toMatchObject({ cacheHash: assessedHash, deliveredCacheHash: layers[0].hash, revisionDrift: true });
    expect(prepared.pending).toEqual([{ id: "security", hash: layers[0].hash }]);
  });
});

describe("production runtime delivery", () => {
  function runtimeSetup(handler?: (context: string, payload: string) => Promise<string>) {
    const config = starterConfig("mock", "mock");
    config.agents = { worker: { id: "worker", kind: "executor", provider: "mock", model: "mock",
      prompt: "Execute", temperature: 0, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
    const layer = new ContextLayer({ id: "security", prompt: "Review security" });
    layer.set("Known security conventions");
    const stack = new ContextStack([layer]);
    let providerInput: LLMMessage[] = [];
    const provider: LLMProvider = { id: "mock", complete: async (messages) => {
      providerInput = structuredClone(messages);
      return { model: "mock", content: "done" };
    } };
    const runtime = new ThreadRuntimeManager({ config, log: () => {}, warn: () => {},
      domains: [{ domain: "security", layerId: "security", guardTriggers: [] }],
      llm: { id: "flow", complete: async (_messages, opts) => ({ model: "mock",
        content: opts?.threadId?.endsWith(":cartographer")
          ? '{"domains":["security"],"layers":["security"],"confidence":1}'
          : '{"layers":["security"],"snippets":["GENERATED-ADVICE-ONLY"],"confidence":1}',
      }) },
    });
    cleanups.push(() => runtime.disposeAll());
    const agents = handler
      ? new Map([["worker", new Executor({ id: "worker", stack, handler: async (context, payload: string) => handler(context, payload) })]])
      : buildAgents(config, stack, { provider });
    const factory = new ThreadFactory({ stack, agents, runtime });
    return { factory, runtime, layer, getProviderInput: () => providerInput };
  }

  test("delivered decoration is recorded on the artifact and committed to the ledger only after completion", async () => {
    const { factory, runtime, layer, getProviderInput } = runtimeSetup();
    const thread = factory.create("delivered", { projectId: "P" });
    const result = await thread.dispatch("worker", "ORIGINAL-USER-MESSAGE");

    const artifact = result.meta?.injection as { providerMessages?: LLMMessage[]; userMessage: string; decoration?: MessageDecoration };
    expect(artifact.userMessage).toBe("ORIGINAL-USER-MESSAGE");
    expect(artifact.providerMessages).toEqual(getProviderInput());
    expect(JSON.stringify(artifact.providerMessages)).toContain("GENERATED-ADVICE-ONLY");
    expect(artifact.decoration?.participants.map((p) => [p.id, p.decision])).toEqual([["security", "contribute"]]);
    expect(artifact.decoration?.blocks.some((b) => b.source === "security" && b.segment === "domain-knowledge")).toBe(true);

    const ledger = runtime.get("delivered")!.librarian.state.injectedLayers;
    expect(ledger.map((r) => [r.id, r.hash])).toContainEqual(["security", layer.hash]);
  });

  test("a failure before send leaves the delivery ledger empty", async () => {
    const { factory, runtime } = runtimeSetup(async () => { throw new Error("provider unreachable"); });
    const thread = factory.create("failed", { projectId: "P" });
    await expect(thread.dispatch("worker", "ORIGINAL-USER-MESSAGE")).rejects.toThrow("provider unreachable");
    expect(runtime.get("failed")!.librarian.state.injectedLayers).toEqual([]);
  });

  test("a cache change between assessment and executor delivery is recorded as drift, and the ledger records what was delivered", async () => {
    const { factory, runtime } = runtimeSetup();
    const thread = factory.create("drift", { projectId: "P" });
    // The thread works on its own clone of the template layer.
    const layer = thread.stack.getLayer("security")!;
    const assessedHash = layer.hash;
    // Runs after the decorator has sealed its plan and before the executor assembles.
    thread.middleware.use("mutate-between", async (_ctx, next) => {
      layer.set("Known security conventions, revised after assessment");
      return next();
    });
    const result = await thread.dispatch("worker", "Drift please");

    const artifact = result.meta?.injection as { plan?: InjectionPlan; layers?: Array<{ id: string; hash: string }> };
    expect(artifact.plan!.contributions[0].provenance.cacheHash).toBe(assessedHash);
    expect(artifact.layers!.find((l) => l.id === "security")!.hash).toBe(layer.hash);
    expect(layer.hash).not.toBe(assessedHash);

    const delivery = result.meta?.delivery as import("@inixiative/foundry-core").DeliveryRecord;
    expect(delivery.layers.find((l) => l.id === "security")).toEqual({ id: "security", domain: "security", projectId: "P", threadId: "drift", assessedHash, deliveredHash: layer.hash, drift: true });
    expect(delivery.committed).toContain("security");
    const ledger = runtime.get("drift")!.librarian.state.injectedLayers;
    expect(ledger.find((r) => r.id === "security")!.hash).toBe(layer.hash);
  });

  test("a stalled router does not block production delivery and is recorded on the artifact", async () => {
    const config = starterConfig("mock", "mock");
    config.agents = { worker: { id: "worker", kind: "executor", provider: "mock", model: "mock",
      prompt: "Execute", temperature: 0, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
    const layer = new ContextLayer({ id: "security", prompt: "Review security" });
    layer.set("Known security conventions");
    const stack = new ContextStack([layer]);
    const provider: LLMProvider = { id: "mock", complete: async () => ({ model: "mock", content: "done" }) };
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    cleanups.push(() => release());
    const runtime = new ThreadRuntimeManager({ config, log: () => {}, warn: () => {},
      domains: [{ domain: "security", layerId: "security", guardTriggers: [] }],
      flow: { routingTimeoutMs: 15, adviseTimeoutMs: 200 },
      llm: { id: "flow", complete: async (_messages, opts) => {
        if (opts?.threadId?.endsWith(":cartographer")) { await held; }
        return { model: "mock", content: '{"layers":["security"],"snippets":["ADVICE-security"],"confidence":1}' };
      } },
    });
    cleanups.push(() => runtime.disposeAll());
    const factory = new ThreadFactory({ stack, agents: buildAgents(config, stack, { provider }), runtime });
    const thread = factory.create("stalled-router", { projectId: "P" });

    const outcome = await Promise.race([thread.dispatch("worker", "Go"), sleep(300).then(() => "blocked" as const)]);
    expect(outcome).not.toBe("blocked");
    const plan = ((outcome as { meta?: { injection?: { plan?: InjectionPlan } } }).meta?.injection?.plan)!;
    expect(plan.routing.status).toBe("timeout");
    expect(plan.snippets).toEqual(["ADVICE-security"]);
    expect(runtime.get("stalled-router")!.flowOrchestrator.outstandingCalls).toBe(1);
  });

  test("a sealed plan is exposed to the executor and later advice cannot change it", async () => {
    const { factory } = runtimeSetup();
    const thread = factory.create("sealed", { projectId: "P" });
    const result = await thread.dispatch("worker", "Seal it");
    const plan = (result.meta?.injection as { plan?: InjectionPlan }).plan;
    expect(plan).toBeDefined();
    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan!.input.message).toBe("Seal it");
  });
});
