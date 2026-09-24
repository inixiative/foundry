import { expect, test } from "bun:test";
import { LocalSessionStore } from "../src/persistence/local-session-store";
import { prepareCheckpointImport } from "../src/persistence/checkpoint-import";

function checkpoint() {
  return { version: 1, restartCandidate: true, activeThreadIds: [], finishedAt: "2026-09-06T22:00:00Z",
    threads: [{ threadId: "a", projectId: "P", meta: { projectId: "P", description: "Human name", tags: ["keep"], status: "idle", createdAt: 1, lastActiveAt: 2 } }],
    traces: [{ id: "trace-1", messageId: "turn-1", startedAt: 1, endedAt: 2, durationMs: 1,
      summary: { traceId: "trace-1", messageId: "turn-1" }, root: { id: "span-1", kind: "execute", status: "ok", children: [],
        annotations: { injection: { userMessage: "Original", layers: [{ threadId: "a", content: "Exact at-turn input" }] } } } }],
  };
}

test("checkpoint import preserves metadata and trace evidence without inventing completed turns", () => {
  const raw = checkpoint(); const store = new LocalSessionStore(":memory:");
  try {
    const batch = prepareCheckpointImport(raw, "/qa/checkpoint.json");
    store.importCheckpoint(batch);
    expect(store.threads()[0].meta.description).toBe("Human name");
    expect(store.trace("trace-1")!.root).toEqual(raw.traces[0].root);
    expect(store.traceForTurn("turn-1")!.root).toEqual(raw.traces[0].root);
    expect(store.traces()).toHaveLength(1);
    expect(store.turn("turn-1")).toBeUndefined();
    expect(store.messages("a")).toHaveLength(0);
    expect((store.trace("trace-1") as any).archive.kind).toBe("checkpoint-import");
    store.importCheckpoint(batch);
    expect(store.traces()).toHaveLength(1);
  } finally { store.close(); }
});

test("active or ambiguously owned checkpoint evidence cannot be assigned to a guessed thread", () => {
  const active = checkpoint(); active.activeThreadIds = ["a"] as never[];
  expect(() => prepareCheckpointImport(active, "checkpoint.json")).toThrow("idle");
  const unowned = checkpoint(); unowned.traces[0].root.annotations.injection.layers = [];
  expect(prepareCheckpointImport(unowned, "checkpoint.json").excluded).toHaveLength(1);
  const mixed = checkpoint(); mixed.traces[0].root.annotations.injection.layers.push({ threadId: "b", content: "Other owner" });
  expect(prepareCheckpointImport(mixed, "checkpoint.json").traces).toHaveLength(0);
});

test("archive conflicts roll back an entire import and old metadata cannot overwrite a later rename", () => {
  const store = new LocalSessionStore(":memory:");
  try {
    const raw = checkpoint(); store.importCheckpoint(prepareCheckpointImport(raw, "first.json"));
    store.saveThread({ id: "a", meta: { ...store.threads()[0].meta, description: "New human name" } });
    store.importCheckpoint(prepareCheckpointImport(raw, "repeat.json"));
    expect(store.threads()[0].meta.description).toBe("New human name");
    raw.threads.push({ ...raw.threads[0], threadId: "b" });
    raw.traces[0].root.annotations.injection.userMessage = "Changed evidence";
    expect(() => store.importCheckpoint(prepareCheckpointImport(raw, "conflict.json"))).toThrow("conflict");
    expect(store.threads()).toHaveLength(1);
    expect((store.trace("trace-1")!.root as any).annotations.injection.userMessage).toBe("Original");
  } finally { store.close(); }
});
