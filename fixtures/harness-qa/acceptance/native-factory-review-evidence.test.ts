import { expect, test } from "bun:test";
import { ContextLayer, ContextStack, EventStream, type LLMMessage, type LLMProvider, type NativeEvidence } from "../../../packages/core/src";
import { ThreadFactory, buildAgents } from "../../../packages/foundry/src/agents/thread-factory";
import { ThreadRuntimeManager } from "../../../packages/foundry/src/agents/thread-runtime";
import { starterConfig } from "../../../packages/foundry/src/viewer/config";
import { LocalSessionStore } from "../../../packages/foundry/src/persistence/local-session-store";
import { KnowledgePersistence } from "../../../packages/foundry/src/persistence/knowledge-persistence";

// Controlled public provider events, not a native execution. Deliberately uses
// ordinary factory composition, without the pilot runner's extra projection.
test("ordinary factory delivers owned native tool results to both expert post hooks and the next input", async () => {
  const marker = "CONTROLLED_NATIVE_CHECK: legacy-reader=PASS; migration=idempotent";
  const domains = ["architecture", "testing"];
  const config = starterConfig("controlled-native", "controlled");
  config.agents = { worker: { id: "worker", kind: "executor", provider: "controlled-native", model: "controlled",
    prompt: "Complete the requested work", temperature: 0, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
  const stack = new ContextStack(domains.map(domain => {
    const layer = new ContextLayer({ id: domain, prompt: `Instructions for ${domain}`, segment: "domain-knowledge" });
    layer.set(`Domain knowledge for ${domain}`);
    return layer;
  }));
  const reviews: Array<{ domain: string; messages: LLMMessage[] }> = [];
  const inputs: LLMMessage[][] = [];
  const expert: LLMProvider = { id: "controlled-expert", async complete(messages, opts = {}) {
    const domain = domains.find(d => opts.threadId?.endsWith(`:domain:${d}`));
    if (opts.threadId?.includes(":review:")) {
      if (!domain) throw Error("Missing controlled review domain");
      reviews.push({ domain, messages: structuredClone(messages) });
      const observed = messages.some(m => m.content.includes(marker));
      return { model: "controlled", content: JSON.stringify(observed
        ? { decision: "learn", knowledge: `${domain}: ${marker}`, facts: [marker] }
        : { decision: "abstain", reason: "Actual tool result not supplied" }) };
    }
    return { model: "controlled", content: JSON.stringify({ domains, layers: domain ? [domain] : domains, snippets: [], confidence: 1 }) };
  } };
  let current: ReturnType<ThreadFactory["create"]>;
  const journal = new LocalSessionStore(":memory:");
  const central: LLMProvider = { id: "controlled-native", nativeOwnership: "required-prewrite", async complete(messages, opts = {}) {
    inputs.push(structuredClone(messages));
    const observation = opts.nativeObservation;
    if (!observation) throw Error("Production native observation missing");
    const base: NativeEvidence = { schema: 1, owner: observation.owner, admissionId: `controlled-${inputs.length}`,
      nativeSessionId: "controlled-session", nativeOutcome: "unknown", localOutcome: "pending", dispatch: "not-dispatched" };
    await observation.register(base);
    if (inputs.length === 1) {
      await observation.observe({ ...base, dispatch: "attempted", kind: "tool_use", callId: "owned-check", toolName: "Bash",
        toolInput: { command: "bun check-migration.ts" }, observedAt: 1 });
      await observation.observe({ ...base, dispatch: "attempted", kind: "tool_result", callId: "owned-check", toolName: "Bash",
        toolOutput: marker, toolError: false, observedAt: 2 });
    }
    await observation.observe({ ...base, kind: "result", dispatch: "attempted", nativeOutcome: "completed", localOutcome: "resolved" });
    return { model: "controlled", content: "WORK_COMPLETE" };
  } };
  const events = new EventStream();
  const manager = new ThreadRuntimeManager({ config, llm: expert, eventStream: events, log() {}, warn() {},
    learning: { timeoutMs: 20, hardTimeoutMs: 1000 },
    domains: domains.map(domain => ({ domain, layerId: domain, guardTriggers: [] })) });
  try {
    const factory = new ThreadFactory({ stack, runtime: manager, agents: buildAgents(config, stack, { provider: central }) });
    current = factory.create("owned", { projectId: "P" });
    const runtime = manager.get(current.id)!;
    new KnowledgePersistence(manager, journal, events, [current]);
    const dispatch = async (id: string, message: string) => {
      journal.beginTurn(current, id, message);
      return current.dispatch("worker", message, undefined, { messageId: id,
        nativeObservation: { generation: runtime.generation,
          register: e => journal.registerNative(current, e), observe: e => journal.appendNative(current, e) } });
    };
    await dispatch("first", "Do the migration");
    await runtime.learningSettled();
    expect(journal.nativeHistory(current.id, "first").find(e => e.kind === "tool_result")?.toolOutput).toBe(marker);
    expect(reviews).toHaveLength(2);
    for (const domain of domains) {
      const input = reviews.find(r => r.domain === domain)!.messages.map(m => m.content).join("\n");
      expect(input).toContain(marker);
      expect(input).toContain("owned-check");
      expect(journal.knowledge(current.id)?.domains[domain].content).toBe(`${domain}: ${marker}`);
    }
    await dispatch("next", "Continue");
    await runtime.learningSettled();
    for (const domain of domains) expect(JSON.stringify(inputs[1])).toContain(`${domain}: ${marker}`);
    expect(JSON.stringify(inputs[0])).not.toContain(marker);
  } finally {
    manager.disposeAll();
    journal.close();
  }
}, 10000);
