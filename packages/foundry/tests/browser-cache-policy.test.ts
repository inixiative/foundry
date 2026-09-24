import { expect, test } from "bun:test";
import { browserStorageNotice, browserStorageSummary, persistBrowserMessages } from "../src/viewer/ui/conversation-state.js";

// G6 cache policy: durable index rows are an optional browser cache; transient
// browser-only evidence (completed-unsaved, legacy, streaming) is what must survive.

const durable = (turnId: string) => ({ id: `m-${turnId}`, turnId, actor: "agent", content: "x".repeat(50), storage: "server", meta: { persistence: "committed", executionOutcome: "completed" } });
const user = (turnId: string) => ({ id: `u-${turnId}`, turnId, actor: "user", content: "q", storage: "server" });
const unsaved = { turnId: "t-unsaved", actor: "agent", content: "CONTROLLED_UNSAVED_RESULT", meta: { executionOutcome: "completed", persistence: "failed", turnStatus: "completed-unsaved" } };
const legacy = { actor: "user", content: "pre-journal browser row", timestamp: 1 };
const streaming = { turnId: "t-live", actor: "agent", content: "partial", streaming: true };

function quotaWriter(maxLength: number) {
  const writes: string[] = [];
  return { writes, write: (value: string) => { if (value.length > maxLength) { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; } writes.push(value); } };
}

test("a full write that fits marks every row saved, as before", () => {
  const { write, writes } = quotaWriter(Infinity);
  const out = persistBrowserMessages([user("a"), durable("a"), unsaved], write);
  expect(out.every(m => m.browserStorage?.status === "saved")).toBe(true);
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0]!)).toHaveLength(3);
});

test("when the full snapshot is refused, transient evidence is written alone and durable rows are only uncached", () => {
  const rows = [legacy, ...Array.from({ length: 30 }, (_, i) => [user(`t${i}`), durable(`t${i}`)]).flat(), unsaved, streaming];
  const { write, writes } = quotaWriter(1_500);
  const out = persistBrowserMessages(rows, write);
  expect(writes).toHaveLength(1);
  const written = JSON.parse(writes[0]!) as Array<{ content: string; browserStorage: { status: string } }>;
  expect(written.map(m => m.content)).toEqual(["pre-journal browser row", "CONTROLLED_UNSAVED_RESULT", "partial"]);
  expect(written.every(m => m.browserStorage.status === "saved")).toBe(true);
  const durableOut = out.filter(m => m.storage === "server");
  expect(durableOut).toHaveLength(60);
  expect(durableOut.every(m => m.browserStorage?.status === "not-cached" && m.browserStorage.error === "QuotaExceededError")).toBe(true);
  // Durable rows that are not cached produce no per-row notice; the transient rows are saved.
  expect(durableOut.map(browserStorageNotice).filter(Boolean)).toHaveLength(0);
  expect(out.find(m => m.content === "CONTROLLED_UNSAVED_RESULT")!.browserStorage).toEqual({ status: "saved" });
  const summary = browserStorageSummary(out)!;
  expect(summary).toMatchObject({ notCached: 60, volatile: 0, error: "QuotaExceededError", transientSaved: 3 });
  expect(summary.message).toMatch(/60 server-saved/);
  expect(summary.message).toMatch(/browser-only/);
});

test("when even the transient snapshot is refused, non-saved rows become volatile and the old snapshot is untouched", () => {
  const { write, writes } = quotaWriter(0);
  const out = persistBrowserMessages([user("a"), durable("a"), unsaved], write);
  expect(writes).toHaveLength(0);
  expect(out.every(m => m.browserStorage?.status === "volatile")).toBe(true);
  expect(browserStorageNotice(out[2]!)).toMatch(/only in this tab/);
  const summary = browserStorageSummary(out)!;
  expect(summary).toMatchObject({ notCached: 0, volatile: 3, error: "QuotaExceededError" });
});

