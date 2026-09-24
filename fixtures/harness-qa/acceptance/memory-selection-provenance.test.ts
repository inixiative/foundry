import { expect, test } from "bun:test";
import { DEFAULT_MEMORY_SELECTION, selectMemory } from "../../../packages/core/src/adapters/file-memory";
import { ContextLayer, computeHash, type ContextSource, type SourceSelectionReport } from "../../../packages/core/src/context-layer";

test("a record selected by recent fallback is not also reported as omitted by relevance", () => {
  const result = selectMemory([
    { id: "old", kind: "observation", timestamp: 1, content: "Zephyr rollback evidence old." },
    { id: "new", kind: "observation", timestamp: 2, content: "Zephyr rollback evidence new." },
  ], { ...DEFAULT_MEMORY_SELECTION, budgetChars: 2000, retrievalLimit: 1, recentLimit: 2 }, "Zephyr rollback");
  const selected = new Set(result.report.selected.map(entry => entry.id));
  expect(selected.size).toBe(2);
  expect(result.report.omitted.filter(entry => selected.has(entry.id))).toEqual([]);
  expect(result.report.selected.length + result.report.omitted.length).toBe(result.report.considered);
});

test("a focus changed during background warming cannot relabel old content as fresh for the new message", async () => {
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const loading = new Promise<void>(resolve => { entered = resolve; });
  let report: SourceSelectionReport | undefined;
  const source: ContextSource = {
    id: "controlled-focus-source", focusable: true,
    async load(hint) {
      const focus = hint?.focus ?? "none";
      entered();
      await barrier;
      report = {
        selected: [{ id: focus, reason: "relevant", chars: focus.length }], omitted: [], considered: 1,
        retained: { count: 1, chars: focus.length },
        budget: { chars: 100, used: focus.length, exceeded: false }, conflicts: [],
        focus: { hash: computeHash(focus), terms: 1 },
      };
      return `selected:${focus}`;
    },
    report: () => report,
  };
  const layer = new ContextLayer({ id: "memory", sources: [source] });
  layer.setFocus("alpha");
  const warming = layer.warm();
  try {
    await loading;
    layer.setFocus("beta");
    release();
    await warming;
    const snapshot = layer.snapshotInstance();
    expect(snapshot.selection?.focusHash).toBe(snapshot.selection?.sources[0]?.report.focus?.hash);
    if (layer.isWarm) expect(layer.content).toBe("selected:beta");
    else expect(layer.isStale).toBe(true);
  } finally {
    release();
    await warming;
  }
});
