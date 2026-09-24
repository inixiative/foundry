import { REQUIRED_CONTEXT_BLOCKED } from "../src/context-layer";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMemory, selectMemory, DEFAULT_MEMORY_SELECTION, type MemoryEntry, validateMemorySelection } from "../src/adapters/file-memory";

// G3/G7 memory selection: the owned audit log is complete and searchable; the
// automatically injected memory content is a bounded, deterministic selection
// with an explicit report of what was chosen, what was left out and why.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "foundry-memory-selection-")); dirs.push(d); return d; }

const owner = { threadId: "t1", projectId: "p1" };

test("source binding rejects an exclusion identity from a different authorized owner", async () => {
  const memory = new FileMemory(tmp());
  const currentMessage = { ...owner, messageId: "turn-a" };
  const foreign = { threadId: "other", projectId: "p1", messageId: "turn-a" };
  for (const [id, scope] of [["own", owner], ["other", foreign]] as const) {
    await memory.view(scope).write({ id, kind: "dispatch", timestamp: 1, visibility: "project",
      content: JSON.stringify({ messageId: "turn-a", payload: "Zephyr rollback migration" }) });
  }
  const source = memory.asSource("memory", { selection: {} }).bind!(owner);
  await source.load({ focus: "Zephyr rollback migration", currentMessage: foreign });
  expect(source.report!()?.currentMessage).toBeUndefined();
  expect(source.report!()?.selected.map(s => s.id).sort()).toEqual(["other", "own"]);
  await source.load({ focus: "Zephyr rollback migration", currentMessage });
  expect(source.report!()?.omitted[0]?.id).toBe("own");
  expect(source.report!()?.selected[0]?.id).toBe("other");
});
function entry(id: string, kind: string, content: string, timestamp: number): MemoryEntry {
  return { id, kind, content, timestamp, owner, visibility: "thread" };
}

