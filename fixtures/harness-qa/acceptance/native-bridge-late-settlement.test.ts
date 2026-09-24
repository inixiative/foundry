import { expect, test } from "bun:test";
import { ContextStack, Thread, ToolRegistry, type NativeEvidence, type NativeBridgeLease } from "../../../packages/core/src/index";
import { ThreadRuntimeManager } from "../../../packages/foundry/src/agents/thread-runtime";
import { starterConfig } from "../../../packages/foundry/src/viewer/config";
import { nativeBridgeSource } from "../../../packages/foundry/src/mcp/native-bridge";
import { SessionBackedProvider } from "../../../packages/foundry/src/providers/session-backed";
import type { SessionAdapter } from "../../../packages/foundry/src/providers/session-adapter";

// Production provider + production bridge lease, controlled session boundary.
// No model or native process; this does not establish installed protocol support.
async function fixture() {
  const thread = new Thread("late-provider-owner", new ContextStack([]), { projectId: "P" });
  const runtime = new ThreadRuntimeManager({ config: starterConfig("controlled", "controlled"), domains: [],
    llm: { id: "controlled", async complete() { throw Error("No model calls in this fixture"); } }, log() {}, warn() {} });
  const live = runtime.attach(thread);
  const source = nativeBridgeSource(thread, runtime, new ToolRegistry(), record => ({ record, persistence: "committed", publication: "published" }));
  const listeners: Array<(event: unknown) => void> = [];
  const seen: NativeEvidence[] = [];
  let bridge: NativeBridgeLease | undefined;
  const attempt = { admissionId: "first-admission", nativeOutcome: "unknown", localOutcome: "rejected",
    dispatch: "attempted", transportOutcome: "open", externalSessionId: "controlled-binding" };
  const session = { admissionProtocol: "prewrite-v1", externalSessionId: "controlled-binding",
    async start() {}, kill() {}, onEvent(fn: (event: unknown) => void) { listeners.push(fn); },
    async send(_prompt: string, options?: { onAdmission?: (attempt: unknown) => Promise<void> }) {
      await options?.onAdmission?.({ ...attempt, dispatch: "not-dispatched", localOutcome: "pending" });
      throw Object.assign(Error("CONTROLLED_OBSERVATION_TIMEOUT"), { attempt });
    } };
  const adapter: SessionAdapter = { runtime: "controlled",
    async createSession(options) { bridge = options.nativeBridge; return session as unknown as Awaited<ReturnType<SessionAdapter["createSession"]>>; },
    async getExternalSessionId() { return "controlled-binding"; }, async clearSession() {} };
  const provider = new SessionBackedProvider({ id: "controlled", adapter, defaultModel: "controlled" });
  const owner = { threadId: thread.id, projectId: "P", generation: live.generation, messageId: "first-message", dispatchId: "first-dispatch" };
  try {
    await expect(provider.complete([{ role: "user", content: "Controlled work" }], { threadId: thread.id,
      nativeObservation: { owner, bridge: source, register(e) { seen.push(e); }, observe(e) { seen.push(e); } } })).rejects.toThrow("CONTROLLED_OBSERVATION_TIMEOUT");
  } catch (error) { await bridge?.close(); runtime.disposeAll(); throw error; }
  const next: NativeEvidence = { schema: 1, admissionId: "second-admission", nativeOutcome: "unknown",
    owner: { ...owner, messageId: "second-message", dispatchId: "second-dispatch", providerSessionKey: thread.id } };
  return { bridge: bridge!, seen, next,
    emit(admissionId: string) {
      for (const listener of listeners) listener({ ...attempt, admissionId, kind: "result", nativeOutcome: "completed",
        terminal: { type: "controlled-terminal" } });
    },
    async close() { await bridge?.close(); runtime.disposeAll(); },
  };
}

test("registered late native terminal settles the original bridge lease after local timeout", async () => {
  const f = await fixture();
  try {
    expect(() => f.bridge.register(f.next)).toThrow("unresolved");
    f.emit("first-admission");
    expect(f.seen.at(-1)).toMatchObject({ admissionId: "first-admission", nativeOutcome: "completed",
      owner: { messageId: "first-message", dispatchId: "first-dispatch" } });
    expect(() => f.bridge.register(f.next)).not.toThrow();
  } finally { await f.close(); }
});

test("an unregistered native terminal cannot release the occupied bridge", async () => {
  const f = await fixture();
  try {
    const previous = f.seen.length;
    f.emit("foreign-admission");
    expect(f.seen).toHaveLength(previous);
    expect(() => f.bridge.register(f.next)).toThrow("unresolved");
  } finally { await f.close(); }
});
