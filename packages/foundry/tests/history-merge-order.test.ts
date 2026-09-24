import { expect, test } from "bun:test";
import { mergeMessageHistory } from "../src/viewer/ui/conversation-state.js";

// G6 regression: index rows carry the journal `seq`. Older pages merged into the
// cache must sort by seq, not by wall-clock timestamps that tie inside one burst.

const row = (turn: number, actor: "user" | "agent", seq: number, timestamp: number) =>
  ({ id: `m-${turn}-${actor}`, seq, threadId: "t", turnId: `turn-${turn}`, actor, content: `${actor} ${turn}`, timestamp, storage: "server" });

test("older page rows with tied timestamps sort before the cached newer rows by seq", () => {
  const T = 1_700_000_000_000;
  const cached = [row(51, "user", 101, T), row(51, "agent", 102, T), row(52, "user", 103, T), row(52, "agent", 104, T)];
  const older = [row(1, "user", 1, T), row(1, "agent", 2, T), row(2, "user", 3, T), row(2, "agent", 4, T)];
  const merged = mergeMessageHistory(cached, older);
  expect(merged.map(m => m.id)).toEqual(["m-1-user", "m-1-agent", "m-2-user", "m-2-agent", "m-51-user", "m-51-agent", "m-52-user", "m-52-agent"]);
});

test("a repeated older page changes nothing and appends nothing", () => {
  const T = 1_700_000_000_000;
  const cached = [row(51, "user", 101, T), row(51, "agent", 102, T)];
  const older = [row(1, "user", 1, T), row(1, "agent", 2, T)];
  const once = mergeMessageHistory(cached, older);
  const twice = mergeMessageHistory(once, older);
  expect(twice.map(m => m.id)).toEqual(once.map(m => m.id));
  expect(twice).toHaveLength(4);
});

test("rows without seq keep timestamp ordering; a browser-only row without seq sorts by its timestamp among seq rows", () => {
  const T = 1_700_000_000_000;
  const server = [row(3, "user", 30, T + 3000), row(3, "agent", 31, T + 3100), row(1, "user", 10, T + 1000), row(1, "agent", 11, T + 1100)];
  const browserOnly = { turnId: "turn-live", actor: "agent", content: "unsaved", timestamp: T + 2000, meta: { executionOutcome: "completed", persistence: "failed" } };
  const merged = mergeMessageHistory([browserOnly], server);
  expect(merged.map(m => m.turnId)).toEqual(["turn-1", "turn-1", "turn-live", "turn-3", "turn-3"]);
  const legacy = mergeMessageHistory([], [{ ...row(9, "user", 0, T + 9000), seq: undefined }, { ...row(8, "user", 0, T + 8000), seq: undefined }]);
  expect(legacy.map(m => m.turnId)).toEqual(["turn-8", "turn-9"]);
});