describe("selectMemory", () => {
  test("audit-only kinds are never injected but are counted, and a pinned convention always is", () => {
    const entries = [
      entry("conv", "convention", "Always run typecheck before reporting done.", 10),
      ...Array.from({ length: 200 }, (_, i) => entry(`d${i}`, "dispatch", `{"payload":"irrelevant dispatch ${i} ${"x".repeat(600)}"}`, 100 + i)),
    ];
    const { text, report } = selectMemory(entries, DEFAULT_MEMORY_SELECTION);
    expect(text).toContain("Always run typecheck before reporting done.");
    expect(text).not.toContain("irrelevant dispatch");
    expect(text.length).toBeLessThan(DEFAULT_MEMORY_SELECTION.budgetChars + 1500);
    expect(report.selected.map(s => s.id)).toEqual(["conv"]);
    expect(report.selected[0]).toMatchObject({ reason: "pinned", kind: "convention" });
    expect(report.retained).toMatchObject({ count: 201 });
    expect(report.omitted.filter(o => o.reason === "audit-only")).toHaveLength(200);
    // The provider input itself says what was left out and how to reach it.
    expect(text).toMatch(/200 audit records .*not injected/);
    expect(text).toContain("retained unchanged");
    expect(text).not.toContain("memory tool");
  });

  test("selection is deterministic and bounded as irrelevant captures grow", () => {
    const base = [entry("conv", "convention", "Prefer bun test.", 1)];
    const small = selectMemory([...base, ...Array.from({ length: 20 }, (_, i) => entry(`a${i}`, "dispatch", "noise ".repeat(100), 10 + i))], DEFAULT_MEMORY_SELECTION);
    const large = selectMemory([...base, ...Array.from({ length: 2000 }, (_, i) => entry(`a${i}`, "dispatch", "noise ".repeat(100), 10 + i))], DEFAULT_MEMORY_SELECTION);
    expect(large.text.length - small.text.length).toBeLessThan(200);
    expect(selectMemory([...base], DEFAULT_MEMORY_SELECTION).text).toBe(selectMemory([...base].reverse(), DEFAULT_MEMORY_SELECTION).text);
  });

  test("an older relevant record is retrieved for the current message, with the matched terms recorded", () => {
    const entries = [
      entry("old", "dispatch", "The release-notes sample must keep byte-identical default output when grouping is off.", 1),
      ...Array.from({ length: 50 }, (_, i) => entry(`n${i}`, "dispatch", `unrelated chatter ${i}`, 100 + i)),
    ];
    const { text, report } = selectMemory(entries, DEFAULT_MEMORY_SELECTION, "Why does the release-notes grouping change default output?");
    expect(text).toContain("byte-identical default output");
    const hit = report.selected.find(s => s.id === "old");
    expect(hit?.reason).toBe("relevant");
    expect(hit?.matched).toEqual(expect.arrayContaining(["release-notes", "grouping", "default", "output"]));
    expect(report.focus?.terms).toBeGreaterThan(0);
    expect(report.selected.some(s => s.id.startsWith("n"))).toBe(false);
  });

  test("a pinned instruction that exceeds the budget is injected in full, never excerpted, and reported as a conflict", () => {
    const big = entry("rule", "instruction", "MUST-KEEP " + "detail ".repeat(400) + "OPERATIVE-ENDING", 1);
    const { text, report } = selectMemory([big], { ...DEFAULT_MEMORY_SELECTION, budgetChars: 2000, maxEntryChars: 500 });
    expect(text).toContain("MUST-KEEP");
    expect(text).toContain("OPERATIVE-ENDING");
    expect(text).not.toContain("excerpt");
    expect(report.selected[0]).toMatchObject({ id: "rule", reason: "pinned" });
    expect(report.selected[0].truncated).toBeUndefined();
    expect(report.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "pinned-over-budget", ids: ["rule"] })]));
    expect(report.budget.exceeded).toBe(true);
  });

  test("a pinned record beyond the hard cap is injected in full by default, with a visible conflict, never paraphrased", () => {
    const huge = entry("rule", "requirement", "Intro. " + "filler ".repeat(1000) + "MANDATORY-ENDING", 1);
    const { text, report } = selectMemory([huge], { ...DEFAULT_MEMORY_SELECTION, budgetChars: 2000, pinnedHardCapChars: 3000 });
    expect(text).toContain("MANDATORY-ENDING");
    expect(text).not.toContain("memory tool");
    expect(report.selected).toEqual([expect.objectContaining({ id: "rule", reason: "pinned" })]);
    expect(report.conflicts.map((c) => c.kind).sort()).toEqual(["pinned-over-budget", "pinned-oversized"]);
    expect(report.selected.length + report.omitted.length).toBe(report.considered);
  });

  test("in block mode a pinned record beyond the hard cap produces a required-context-blocked conflict instead of a paraphrase", () => {
    const huge = entry("rule", "requirement", "Intro. " + "filler ".repeat(1000) + "MANDATORY-ENDING", 1);
    const { text, report } = selectMemory([huge], { ...DEFAULT_MEMORY_SELECTION, budgetChars: 2000, pinnedHardCapChars: 3000, oversizedPinned: "block" });
    expect(text).toContain("BLOCKED");
    expect(text).not.toContain("filler filler");
    expect(text).not.toContain("memory tool");
    expect(report.selected).toEqual([]);
    expect(report.omitted).toEqual([expect.objectContaining({ id: "rule", reason: REQUIRED_CONTEXT_BLOCKED })]);
    expect(report.conflicts).toEqual([expect.objectContaining({ kind: REQUIRED_CONTEXT_BLOCKED, ids: ["rule"] })]);
  });

  test("validateMemorySelection rejects non-objects, unknown fields, non-integer or out-of-bounds numbers, bad kind lists and bad modes", () => {
    const ok = validateMemorySelection({ budgetChars: 6000, maxEntryChars: 1200, pinnedKinds: ["rule"], oversizedPinned: "block" });
    expect(ok).toEqual({ budgetChars: 6000, maxEntryChars: 1200, pinnedKinds: ["rule"], oversizedPinned: "block" });
    for (const bad of [null, [], "x", 3, { unknown: 1 }, { budgetChars: "6000" }, { budgetChars: 6000.5 }, { budgetChars: 1 },
      { maxEntryChars: -2 }, { recentLimit: Number.POSITIVE_INFINITY }, { pinnedKinds: [42] }, { pinnedKinds: ["a", "a"] },
      { auditOnlyKinds: "dispatch" }, { oversizedPinned: "drop" }, { budgetChars: 500, maxEntryChars: 600 },
      // Inherited object names are unknown fields, never numeric bounds.
      { constructor: 6000 }, { toString: 6000 }, { hasOwnProperty: 6000 }, JSON.parse('{"__proto__": 6000}')]) {
      expect(() => validateMemorySelection(bad)).toThrow(/selection policy/);
    }
    // Validation returns a copy: mutating the input afterwards cannot change the policy.
    const input = { pinnedKinds: ["rule"] };
    const copy = validateMemorySelection(input);
    input.pinnedKinds.push("later");
    expect(copy.pinnedKinds).toEqual(["rule"]);
  });

  test("a relevant excerpt is windowed around the matched evidence and states its character ranges", () => {
    const content = "prefix ".repeat(300) + "The zephyr rollback marker is TAIL-EVIDENCE-7. " + "suffix ".repeat(100);
    const long = entry("obs", "observation", content, 1);
    const { text, report } = selectMemory([long], { ...DEFAULT_MEMORY_SELECTION, maxEntryChars: 400 }, "zephyr rollback marker");
    expect(text).toContain("TAIL-EVIDENCE-7");
    expect(text).not.toContain("prefix prefix prefix prefix prefix prefix prefix prefix prefix prefix prefix prefix prefix prefix prefix prefix prefix prefix prefix prefix");
    expect(text).toMatch(/\[excerpt: chars \d+-\d+ of \d+; full record obs retained in the owned log\]/);
    const sel = report.selected[0];
    expect(sel).toMatchObject({ id: "obs", reason: "relevant", truncated: true });
    const [[a, b]] = sel.ranges!;
    expect(b - a).toBeLessThanOrEqual(400);
    expect(content.slice(a, b)).toContain("TAIL-EVIDENCE-7");
    expect(content.slice(a, b)).toContain("zephyr");
  });

  test("every considered record ends in exactly one of selected or omitted, and a fallback selection clears its earlier omission", () => {
    const entries = [entry("old", "observation", "Zephyr rollback evidence old.", 1), entry("new", "observation", "Zephyr rollback evidence new.", 2),
      entry("d1", "dispatch", "noise", 3)];
    const { report } = selectMemory(entries, { ...DEFAULT_MEMORY_SELECTION, retrievalLimit: 1, recentLimit: 2 }, "Zephyr rollback");
    const ids = (xs: { id: string }[]) => xs.map(x => x.id).sort();
    expect(ids(report.selected)).toEqual(["new", "old"]);
    expect(ids(report.omitted)).toEqual(["d1"]);
    expect(new Set([...ids(report.selected), ...ids(report.omitted)]).size).toBe(report.considered);
  });

  test("non-audit captures are taken newest first within the budget and the rest are reported as omitted for budget", () => {
    const entries = Array.from({ length: 30 }, (_, i) => entry(`c${i}`, "capture", `capture ${i} ` + "y".repeat(500), i));
    const { report } = selectMemory(entries, { ...DEFAULT_MEMORY_SELECTION, budgetChars: 2600, recentLimit: 10 });
    const recent = report.selected.filter(s => s.reason === "recent").map(s => s.id);
    expect(recent[0]).toBe("c29");
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.length).toBeLessThan(10);
    expect(report.omitted.some(o => o.reason === "budget")).toBe(true);
    expect(report.omitted.some(o => o.reason === "recent-limit")).toBe(true);
    expect(report.budget.used).toBeLessThanOrEqual(2600);
  });
});

