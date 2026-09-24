import { expect, test } from "bun:test";
import { mergeMessageHistory, persistBrowserMessages, updateTurnMessage } from "../../../packages/foundry/src/viewer/ui/conversation-state.js";

function storage(limit: number) {
  let saved = "PRIOR_SNAPSHOT";
  const writes: string[] = [];
  return { writes, read: () => saved, write(value: string) {
    if (value.length > limit) throw Object.assign(Error("Controlled quota refusal"), { name: "QuotaExceededError" });
    saved = value;
    writes.push(value);
  } };
}

test("quota fallback must retain browser-only failure evidence attached to a durable interrupted row", () => {
  const marker = "BROWSER_ONLY_FAILURE_TOOL_RESULT";
  const local = [{ id: "agent-one", turnId: "one", actor: "agent", content: marker,
    meta: { persistence: "failed", nativeOutcome: "unknown", observedToolOutput: marker } }];
  const recorded = [{ id: "agent-one", turnId: "one", actor: "agent", content: "Interrupted",
    meta: { persistence: "committed", turnStatus: "interrupted", nativeOutcome: "unknown" } }];
  const reconciled = mergeMessageHistory(local, recorded);
  expect(reconciled[0].meta.browserFailureEvidence.observedToolOutput).toBe(marker);
  const durableBulk = { id: "bulk", turnId: "bulk", actor: "agent", content: "x".repeat(10_000), storage: "server" };
  const legacy = { actor: "user", content: "Another browser-only note", timestamp: 1 };
  const cache = storage(4000);
  persistBrowserMessages([...reconciled, durableBulk, legacy], cache.write);
  expect(cache.writes).toHaveLength(1);
  const reloaded = JSON.parse(cache.read());
  expect(JSON.stringify(reloaded)).toContain(marker);
  expect(reloaded.some((row: { id?: string }) => row.id === "bulk")).toBe(false);
  expect(reloaded.find((row: { id?: string }) => row.id === "agent-one")?.meta.browserFailureEvidence.observedToolOutput).toBe(marker);
});

test("normal streaming updates clear old saved status before a refused write", () => {
  const cache = storage(0);
  const prior = [{ actor: "agent", turnId: "stream", content: "earlier", streaming: true,
    browserStorage: { status: "saved" } }];
  const updated = updateTurnMessage(prior, "stream", { content: "newer unsaved delta" });
  const result = persistBrowserMessages(updated, cache.write);
  expect(result[0].content).toBe("newer unsaved delta");
  expect(result[0].browserStorage.status).toBe("volatile");
  expect(prior[0].browserStorage.status).toBe("saved");
  expect(cache.read()).toBe("PRIOR_SNAPSHOT");
});

test("quota fallback may omit plain durable rows when it saves all browser-only content", () => {
  const cache = storage(1000);
  const result = persistBrowserMessages([
    { id: "durable", actor: "agent", content: "x".repeat(10_000), storage: "server" },
    { actor: "user", content: "Browser-only note" },
  ], cache.write);
  expect(JSON.parse(cache.read()).map((row: { content: string }) => row.content)).toEqual(["Browser-only note"]);
  expect(result[0].browserStorage.status).toBe("not-cached");
  expect(result[1].browserStorage.status).toBe("saved");
});
