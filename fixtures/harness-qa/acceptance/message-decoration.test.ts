import { afterEach, expect, test } from "bun:test";
import {
  ContextLayer, ContextStack, SignalBus, type LLMMessage, type LLMProvider,
} from "../../../packages/core/src";
import { Cartographer } from "../../../packages/foundry/src/agents/cartographer";
import { DomainLibrarian } from "../../../packages/foundry/src/agents/domain-librarian";
import { FlowOrchestrator } from "../../../packages/foundry/src/agents/flow-orchestrator";
import { Librarian } from "../../../packages/foundry/src/agents/librarian";
import { buildAgents, ThreadFactory } from "../../../packages/foundry/src/agents/thread-factory";
import { ThreadRuntimeManager } from "../../../packages/foundry/src/agents/thread-runtime";
import { starterConfig } from "../../../packages/foundry/src/viewer/config";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function setup(names: string[], options: { routeWait?: Promise<void>; limit?: number } = {}) {
  const signals = new SignalBus();
  const layers = names.map(name => {
    const layer = new ContextLayer({ id: name, prompt: `Instructions for ${name}` });
    layer.set(`DOMAIN-${name}-REVISION-A`);
    return layer;
  });
  const stack = new ContextStack(layers);
  const librarian = new Librarian({ stack, signals });
  const inputs = new Map<string, LLMMessage[]>();
  const route: LLMProvider = { id: "route", complete: async () => {
    if (options.routeWait) await options.routeWait;
    return { model: "mock", content: JSON.stringify({ layers: [names[0]], domains: [names[0]], confidence: 1 }) };
  } };
  const cartographer = new Cartographer({ stack, signals, llm: route });
  const domains = new Map(names.map((name, index) => [name, new DomainLibrarian({
    domain: name, cache: layers[index], signals,
    llm: { id: name, complete: async messages => {
      inputs.set(name, structuredClone(messages));
      return { model: "mock", content: JSON.stringify({ layers: [name], snippets: [`ADVICE-${name}`], confidence: 1 }) };
    } },
  })]));
  const flow = new FlowOrchestrator({ stack, signals, librarian, cartographer, domainLibrarians: domains,
    maxAdviseParallel: options.limit });
  cleanups.push(() => { flow.dispose(); cartographer.dispose(); librarian.dispose(); });
  return { flow, stack, librarian, inputs };
}

test("G3: routing cannot silently exclude enabled domain participants", async () => {
  const { flow, inputs } = setup(["security", "docs", "conventions"], { limit: 2 });
  const plan = await flow.preMessage("Original message: preserve this exactly.");
  expect([...inputs.keys()].sort()).toEqual(["conventions", "docs", "security"]);
  expect([...plan.domainsConsulted].sort()).toEqual(["conventions", "docs", "security"]);
  for (const messages of inputs.values()) {
    expect(messages.find(message => message.role === "user")?.content).toContain("Original message: preserve this exactly.");
  }
});

test("G3: domain assessment starts without waiting for routing to finish", async () => {
  const route = deferred();
  const { flow, inputs } = setup(["security", "docs"], { routeWait: route.promise });
  const pending = flow.preMessage("Assess together");
  try {
    await Bun.sleep(10);
    expect([...inputs.keys()].sort()).toEqual(["docs", "security"]);
  } finally {
    route.resolve();
    await pending;
  }
});

test("G3: input knowledge revision is frozen before asynchronous routing", async () => {
  const route = deferred();
  const { flow, stack, inputs } = setup(["security"], { routeWait: route.promise });
  const pending = flow.preMessage("Use the captured revision");
  stack.getLayer("security")!.set("DOMAIN-security-REVISION-B");
  route.resolve();
  await pending;
  const text = JSON.stringify(inputs.get("security"));
  expect(text).toContain("DOMAIN-security-REVISION-A");
  expect(text).not.toContain("DOMAIN-security-REVISION-B");
});

test("G3: preparing context cannot commit a native delivery ledger", async () => {
  const { flow, librarian } = setup(["security"]);
  const plan = await flow.preMessage("Prepare but do not deliver");
  const prepared = await flow.hydrateDelta(plan);
  expect(prepared.content).toContain("DOMAIN-security-REVISION-A");
  expect(librarian.state.injectedLayers).toEqual([]);
});

test("G3: production runtime delivers adviser snippets and records that exact input", async () => {
  const config = starterConfig("mock", "mock");
  config.agents = { worker: { id: "worker", kind: "executor", provider: "mock", model: "mock",
    prompt: "Execute", temperature: 0, maxTokens: 256, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
  const layer = new ContextLayer({ id: "security", prompt: "Review security" });
  layer.set("Known security conventions");
  const stack = new ContextStack([layer]);
  let providerInput: LLMMessage[] = [];
  const provider: LLMProvider = { id: "mock", complete: async messages => {
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
  const factory = new ThreadFactory({ stack, agents: buildAgents(config, stack, { provider }), runtime });
  const thread = factory.create("decorated-thread", { projectId: "P" });
  const result = await thread.dispatch("worker", "ORIGINAL-USER-MESSAGE");
  expect(JSON.stringify(providerInput)).toContain("GENERATED-ADVICE-ONLY");
  expect(providerInput.find(message => message.role === "user")?.content).toContain("ORIGINAL-USER-MESSAGE");
  const artifact = result.meta?.injection as { providerMessages?: LLMMessage[]; userMessage?: string } | undefined;
  expect(artifact?.providerMessages).toEqual(providerInput);
  expect(artifact?.userMessage).toBe("ORIGINAL-USER-MESSAGE");
});