// Rows already marked saved keep that status on a refused write (existing rule: no
// previous snapshot is compared). A changed-but-refused row is a documented limit, not asserted here.
test("no summary when nothing is uncached or volatile", () => {
  const { write } = quotaWriter(Infinity);
  expect(browserStorageSummary(persistBrowserMessages([user("a"), durable("a")], write))).toBeNull();
});

// --- D1: browser-only evidence attached to a durable interrupted row (field-specific ownership) ---
import { mergeMessageHistory, isDurableRow } from "../src/viewer/ui/conversation-state.js";

const marker = "BROWSER_ONLY_FAILURE_TOOL_RESULT";
function interruptedWithEvidence() {
  const local = [{ id: "agent-one", turnId: "one", actor: "agent", content: marker, meta: { persistence: "failed", nativeOutcome: "unknown", observedToolOutput: marker } }];
  const recorded = [{ id: "agent-one", turnId: "one", actor: "agent", content: "Interrupted", storage: "server",
    meta: { persistence: "committed", turnStatus: "interrupted", nativeOutcome: "unknown", injection: { text: "SERVER_OWNED_HEAVY_DETAIL" + "y".repeat(5000) } } }];
  return mergeMessageHistory(local, recorded);
}

test("a server row carrying browser-only failure evidence is not a disposable cache row", () => {
  const [row] = interruptedWithEvidence();
  expect(row!.storage).toBe("server");
  expect(row!.meta.browserFailureEvidence.observedToolOutput).toBe(marker);
  expect(isDurableRow(row)).toBe(false);
});

test("quota fallback persists the evidence row as a projection: evidence and identity kept, server-owned heavy detail not copied", () => {
  const rows = [...interruptedWithEvidence(), durable("bulk"), legacy];
  const { write, writes } = quotaWriter(4_000);
  const out = persistBrowserMessages(rows, write);
  expect(writes).toHaveLength(1);
  const saved = JSON.parse(writes[0]!) as any[];
  const evidence = saved.find(r => r.id === "agent-one");
  expect(evidence.meta.browserFailureEvidence.observedToolOutput).toBe(marker);
  expect(evidence.meta.turnStatus).toBe("interrupted");
  expect(JSON.stringify(saved)).not.toContain("SERVER_OWNED_HEAVY_DETAIL");
  expect(saved.some(r => r.id === "m-bulk")).toBe(false);
  expect(out.find(r => r.id === "agent-one")!.browserStorage.status).toBe("saved");
  expect(out.find(r => r.id === "m-bulk")!.browserStorage.status).toBe("not-cached");
  // Reload: the projection merges back onto the server's interrupted row and re-attaches the evidence.
  const reloaded = mergeMessageHistory(saved, [{ id: "agent-one", turnId: "one", actor: "agent", content: "Interrupted", meta: { persistence: "committed", turnStatus: "interrupted", nativeOutcome: "unknown" } }]);
  expect(reloaded.find(r => r.id === "agent-one")!.meta.browserFailureEvidence.observedToolOutput).toBe(marker);
  expect(reloaded.find(r => r.id === "agent-one")!.content).toBe("Interrupted");
});

test("when every write is refused, the evidence row is volatile with a notice that names the tab-only evidence", () => {
  const rows = [...interruptedWithEvidence(), durable("bulk")];
  const { write, writes } = quotaWriter(0);
  const out = persistBrowserMessages(rows, write);
  expect(writes).toHaveLength(0);
  const evidence = out.find(r => r.id === "agent-one")!;
  expect(evidence.browserStorage.status).toBe("volatile");
  expect(browserStorageNotice(evidence)).toMatch(/Additional failure evidence is only in this tab/);
  expect(browserStorageSummary(out)!.volatile).toBe(2);
});

test("a not-cached row that still carries browser-only evidence warns instead of implying full server recovery", () => {
  const [row] = interruptedWithEvidence();
  const notCached = { ...row, browserStorage: { status: "not-cached", error: "QuotaExceededError" } };
  expect(browserStorageNotice(notCached)).toMatch(/failure evidence for this row is only in this tab/i);
  expect(browserStorageNotice({ ...durable("plain"), browserStorage: { status: "not-cached", error: "QuotaExceededError" } })).toBeNull();
});
