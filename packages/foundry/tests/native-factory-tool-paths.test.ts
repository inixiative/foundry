import { expect, test } from "bun:test";
import { ContextLayer, ContextStack, EventStream, ToolRegistry, type LLMMessage, type LLMProvider, type NativeEvidence, type ScriptTool, type ToolResult, type ScriptResult } from "@inixiative/foundry-core";
import { ThreadFactory, buildAgents } from "../src/agents/thread-factory";
import { ThreadRuntimeManager } from "../src/agents/thread-runtime";
import { starterConfig } from "../src/viewer/config";
import { LocalSessionStore } from "../src/persistence/local-session-store";
import { KnowledgePersistence } from "../src/persistence/knowledge-persistence";

// Shared factory boundary: owned public native tool events reach both expert post hooks on the
// streaming and tool-loop paths; a tool seen by both the local loop and native events is one
// observation; foreign-dispatch native events never become this dispatch's evidence.
// Controlled providers only (labelled controlled); no model, network or native process.

const domains = ["architecture", "testing"];
const MARK = "CONTROLLED_TOOL_OUTPUT: schema=additive legacy-read=PASS";
const FOREIGN = "FOREIGN_DISPATCH_OUTPUT_MUST_NOT_APPEAR";

function fixture(central: LLMProvider, tools?: ToolRegistry) {
  const config = starterConfig("controlled-native", "controlled");
  config.agents = { worker: { id: "worker", kind: "executor", provider: "controlled-native", model: "controlled", prompt: "Complete the requested work", temperature: 0, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } } as any;
  const stack = new ContextStack(domains.map(d => { const layer = new ContextLayer({ id: d, prompt: `Instructions for ${d}`, segment: "domain-knowledge" }); layer.set(`Domain knowledge for ${d}`); return layer; }));
  const reviews: Array<{ domain: string; text: string }> = [];
  const expert: LLMProvider = { id: "controlled-expert", async complete(messages, opts = {}) {
    const domain = domains.find(d => opts.threadId?.endsWith(`:domain:${d}`));
    if (opts.threadId?.includes(":review:")) { reviews.push({ domain: domain!, text: messages.map(m => m.content).join("\n") }); return { model: "controlled", content: JSON.stringify({ decision: "abstain", reason: "controlled" }) }; }
    return { model: "controlled", content: JSON.stringify({ domains, layers: domain ? [domain] : domains, snippets: [], confidence: 1 }) };
  } };
  const journal = new LocalSessionStore(":memory:"); const events = new EventStream();
  const manager = new ThreadRuntimeManager({ config, llm: expert, eventStream: events, log() {}, warn() {}, learning: { timeoutMs: 20, hardTimeoutMs: 1000 }, domains: domains.map(d => ({ domain: d, layerId: d, guardTriggers: [] })) } as any);
  const factory = new ThreadFactory({ stack, runtime: manager, agents: buildAgents(config, stack, { provider: central, tools }), ...(tools ? { nativeTools: tools } : {}) } as any);
  const thread = factory.create("owned", { projectId: "P" }); const runtime = manager.get(thread.id)!;
  new KnowledgePersistence(manager, journal, events, [thread]);
  const dispatch = (id: string, message: string, onDelta?: (t: string) => void) => { journal.beginTurn(thread, id, message);
    return thread.dispatch("worker", message, undefined, { messageId: id, ...(onDelta ? { onDelta } : {}), nativeObservation: { generation: runtime.generation, register: e => journal.registerNative(thread, e), observe: e => journal.appendNative(thread, e) } }); };
  return { reviews, journal, runtime, thread, dispatch, close() { manager.disposeAll(); journal.close(); } };
}

const registered = async (observation: NonNullable<import("@inixiative/foundry-core").CompletionOpts["nativeObservation"]>, admissionId: string) => {
  const base: NativeEvidence = { schema: 1, owner: observation.owner, admissionId, nativeSessionId: "controlled", nativeOutcome: "unknown", localOutcome: "pending", dispatch: "not-dispatched" };
  await observation.register(base); return base;
};

