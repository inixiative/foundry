import { expect, test } from "bun:test";
import { ContextLayer, type SourceLoadHint, type ContextSource, type SourceSelectionReport } from "../src/context-layer";
import { DEFAULT_MEMORY_SELECTION, selectMemory, type MemoryEntry } from "../src/adapters/file-memory";

const currentMessage = { messageId: "turn-a", threadId: "work", projectId: "project" };
const focus = "Zephyr rollback migration";
function audit(id: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return { id, kind: "dispatch", timestamp: 1, owner: { threadId: "work", projectId: "project" }, visibility: "thread",
    content: JSON.stringify({ messageId: "turn-a", payload: focus }), ...overrides };
}

test("only scoped current audit is excluded; publications with colliding IDs and unknown identities remain eligible", () => {
  const entries = [audit("own"), audit("other-thread", { owner: { threadId: "other", projectId: "project" }, visibility: "project" }),
    audit("other-project", { owner: { threadId: "work", projectId: "other" }, visibility: "global" }),
    audit("legacy", { owner: undefined, visibility: undefined }), audit("text-only", { content: focus + " turn-a" }),
    audit("nested", { content: JSON.stringify({ nested: { messageId: "turn-a" }, payload: focus }) }),
    audit("prior", { content: JSON.stringify({ messageId: "turn-before", payload: focus }) })];
  const before = JSON.stringify(entries);
  const policy = { ...DEFAULT_MEMORY_SELECTION, retrievalLimit: 20 };
  const { report, text } = selectMemory(entries, policy, focus, currentMessage);
  expect(report.omitted).toEqual([expect.objectContaining({ id: "own", reason: "current-message-audit", excludedFor: currentMessage })]);
  expect(report.selected.map(s => s.id).sort()).toEqual(entries.slice(1).map(e => e.id).sort());
  expect(report.retained.count).toBe(7);
  expect(report.currentMessage).toEqual(currentMessage);
  expect(text).toContain("current message's own audit");
  expect(JSON.stringify(entries)).toBe(before);
  expect(selectMemory(entries, policy, focus).report.selected).toHaveLength(7);
});

test("explicit pinned kinds take precedence even if also configured as audit, including the pre-provider block", () => {
  const entry = audit("mandatory", { kind: "requirement", content: JSON.stringify({ messageId: "turn-a", payload: focus, rule: "required ending" }) });
  const policy = { ...DEFAULT_MEMORY_SELECTION, auditOnlyKinds: [...DEFAULT_MEMORY_SELECTION.auditOnlyKinds, "requirement"] };
  expect(selectMemory([entry], policy, focus, currentMessage).report.selected[0]?.reason).toBe("pinned");
  const blocked = selectMemory([entry], { ...policy, pinnedHardCapChars: 10, oversizedPinned: "block" }, focus, currentMessage);
  expect(blocked.report.omitted[0]?.reason).toBe("required-context-blocked");
  expect(blocked.report.conflicts[0]?.kind).toBe("required-context-blocked");
});

function source() {
  const loads: SourceLoadHint[] = [];
  let report: SourceSelectionReport | undefined;
  const src: ContextSource = { id: "memory", focusable: true, async load(hint) {
    loads.push(hint ?? {});
    const result = selectMemory([audit("own")], DEFAULT_MEMORY_SELECTION, hint?.focus, hint?.currentMessage);
    report = result.report; return result.text;
  }, report: () => report };
  return { src, loads };
}

test("same text and different identity invalidates warm reuse; snapshots and no-ID loads keep honest provenance", async () => {
  const { src, loads } = source();
  const layer = new ContextLayer({ id: "memory", sources: [src] });
  const mutable = { ...currentMessage };
  layer.setFocus(focus, mutable);
  mutable.messageId = "caller-change";
  await layer.warm();
  const saved = layer.snapshotInstance();
  const historical = JSON.stringify(saved);
  expect(layer.selection?.currentMessage).toEqual(currentMessage);
  layer.setFocus(focus, { ...currentMessage });
  expect(layer.isWarm).toBe(true);
  expect(loads).toHaveLength(1);
  layer.setFocus(focus, { ...currentMessage, messageId: "turn-b" });
  expect(layer.isStale).toBe(true);
  layer.restoreInstance(saved);
  expect(layer.isStale).toBe(true);
  await layer.warm();
  expect(layer.selection?.sources[0]?.report.selected[0]?.id).toBe("own");
  expect(layer.clone().selection?.currentMessage?.messageId).toBe("turn-b");
  layer.setFocus(focus);
  expect(layer.isStale).toBe(true);
  await layer.warm();
  expect(loads.at(-1)?.currentMessage).toBeUndefined();
  expect(layer.selection?.currentMessage).toBeUndefined();
  expect(JSON.stringify(saved)).toBe(historical);
});

for (const fail of [false, "refresh", "retry"] as const) test(`identity changes during load, failure=${fail}`, async () => {
  const { src, loads } = source();
  const layer = new ContextLayer({ id: "memory", sources: [src] });
  layer.setFocus(focus, currentMessage);
  await layer.warm();
  const inner = src.load;
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>(r => { release = r; });
  const loading = new Promise<void>(r => { entered = r; });
  let calls = 0;
  src.load = async hint => {
    calls++;
    if (calls === 1) { entered(); await barrier; if (fail === "refresh") throw Error("refresh failed"); }
    if (calls === 2 && fail === "retry") throw Error("retry failed");
    return inner(hint);
  };
  const warming = layer.warm().catch(e => e);
  await loading;
  layer.setFocus(focus, { ...currentMessage, messageId: "turn-b" });
  release();
  const result = await warming;
  if (fail) {
    expect(result).toBeInstanceOf(Error);
    expect(layer.isStale).toBe(true);
    expect(layer.selection?.currentMessage).toEqual(currentMessage);
  } else {
    expect(layer.isWarm).toBe(true);
    expect(loads.at(-1)?.currentMessage?.messageId).toBe("turn-b");
    expect(layer.selection?.currentMessage?.messageId).toBe("turn-b");
  }
});
