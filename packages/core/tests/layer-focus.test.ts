import { describe, expect, test } from "bun:test";
import { ContextLayer, computeHash, type ContextSource, type SourceLoadHint, type SourceSelectionReport } from "../src/context-layer";

// A layer can carry a message focus to sources that select content for the
// current message. Only focusable sources cause a re-warm; the selection
// report of every reporting source rides on the layer's instance snapshot.

function reportingSource(id: string): ContextSource & { loads: SourceLoadHint[] } {
  const loads: SourceLoadHint[] = [];
  let last: SourceSelectionReport | undefined;
  return {
    id, loads, focusable: true,
    async load(hint) {
      loads.push(hint ?? {});
      last = { selected: [{ id: "x", reason: hint?.focus ? "relevant" : "recent", chars: 5 }], omitted: [], considered: 1,
        retained: { count: 1, chars: 5 }, budget: { chars: 100, used: 5, exceeded: false }, conflicts: [],
        ...(hint?.focus ? { focus: { hash: "h", terms: 1 } } : {}) };
      return hint?.focus ? `focused:${hint.focus}` : "unfocused";
    },
    report: () => last,
  };
}

describe("ContextLayer focus and selection snapshot", () => {
  test("setting a focus marks a warm layer with a focusable source stale and the next warm passes the hint", async () => {
    const src = reportingSource("mem");
    const layer = new ContextLayer({ id: "memory", sources: [src] });
    await layer.warm();
    expect(layer.content).toBe("unfocused");
    layer.setFocus("find the sentinel");
    expect(layer.isStale).toBe(true);
    await layer.warm();
    expect(layer.content).toBe("focused:find the sentinel");
    expect(src.loads.at(-1)).toEqual({ focus: "find the sentinel" });
    // Same focus again is a no-op.
    layer.setFocus("find the sentinel");
    expect(layer.isWarm).toBe(true);
  });

  test("a layer whose sources are not focusable ignores focus and never re-warms for it", async () => {
    let loads = 0;
    const plain: ContextSource = { id: "docs", async load() { loads++; return "docs"; } };
    const layer = new ContextLayer({ id: "conventions", sources: [plain] });
    await layer.warm();
    layer.setFocus("anything");
    // warm() always reloads by design; the point is that focus alone does not make the layer stale.
    expect(layer.isWarm).toBe(true);
    expect(layer.isStale).toBe(false);
    expect(loads).toBe(1);
    expect(layer.snapshotInstance().selection).toBeUndefined();
  });

  test("the instance snapshot carries each reporting source's selection and survives clone and restore", async () => {
    const layer = new ContextLayer({ id: "memory", sources: [reportingSource("mem")] });
    layer.setFocus("sentinel");
    await layer.warm();
    const snapshot = layer.snapshotInstance("t1");
    expect(snapshot.selection?.focusHash).toBeString();
    expect(snapshot.selection?.sources).toEqual([expect.objectContaining({ sourceId: "mem", report: expect.objectContaining({ focus: { hash: "h", terms: 1 } }) })]);
    const clone = layer.clone({ threadId: "t1" });
    expect(clone.snapshotInstance("t1").selection).toEqual(snapshot.selection);
    const restored = new ContextLayer({ id: "memory", sources: [] });
    restored.restoreInstance(snapshot);
    expect(restored.snapshotInstance("t1").selection).toEqual(snapshot.selection);
  });

  test("a focus change during a background load reloads for the new focus so content, report and focus hash agree", async () => {
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((r) => { release = r; });
    const loading = new Promise<void>((r) => { entered = r; });
    const src = reportingSource("mem");
    const inner = src.load.bind(src);
    src.load = async (hint) => { entered(); await barrier; return inner(hint); };
    const layer = new ContextLayer({ id: "memory", sources: [src] });
    layer.setFocus("alpha");
    const warming = layer.warm();
    await loading;
    layer.setFocus("beta");
    release();
    await warming;
    expect(layer.isWarm).toBe(true);
    expect(layer.content).toBe("focused:beta");
    expect(src.loads.map((l) => l.focus)).toEqual(["alpha", "beta"]);
    expect(layer.snapshotInstance().selection?.focusHash).toBe(computeHash("beta"));
  });

  test("restoring a snapshot selected for another focus leaves the layer stale, and matching focus restores warm", async () => {
    const src = reportingSource("mem");
    const layer = new ContextLayer({ id: "memory", sources: [src] });
    layer.setFocus("alpha");
    await layer.warm();
    const snapshot = layer.snapshotInstance();

    const other = new ContextLayer({ id: "memory", sources: [reportingSource("mem")] });
    other.setFocus("beta");
    other.restoreInstance(snapshot);
    expect(other.content).toBe("focused:alpha");
    expect(other.isStale).toBe(true);
    expect(other.snapshotInstance().selection?.focusHash).toBe(computeHash("alpha"));

    const same = new ContextLayer({ id: "memory", sources: [reportingSource("mem")] });
    same.setFocus("alpha");
    same.restoreInstance(snapshot);
    expect(same.isWarm).toBe(true);

    const plain = new ContextLayer({ id: "notes", sources: [{ id: "static", async load() { return "fixed"; } }] });
    plain.restoreInstance({ ...snapshot, selection: undefined, content: "fixed" });
    expect(plain.isWarm).toBe(true);
  });

  test("manual set drops selection provenance and a failed refresh keeps the last selection labelled stale", async () => {
    const src = reportingSource("mem");
    const layer = new ContextLayer({ id: "memory", sources: [src] });
    layer.setFocus("alpha");
    await layer.warm();
    expect(layer.selection?.focusHash).toBe(computeHash("alpha"));
    layer.set("operator text");
    expect(layer.selection).toBeUndefined();

    await layer.warm();
    layer.setFocus("beta");
    expect(layer.isStale).toBe(true);
    src.load = async () => { throw new Error("source down"); };
    await expect(layer.warm()).rejects.toThrow("source down");
    expect(layer.isStale).toBe(true);
    expect(layer.content).toBe("focused:alpha");
    expect(layer.selection?.focusHash).toBe(computeHash("alpha"));
  });

  test("a failed refresh after a focus change leaves the old-focus content stale with its own provenance, whether the initial load or the retry fails", async () => {
    for (const failOn of ["refresh", "retry"] as const) {
      let calls = 0;
      let release!: () => void;
      let entered!: () => void;
      const barrier = new Promise<void>((r) => { release = r; });
      const loading = new Promise<void>((r) => { entered = r; });
      const src = reportingSource("mem");
      const inner = src.load.bind(src);
      src.load = async (hint) => {
        calls++;
        if (calls === 2) { entered(); await barrier; if (failOn === "refresh") throw new Error("controlled refresh failure"); }
        if (calls === 3) throw new Error("controlled retry failure");
        return inner(hint);
      };
      const layer = new ContextLayer({ id: "memory", sources: [src] });
      layer.setFocus("alpha");
      await layer.warm();
      const refresh = layer.warm().then(() => undefined, (e) => e);
      await loading;
      layer.setFocus("beta");
      release();
      expect(String(await refresh)).toContain("controlled");
      expect(layer.content).toBe("focused:alpha");
      expect(layer.selection?.focusHash).toBe(computeHash("alpha"));
      expect(layer.focus).toBe("beta");
      expect(layer.isStale).toBe(true);
    }
  });

  test("a failed refresh with an unchanged focus keeps the layer warm on its last good content", async () => {
    const src = reportingSource("mem");
    const layer = new ContextLayer({ id: "memory", sources: [src] });
    layer.setFocus("alpha");
    await layer.warm();
    src.load = async () => { throw new Error("down"); };
    await expect(layer.warm()).rejects.toThrow("down");
    expect(layer.isWarm).toBe(true);
    expect(layer.content).toBe("focused:alpha");
  });
});
