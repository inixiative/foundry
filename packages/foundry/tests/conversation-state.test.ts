import { expect, test } from "bun:test";
import { mergeMessageHistory, updateTurnMessage } from "../src/viewer/ui/conversation-state.js";

test("interleaved stream patches update only the owning turn", () => {
  const initial = [
    { actor: "user", turnId: "a", content: "first" },
    { actor: "agent", turnId: "a", content: "", streaming: true },
    { actor: "user", turnId: "b", content: "second" },
    { actor: "agent", turnId: "b", content: "", streaming: true },
  ];
  let messages = updateTurnMessage(initial, "b", { content: "B", streaming: false });
  messages = updateTurnMessage(messages, "a", { content: "A", streaming: false });
  expect(messages.map((m: any) => m.content)).toEqual(["first", "A", "second", "B"]);
  expect(initial[1].content).toBe("");
  expect(updateTurnMessage(messages, "missing", { content: "wrong" })).toBe(messages);
});

test("server history replaces matching turn records without discarding legacy browser history", () => {
  const local = [
    { actor: "user", content: "legacy repeated request", timestamp: 1 },
    { actor: "user", content: "legacy repeated request", timestamp: 2 },
    { actor: "user", turnId: "a", content: "new request", timestamp: 3 },
    { actor: "agent", turnId: "a", content: "partial", streaming: true, timestamp: 4 },
  ];
  const server = [
    { actor: "user", turnId: "a", id: "u", content: "new request", timestamp: 3 },
    { actor: "agent", turnId: "a", id: "r", content: "durable answer", traceId: "t", timestamp: 5 },
  ];
  const merged = mergeMessageHistory(local, server);
  expect(merged.map((m: any) => m.content)).toEqual(["legacy repeated request", "legacy repeated request", "new request", "durable answer"]);
  expect(merged[0].storage).toBe("browser-only");
  expect(merged[3]).toMatchObject({ storage: "server", streaming: false, traceId: "t" });
  expect(mergeMessageHistory(merged, server)).toEqual(merged);
  expect(local[3].streaming).toBe(true);
});

test("stable trace and message IDs reconcile pre-turn-ID cache without content guessing", () => {
  const local = [{ actor: "agent", traceId: "t", content: "old", timestamp: 1 },
    { actor: "user", id: "u", content: "same", timestamp: 0 }];
  const server = [{ actor: "agent", id: "r", traceId: "t", turnId: "a", content: "recorded", timestamp: 1 },
    { actor: "user", id: "u", turnId: "a", content: "same", timestamp: 0 }];
  expect(mergeMessageHistory(local, server).map((m: any) => m.content)).toEqual(["same", "recorded"]);
  expect(mergeMessageHistory({}, server)).toHaveLength(2);
  expect(mergeMessageHistory(local, null)).toHaveLength(2);
});

test("recovered overlapping turns retain request-response grouping despite reverse completion", () => {
  const server = [
    { actor: "user", turnId: "slow", content: "SLOW", timestamp: 1 },
    { actor: "user", turnId: "fast", content: "FAST", timestamp: 2 },
    { actor: "agent", turnId: "fast", content: "fast answer", timestamp: 3 },
    { actor: "agent", turnId: "slow", content: "slow answer", timestamp: 4 },
  ];
  expect(mergeMessageHistory([], server).map((m: any) => m.content)).toEqual(["SLOW", "slow answer", "FAST", "fast answer"]);
});

test("unconfirmed browser partials keep their text but do not remain falsely streaming", () => {
  const recovered = mergeMessageHistory([{ actor: "agent", turnId: "lost", content: "partial evidence", streaming: true }], []);
  expect(recovered[0]).toMatchObject({ content: "partial evidence", streaming: false, connectionStatus: "unconfirmed", storage: "browser-only" });
});
