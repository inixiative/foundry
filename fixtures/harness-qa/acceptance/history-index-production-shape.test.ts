import { expect, test } from "bun:test";
import { ContextStack, Thread } from "../../../packages/core/src";
import { LocalSessionStore } from "../../../packages/foundry/src/persistence/local-session-store";
import type { PersistedTraceRecord } from "../../../packages/foundry/src/persistence/trace-record";

const hidden = "HIDDEN_DETAIL_NOT_FOR_INDEX_" + "x".repeat(200_000);
const layers = [{ id: "conventions", hash: "recorded-hash", tokens: 73 }];

function fixture() {
  const store = new LocalSessionStore(":memory:");
  const thread = new Thread("history-shape", new ContextStack(), { projectId: "history-qa" });
  const turnId = "shape-turn";
  const trace = {
    id: "shape-trace", messageId: turnId, startedAt: 1, endedAt: 2, durationMs: 1,
    root: { id: "shape-span", name: "ingress", kind: "ingress", threadId: thread.id,
      status: "ok", startedAt: 1, endedAt: 2, durationMs: 1, annotations: {}, children: [] },
    summary: { traceId: "shape-trace", messageId: turnId, totalDurationMs: 1, spanCount: 1, stages: [] },
  } as PersistedTraceRecord;
  store.beginTurn(thread, turnId, "Small user message");
  store.completeTurn(thread, turnId, "Small answer", {
    injectedLayers: layers,
    injection: { text: hidden, layers: [], blocks: [], providerMessages: [] },
    providerTranscript: hidden,
    executionOutcome: "completed", nativeOutcome: "unknown",
  }, trace);
  return { store, thread, turnId };
}

test("real layer chip identity/hash/token metadata survives the summary without hidden context", () => {
  const { store, thread } = fixture();
  try {
    const row = store.messageIndex(thread.id).messages.find(message => message.actor === "agent")!;
    expect(row.meta?.injectedLayers).toEqual(layers);
    expect(row.detail.injection).toBe(true);
    expect(row.meta?.injection).toBeUndefined();
  } finally { store.close(); }
});

test("opaque primitive provider metadata remains in detail, not the lightweight index", () => {
  const { store, thread, turnId } = fixture();
  try {
    expect(store.turnDetail(thread.id, turnId)!.messages.find(message => message.actor === "agent")!.meta?.providerTranscript).toBe(hidden);
    const index = store.messageIndex(thread.id);
    expect(JSON.stringify(index).includes("HIDDEN_DETAIL_NOT_FOR_INDEX_")).toBe(false);
    expect(JSON.stringify(index).length).toBeLessThan(10_000);
  } finally { store.close(); }
});

test("index loading does not JSON-decode a full hidden metadata payload and discard it", () => {
  const { store, thread } = fixture();
  const original = JSON.parse;
  const heavyParses: number[] = [];
  try {
    // Observe only decoding across the SQLite-to-JavaScript boundary during index loading.
    JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      if (text.includes("HIDDEN_DETAIL_NOT_FOR_INDEX_")) heavyParses.push(text.length);
      return original(text, reviver);
    }) as typeof JSON.parse;
    expect(store.messageIndex(thread.id).messages).toHaveLength(2);
  } finally { JSON.parse = original; store.close(); }
  expect(heavyParses).toEqual([]);
});

test("full history and owned detail retain the original metadata and reject a foreign owner", () => {
  const { store, thread, turnId } = fixture();
  try {
    const full = store.messages(thread.id).find(message => message.actor === "agent")!;
    expect(full.meta?.injectedLayers).toEqual(layers);
    expect(full.meta?.providerTranscript).toBe(hidden);
    expect(store.turnDetail(thread.id, turnId)!.messages.find(message => message.actor === "agent")).toEqual(full);
    expect(store.turnDetail("foreign-thread", turnId)).toBeUndefined();
  } finally { store.close(); }
});
