import { expect, test } from "bun:test";
// @ts-expect-error Existing browser module is JavaScript without a declaration file.
import { reconcileThreadMessages } from "../../../packages/foundry/src/viewer/ui/conversation-state.js";

function recorded() {
  return [{ id: "controlled-response", actor: "agent", threadId: "owner", turnId: "controlled-turn",
    content: "Same completed text", timestamp: 1,
    meta: { persistence: "committed", nativeOutcome: "unknown",
      nativeEvidence: { terminal: null as null | { type: string; eventId: string } }, delivery: {
      layers: [{ layerId: "conventions", revision: 1, hash: "controlled-original" }],
    } } }];
}

test("metadata-only native reconciliation reaches an existing observer without altering historical delivery", () => {
  const server = recorded();
  const local = reconcileThreadMessages([], server, "owner");
  const history = structuredClone(local);
  const updated = structuredClone(server);
  updated[0].meta.nativeOutcome = "completed";
  updated[0].meta.nativeEvidence.terminal = { type: "result", eventId: "controlled-terminal" };
  const next = reconcileThreadMessages(local, updated, "owner");
  expect(next[0].meta.nativeOutcome).toBe("completed");
  expect(next[0].meta.nativeEvidence.terminal).toMatchObject({ type: "result", eventId: "controlled-terminal" });
  expect(next[0].meta.delivery).toEqual(history[0].meta.delivery);
  expect(local).toEqual(history);
});

test("unchanged observed metadata retains the cache identity instead of forcing a render", () => {
  const server = recorded();
  const local = reconcileThreadMessages([], server, "owner");
  expect(reconcileThreadMessages(local, structuredClone(server), "owner")).toBe(local);
});