test("streaming path: owned native begin/result reaches both reviews; a foreign-dispatch result does not", async () => {
  let deltas = ""; let foreignOutcome = "not-attempted";
  const central: LLMProvider = { id: "controlled-native", nativeOwnership: "required-prewrite",
    async complete() { throw Error("stream path expected"); },
    async *stream(_messages: LLMMessage[], opts = {}) {
      const observation = opts.nativeObservation!; const base = await registered(observation, "adm-stream");
      await observation.observe({ ...base, dispatch: "attempted", kind: "tool_use", callId: "s1", toolName: "Bash", toolInput: { command: "bun check" }, observedAt: 1 });
      await observation.observe({ ...base, dispatch: "attempted", kind: "tool_result", callId: "s1", toolName: "Bash", toolOutput: MARK, toolError: false, observedAt: 2 });
      // Same admission id but another dispatch's owner: the raw journal refuses it first ("Native admission owner
      // changed"), so it never reaches the projector or the reviews. The refusal is recorded, not swallowed.
      try { await observation.observe({ ...base, owner: { ...observation.owner, dispatchId: "someone-else" }, dispatch: "attempted", kind: "tool_result", callId: "s1", toolName: "Bash", toolOutput: FOREIGN }); foreignOutcome = "accepted"; }
      catch (error) { foreignOutcome = (error as Error).message; }
      yield { type: "text" as const, text: "STREAMED_" }; yield { type: "text" as const, text: "DONE" };
      await observation.observe({ ...base, kind: "result", dispatch: "attempted", nativeOutcome: "completed", localOutcome: "resolved" });
    } };
  const f = fixture(central);
  try {
    await f.dispatch("first", "Do the migration", t => { deltas += t; });
    await f.runtime.learningSettled();
    expect(deltas).toBe("STREAMED_DONE");
    expect(foreignOutcome).toMatch(/owner changed/); // journal ownership check refused the foreign event before any projection
    expect(f.journal.nativeHistory(f.thread.id, "first").filter(e => e.kind === "tool_result")).toHaveLength(1);
    expect(JSON.stringify(f.journal.nativeHistory(f.thread.id, "first"))).not.toContain(FOREIGN);
    expect(f.reviews).toHaveLength(2);
    for (const domain of domains) { const text = f.reviews.find(r => r.domain === domain)!.text; expect(text).toContain(MARK); expect(text).toContain("s1"); expect(text).not.toContain(FOREIGN); }
  } finally { f.close(); }
});

test("tool-loop path: a call observed by the local loop and by native events is one review observation; native-only calls are added", async () => {
  const tools = new ToolRegistry();
  const script: ScriptTool = { id: "probe", kind: "script", capability: "data:read", async evaluate<T>(code: string): Promise<ToolResult<ScriptResult<T>>> {
    return { ok: true, data: { result: code as unknown as T, logs: [], durationMs: 0 }, summary: `LOOP_RESULT for ${code}` }; } };
  tools.register(script, "Controlled probe tool");
  let calls = 0;
  const central: LLMProvider = { id: "controlled-native", nativeOwnership: "required-prewrite", async complete(messages: LLMMessage[], opts = {}) {
    calls++; const observation = opts.nativeObservation!;
    if (calls === 1) {
      const base = await registered(observation, "adm-loop");
      // The native engine reports the same call the loop will execute (same call id) …
      await observation.observe({ ...base, dispatch: "attempted", kind: "tool_use", callId: "loop-call-1", toolName: "probe_evaluate", toolInput: { code: "probe:one" }, observedAt: 1 });
      await observation.observe({ ...base, dispatch: "attempted", kind: "tool_result", callId: "loop-call-1", toolName: "probe_evaluate", toolOutput: "NATIVE_VIEW_OF_LOOP_CALL", toolError: false, observedAt: 2 });
      // … and one native-only tool the loop never sees.
      await observation.observe({ ...base, dispatch: "attempted", kind: "tool_use", callId: "native-only", toolName: "Bash", toolInput: { command: "bun check" }, observedAt: 3 });
      await observation.observe({ ...base, dispatch: "attempted", kind: "tool_result", callId: "native-only", toolName: "Bash", toolOutput: MARK, toolError: false, observedAt: 4 });
      return { model: "controlled", content: "", toolCalls: [{ id: "loop-call-1", name: "probe_evaluate", input: { code: "probe:one" } }] };
    }
    const base: NativeEvidence = { schema: 1, owner: observation.owner, admissionId: "adm-loop", nativeOutcome: "unknown" };
    await observation.observe({ ...base, kind: "result", dispatch: "attempted", nativeOutcome: "completed", localOutcome: "resolved" });
    return { model: "controlled", content: "LOOP_COMPLETE" };
  } };
  const f = fixture(central, tools);
  try {
    await f.dispatch("first", "Run the probe then the check");
    await f.runtime.learningSettled();
    expect(f.reviews).toHaveLength(2);
    for (const domain of domains) {
      const text = f.reviews.find(r => r.domain === domain)!.text;
      expect(text).toContain(MARK); // native-only tool reached the review
      expect((text.match(/loop-call-1/g) ?? []).length).toBe(1); // one observation for the shared call id, not two
    }
  } finally { f.close(); }
});
