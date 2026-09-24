import { expect, test } from "bun:test";
import type { SessionResult } from "../../../../agent-session/src";
import { SessionBackedProvider } from "../../../packages/foundry/src/providers/session-backed";
import type { SessionAdapter } from "../../../packages/foundry/src/providers/session-adapter";

// This is the intended additive I boundary, not proof the sibling is installed.
// Controlled typed results use the real provider; no native process is created.
function fixture(result: SessionResult) {
  let sends = 0;
  const adapter: SessionAdapter = {
    runtime: "controlled", async getExternalSessionId() { return null; }, async clearSession() { throw Error("No implicit rebind"); },
    async createSession() {
      return { externalSessionId: undefined, events: [], async start() {}, kill() {}, async send() {
        sends++; return structuredClone(result);
      } } as unknown as Awaited<ReturnType<SessionAdapter["createSession"]>>;
    },
  };
  return { provider: new SessionBackedProvider({ id: "codex", adapter, defaultModel: "gpt-6-astra" }), get sends() { return sends; } };
}

test("typed native failure is not successful text when there is no legacy Claude raw envelope", async () => {
  const f = fixture({ content: "Controlled failure text", externalSessionId: "controlled-binding", events: [],
    admissionId: "controlled-admission", nativeOutcome: "failed", localOutcome: "resolved",
    terminal: { type: "task_complete", reason: "controlled-native-failure" },
  });
  await expect(f.provider.complete([{ role: "user", content: "Work" }], { threadId: "work" })).rejects.toThrow();
  expect(f.sends).toBe(1);
});

test("typed completion identity and terminal evidence survive the provider boundary", async () => {
  const f = fixture({ content: "Completed", externalSessionId: "controlled-binding", events: [],
    admissionId: "controlled-admission", nativeOutcome: "completed", localOutcome: "resolved", transportOutcome: "open",
    terminal: { type: "task_complete", turnId: "controlled-native-turn" },
  });
  const result = await f.provider.complete([{ role: "user", content: "Work" }], { threadId: "work" });
  expect(result.content).toBe("Completed");
  expect(result.raw).toMatchObject({ admissionId: "controlled-admission", nativeOutcome: "completed", localOutcome: "resolved",
    terminal: { type: "task_complete", turnId: "controlled-native-turn" }, externalSessionId: "controlled-binding" });
  expect(f.sends).toBe(1);
});

test("legacy results without native terminal evidence are never upgraded to acknowledged completion", async () => {
  const f = fixture({ content: "Legacy local completion", externalSessionId: "controlled-binding", events: [] });
  const result = await f.provider.complete([{ role: "user", content: "Work" }], { threadId: "work" });
  expect((result.raw as { nativeOutcome?: string }).nativeOutcome).not.toBe("completed");
  expect(f.sends).toBe(1);
});
