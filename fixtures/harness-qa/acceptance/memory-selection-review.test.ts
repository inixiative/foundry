import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMemory } from "../../../packages/core/src/adapters/file-memory";
import { ContextLayer, computeHash, type ContextSource, type SourceSelectionReport } from "../../../packages/core/src/context-layer";
import { ConfigStore, starterConfig } from "../../../packages/foundry/src/viewer/config";

for (const failOn of ["refresh", "focus-retry"] as const) {
  test(`a failed ${failOn} cannot restore warm state for a different focus`, async () => {
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const loading = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    let report: SourceSelectionReport | undefined;
    const source: ContextSource = { id: "controlled-memory", focusable: true,
      async load(hint) {
        calls++;
        const focus = hint?.focus ?? "none";
        if (calls === 2) {
          entered(); await barrier;
          if (failOn === "refresh") throw Error("controlled refresh failure");
        }
        if (calls === 3) throw Error("controlled focus-retry failure");
        report = { selected: [{ id: focus, reason: "relevant", chars: focus.length }],
          omitted: [], considered: 1, retained: { count: 1, chars: focus.length },
          budget: { chars: 100, used: focus.length, exceeded: false }, conflicts: [],
          focus: { hash: computeHash(focus), terms: 1 } };
        return `selected:${focus}`;
      }, report: () => report };
    const layer = new ContextLayer({ id: "memory", sources: [source] });
    layer.setFocus("alpha");
    await layer.warm();
    expect(layer.isWarm).toBe(true);
    const refresh = layer.warm().then(() => undefined, error => error);
    try {
      await loading;
      layer.setFocus("beta");
      release();
      expect(String(await refresh)).toContain("controlled");
      expect(layer.content).toBe("selected:alpha");
      expect(layer.selection?.focusHash).toBe(computeHash("alpha"));
      expect(layer.focus).toBe("beta");
      expect(layer.isStale).toBe(true);
      expect(layer.isWarm).toBe(false);
    } finally { release(); await refresh; }
  });
}

for (const selection of [
  { maxEntryChars: -2 },
  { budgetChars: "invalid" },
  { pinnedKinds: [42] },
]) {
  test(`memory source rejects invalid runtime policy ${JSON.stringify(selection)}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "foundry-invalid-selection-"));
    try {
      const memory = new FileMemory(dir);
      await memory.load();
      // These deliberately invalid JSON values model persisted/operator input,
      // where the static TypeScript interface supplies no runtime protection.
      await expect((async () => {
        const source = memory.asSource("memory", { selection: selection as any });
        await source.load({ focus: "rollback" });
      })()).rejects.toThrow(/selection|policy|maxEntryChars|budgetChars|pinnedKinds/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("rejecting an invalid memory policy patch preserves live and persisted settings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foundry-selection-settings-"));
  try {
    const store = new ConfigStore(dir);
    const config = starterConfig("mock", "controlled");
    config.sources.memory = { id: "memory", type: "file", label: "Memory", uri: "memory", enabled: true,
      selection: { budgetChars: 6000 } };
    await store.save(config);
    const beforeLive = structuredClone(store.config);
    const beforeFile = await Bun.file(join(dir, "settings.json")).text();
    await expect(store.patch("sources", { memory: {
      ...config.sources.memory, selection: { budgetChars: "invalid" },
    } })).rejects.toThrow(/selection|policy|budgetChars/i);
    expect(store.config).toEqual(beforeLive);
    expect(await Bun.file(join(dir, "settings.json")).text()).toBe(beforeFile);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
