import { expect, test } from "bun:test";
import { ContextLayer, ContextStack, EventStream, type LLMMessage, type LLMProvider } from "@inixiative/foundry-core";
import { ThreadFactory, buildAgents } from "../src/agents/thread-factory";
import { ThreadRuntimeManager } from "../src/agents/thread-runtime";
import { starterConfig } from "../src/viewer/config";
import { LocalSessionStore } from "../src/persistence/local-session-store";
import { KnowledgePersistence } from "../src/persistence/knowledge-persistence";
import { SessionBackedProvider } from "../src/providers/session-backed";
import type { SessionAdapter } from "../src/providers/session-adapter";

// The real SessionBackedProvider (which stamps providerSessionKey onto the admitted owner) over a
// controlled prewrite-v1 adapter, through the ordinary factory, runtime and both expert post hooks.
// No runner-only projector, model, CLI, browser or transport process. Owned handles are released.

const domains = ["architecture", "testing"];
const MARK = "CONTROLLED_PROVIDER_RESULT: legacy-reader=PASS";

function controlledAdapter(state: { sends: number; released: number }) {
  const listeners = new Set<(event: any) => void>(); const attempts = new Map<string, any>();
  const session: any = { admissionProtocol: "prewrite-v1", turnBudgetProtocol: "optional-max-turns-v1", externalSessionId: "controlled-binding",
    async start() {}, kill() { throw Error("No process exists to kill"); },
    onEvent(fn: (event: any) => void) { listeners.add(fn); return () => listeners.delete(fn); },
    inspectAttempt(id: string) { return attempts.has(id) ? structuredClone(attempts.get(id)) : undefined; },
    async send(_prompt: string, opts: { onAdmission?: (event: any) => Promise<void> }) {
      const n = ++state.sends;
      const attempt: any = { admissionId: `controlled-${n}`, externalSessionId: session.externalSessionId, nativeSessionId: "controlled-native", dispatch: "not-dispatched", nativeOutcome: "unknown", localOutcome: "pending", events: [] };
      attempts.set(attempt.admissionId, attempt); await opts.onAdmission?.(structuredClone(attempt)); attempt.dispatch = "attempted";
      const emit = (value: any) => { const event = { ...structuredClone(attempt), ...value, timestamp: Date.now() }; attempt.events.push(event); for (const fn of listeners) fn(event); };
      if (n === 1) {
        emit({ kind: "tool_use", callId: "provider-check", toolName: "Bash", toolInput: { command: "bun check-migration.ts" } });
        emit({ kind: "tool_result", callId: "provider-check", toolName: "Bash", toolOutput: MARK, toolError: false });
      }
      Object.assign(attempt, { content: n === 1 ? "WORK_COMPLETE" : "CONTINUED", nativeOutcome: "completed", localOutcome: "resolved", terminal: { type: "result", subtype: "success" } });
      emit({ kind: "result", raw: { type: "result", subtype: "success", session_id: session.externalSessionId } });
      return structuredClone(attempt);
    } };
  const adapter: SessionAdapter = { runtime: "claude-code", async createSession() { return session; }, async getExternalSessionId() { return null; },
    async clearSession() { throw Error("No binding clear"); }, async releaseIdleSession() { state.released++; return "released"; } };
  return adapter;
}

test("real SessionBackedProvider → factory → runtime: both expert reviews receive the owned native tool result and the next input carries their knowledge", async () => {
  const state = { sends: 0, released: 0 };
  const central = new SessionBackedProvider({ id: "controlled-native", adapter: controlledAdapter(state), defaultModel: "controlled" });
  const config = starterConfig("controlled-native", "controlled");
  config.agents = { worker: { id: "worker", kind: "executor", provider: "controlled-native", model: "controlled", prompt: "Complete the requested work", temperature: 0, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } } as any;
  const stack = new ContextStack(domains.map(d => { const layer = new ContextLayer({ id: d, prompt: `Instructions for ${d}`, segment: "domain-knowledge" }); layer.set(`Domain knowledge for ${d}`); return layer; }));
  const reviews: Array<{ domain: string; text: string }> = []; const centralInputs: LLMMessage[][] = [];
  const expert: LLMProvider = { id: "controlled-expert", async complete(messages, opts = {}) {
    const domain = domains.find(d => opts.threadId?.endsWith(`:domain:${d}`));
    if (opts.threadId?.includes(":review:")) {
      const text = messages.map(m => m.content).join("\n"); reviews.push({ domain: domain!, text });
      return { model: "controlled", content: JSON.stringify(text.includes(MARK) ? { decision: "learn", knowledge: `${domain}: ${MARK}`, facts: [MARK] } : { decision: "abstain", reason: "result not supplied" }) };
    }
    return { model: "controlled", content: JSON.stringify({ domains, layers: domain ? [domain] : domains, snippets: [], confidence: 1 }) };
  } };
  const journal = new LocalSessionStore(":memory:"); const events = new EventStream();
  const manager = new ThreadRuntimeManager({ config, llm: expert, eventStream: events, log() {}, warn() {}, learning: { timeoutMs: 20, hardTimeoutMs: 1000 }, domains: domains.map(d => ({ domain: d, layerId: d, guardTriggers: [] })) } as any);
  const recording: LLMProvider = { ...central, id: central.id, nativeOwnership: central.nativeOwnership, completionLifecycle: central.completionLifecycle,
    async complete(messages, opts) { centralInputs.push(structuredClone(messages)); return central.complete(messages, opts); } } as LLMProvider;
  let registeredOwner: any; let admissionId: string | undefined;
  try {
    const factory = new ThreadFactory({ stack, runtime: manager, agents: buildAgents(config, stack, { provider: recording }) });
    const thread = factory.create("owned", { projectId: "P" }); const runtime = manager.get(thread.id)!;
    new KnowledgePersistence(manager, journal, events, [thread]);
    const dispatch = (id: string, message: string) => { journal.beginTurn(thread, id, message);
      return thread.dispatch("worker", message, undefined, { messageId: id, nativeObservation: { generation: runtime.generation,
        register: e => { registeredOwner = e.owner; admissionId = e.admissionId; return journal.registerNative(thread, e); }, observe: e => journal.appendNative(thread, e) } }); };
    await dispatch("first", "Do the migration"); await runtime.learningSettled();
    expect(registeredOwner?.providerSessionKey).toBe(thread.id); // the provider stamped the pool key; the factory projector still accepted the admission
    expect(journal.nativeHistory(thread.id, "first").find(e => e.kind === "tool_result")?.toolOutput).toBe(MARK); // raw journal first
    expect(reviews).toHaveLength(2);
    for (const domain of domains) {
      const text = reviews.find(r => r.domain === domain)!.text;
      expect(text).toContain(MARK); expect(text).toContain("provider-check");
      expect(journal.knowledge(thread.id)?.domains[domain]?.content).toBe(`${domain}: ${MARK}`);
    }
    await dispatch("next", "Continue"); await runtime.learningSettled();
    for (const domain of domains) expect(JSON.stringify(centralInputs[1])).toContain(`${domain}: ${MARK}`);
    expect(JSON.stringify(centralInputs[0])).not.toContain(MARK);
    expect(state.sends).toBe(2);
  } finally {
    if (registeredOwner && admissionId) expect(await central.completionLifecycle.releaseOwnedAdmission!(registeredOwner, admissionId)).toBe("released");
    manager.disposeAll(); journal.close();
    expect(state.released).toBeGreaterThanOrEqual(1);
  }
});