describe("FileMemory.asSource with selection", () => {
  test("the bound source injects the bounded selection while the full log stays retrievable and searchable", async () => {
    const mem = new FileMemory(tmp());
    const view = mem.view(owner);
    await view.write({ id: "conv", kind: "convention", content: "Use rtk for shell output.", timestamp: 1 });
    for (let i = 0; i < 300; i++) await view.write({ id: `sig${i}`, kind: "dispatch", content: `dispatch record ${i} ${"z".repeat(400)}`, timestamp: 10 + i });

    const src = mem.asSource("memory-src", { selection: {} }).bind!(owner);
    const text = await src.load();
    expect(text).toContain("Use rtk for shell output.");
    expect(text).not.toContain("dispatch record 7 ");
    expect(text.length).toBeLessThan(DEFAULT_MEMORY_SELECTION.budgetChars + 1500);
    expect(src.report?.()).toMatchObject({ retained: { count: 301 } });
    // Nothing was deleted or rewritten by selecting.
    expect(mem.all()).toHaveLength(301);
    expect(view.search("dispatch record 7 ")).toHaveLength(1);
    expect(view.get("sig7")?.content).toContain("dispatch record 7");
  });

  test("a focus hint changes only the relevance section, and the report records the focus hash", async () => {
    const mem = new FileMemory(tmp());
    const view = mem.view(owner);
    await view.write({ id: "fact", kind: "dispatch", content: "The sentinel file lives in fixtures/harness-qa/native.", timestamp: 1 });
    for (let i = 0; i < 40; i++) await view.write({ id: `n${i}`, kind: "dispatch", content: `noise ${i}`, timestamp: 10 + i });
    const src = mem.asSource("memory-src", { selection: {} }).bind!(owner);
    expect(await src.load()).not.toContain("sentinel file");
    const focused = await src.load({ focus: "Where does the sentinel file live for the native fixtures?" });
    expect(focused).toContain("sentinel file lives");
    expect(src.report?.()?.focus?.hash).toBeString();
    expect(src.focusable).toBe(true);
  });

  test("selection honours ownership: a same-named thread in another project sees none of it", async () => {
    const mem = new FileMemory(tmp());
    await mem.view(owner).write({ id: "conv", kind: "convention", content: "PRIVATE-CONVENTION", timestamp: 1 });
    const other = mem.asSource("memory-src", { selection: {} }).bind!({ threadId: "t1", projectId: "p2" });
    expect(await other.load()).not.toContain("PRIVATE-CONVENTION");
    expect(other.report?.()?.retained.count).toBe(0);
  });

  test("selection is disabled explicitly with selection: false and the legacy full format is unchanged", async () => {
    const mem = new FileMemory(tmp());
    await mem.view(owner).write({ id: "a", kind: "note", content: "Note A", timestamp: 1 });
    const src = mem.asSource("memory-src", { selection: false }).bind!(owner);
    expect(await src.load()).toBe("[note] a: Note A");
    expect(src.report).toBeUndefined();
  });
});
