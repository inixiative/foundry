import { expect, test } from "bun:test";
import type { NativeEvidence, NativeOwner, ToolCallObservation } from "../../../packages/core/src";
import { createNativeToolProjector } from "../../../packages/foundry/src/agents/native-tool-projection";
import { SessionBackedProvider } from "../../../packages/foundry/src/providers/session-backed";
import type { SessionAdapter } from "../../../packages/foundry/src/providers/session-adapter";

test("tool projection accepts the owned admission identity produced by the actual session-backed provider", async () => {
  const owner: NativeOwner = { threadId: "owned", projectId: "P", generation: "g", messageId: "m", dispatchId: "d" };
  const projected: ToolCallObservation[] = [];
  const projector = createNativeToolProjector({ owner, observeTool: value => projected.push(value) });
  const registered: NativeEvidence[] = [], journal: NativeEvidence[] = [];
  const listeners = new Set<(event: any) => void>();
  const attempts = new Map<string, any>();
  let released = false;
  const session: any = {
    admissionProtocol: "prewrite-v1", turnBudgetProtocol: "optional-max-turns-v1", externalSessionId: "controlled-binding",
    async start() {}, kill() { throw Error("No process exists to kill"); },
    onEvent(listener: (event: any) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    inspectAttempt(id: string) { return attempts.has(id) ? structuredClone(attempts.get(id)) : undefined; },
    async send(_prompt: string, opts: { onAdmission?: (event: any) => Promise<void> }) {
      const attempt: any = { admissionId: "controlled-admission", externalSessionId: session.externalSessionId,
        nativeSessionId: "controlled-native", dispatch: "not-dispatched", nativeOutcome: "unknown", localOutcome: "pending", events: [] };
      attempts.set(attempt.admissionId, attempt);
      await opts.onAdmission?.(structuredClone(attempt));
      attempt.dispatch = "attempted";
      const emit = (value: any) => {
        const event = { ...structuredClone(attempt), ...value, timestamp: Date.now() };
        attempt.events.push(event);
        for (const listener of listeners) listener(event);
      };
      emit({ kind: "tool_use", callId: "check", toolName: "Bash", toolInput: { command: "controlled command; not executed" } });
      emit({ kind: "tool_result", callId: "check", toolName: "Bash", toolOutput: "CONTROLLED_PUBLIC_RESULT", toolError: false });
      Object.assign(attempt, { content: "WORK_COMPLETE", nativeOutcome: "completed", localOutcome: "resolved", terminal: { type: "result", subtype: "success" } });
      emit({ kind: "result", raw: { type: "result", subtype: "success", session_id: session.externalSessionId } });
      return structuredClone(attempt);
    },
  };
  const adapter: SessionAdapter = { runtime: "claude-code", async createSession() { return session; },
    async getExternalSessionId() { return null; }, async clearSession() { throw Error("No binding clear"); },
    async releaseIdleSession() { released = true; return "released"; } };
  const provider = new SessionBackedProvider({ id: "controlled", adapter, defaultModel: "controlled" });
  try {
    await provider.complete([{ role: "user", content: "Controlled provider-owner probe" }], { threadId: owner.threadId,
      nativeObservation: { owner,
        register(evidence) { registered.push(evidence); projector.register(evidence); },
        observe(evidence) { journal.push(evidence); projector.observe(evidence); } } });
    expect(registered[0]?.owner?.providerSessionKey).toBe(owner.threadId);
    expect(journal.some(e => e.kind === "tool_result" && e.toolOutput === "CONTROLLED_PUBLIC_RESULT")).toBe(true);
    expect(projected).toHaveLength(1);
    expect(projected[0]?.outputSummary).toBe("CONTROLLED_PUBLIC_RESULT");
  } finally {
    const evidence = registered[0];
    if (evidence?.owner && evidence.admissionId) {
      expect(await provider.completionLifecycle.releaseOwnedAdmission!(evidence.owner, evidence.admissionId)).toBe("released");
    }
    expect(released).toBe(true);
  }
});
