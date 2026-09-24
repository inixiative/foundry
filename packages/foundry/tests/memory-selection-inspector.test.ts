import { expect, test } from "bun:test";
import { selectionSummary } from "../src/viewer/ui/inspector-data.js";

test("historical Selection names the scoped current-audit exclusion without claiming delivery", () => {
  const currentMessage = { messageId: "turn-a", threadId: "work", projectId: "P" };
  const stored = JSON.stringify({ included: true, selection: { sources: [{ sourceId: "memory", report: {
    selected: [], omitted: [{ id: "audit-a", reason: "current-message-audit", chars: 100, kind: "dispatch", excludedFor: currentMessage }],
    currentMessage, retained: { count: 1, chars: 100 }, budget: { chars: 6000, used: 0, exceeded: false }, conflicts: [],
  } }] } });
  const summary = selectionSummary(JSON.parse(stored))!;
  expect(summary.currentMessages).toEqual(["message turn-a; thread work; project P"]);
  expect(summary.exclusions).toEqual([{ id: "audit-a", reason: "current-message-audit", identity: "message turn-a; thread work; project P" }]);
  expect(summary.omitted[0]?.reason).toBe("current-message-audit");
  expect(summary.notice).toContain("prepared");
  expect(summary.notice).not.toContain("delivered");
  expect(selectionSummary(JSON.parse(stored))).toEqual(summary);
});

// The right panel must tell an operator what memory was automatically
// selected for a turn, what was left out and why, and where the rest lives.
// It must never describe assessed or selected data as delivered.

const layer = {
  id: "memory", included: true, content: "## Pinned (1)\n[convention] conv: keep it\n\n## Not injected\n...",
  selection: {
    focusHash: "abc123",
    sources: [{ sourceId: "memory-src", report: {
      selected: [
        { id: "conv", reason: "pinned", chars: 40, kind: "convention", timestamp: 1 },
        { id: "old", reason: "relevant", chars: 120, kind: "dispatch", timestamp: 2, matched: ["grouping", "output"] },
        { id: "rule", reason: "pinned", chars: 3000, kind: "instruction", timestamp: 3, truncated: true },
      ],
      omitted: [
        ...Array.from({ length: 300 }, (_, i) => ({ id: `d${i}`, reason: "audit-only", chars: 700, kind: "dispatch" })),
        { id: "c1", reason: "budget", chars: 500, kind: "capture" },
        { id: "c2", reason: "recent-limit", chars: 500, kind: "capture" },
      ],
      considered: 305, retained: { count: 305, chars: 214000 },
      budget: { chars: 6000, used: 3160, exceeded: false },
      conflicts: [{ kind: "pinned-over-budget", ids: ["rule"], detail: "Pinned records exceed the budget." }],
      focus: { hash: "abc123", terms: 5 },
    } }],
  },
};

test("selectionSummary reports selected records with reasons, omissions grouped by reason, budget and focus", () => {
  const summary = selectionSummary(layer);
  expect(summary).not.toBeNull();
  expect(summary!.selected.map((s: any) => [s.id, s.reason])).toEqual([["conv", "pinned"], ["old", "relevant"], ["rule", "pinned"]]);
  expect(summary!.selected[1].detail).toContain("grouping");
  expect(summary!.selected[2].detail).toContain("excerpt");
  expect(summary!.omitted).toEqual([
    { reason: "audit-only", count: 300, chars: 210000, kinds: "dispatch 300" },
    { reason: "budget", count: 1, chars: 500, kinds: "capture 1" },
    { reason: "recent-limit", count: 1, chars: 500, kinds: "capture 1" },
  ]);
  expect(summary!.budget).toEqual({ chars: 6000, used: 3160, exceeded: false });
  expect(summary!.retained).toEqual({ count: 305, chars: 214000 });
  expect(summary!.focus).toBe("5 terms from this message");
  expect(summary!.conflicts).toEqual(["pinned-over-budget: rule"]);
  // Wording keeps the boundary honest: this is what was prepared, not what the model acknowledged.
  expect(summary!.notice).toContain("prepared");
  expect(summary!.notice).not.toContain("delivered");
  expect(summary!.notice).toContain("memory tool");
});

test("selectionSummary is null for layers that do not select, and marks an excluded layer as not injected", () => {
  expect(selectionSummary({ id: "system", included: true, content: "x" })).toBeNull();
  const excluded = selectionSummary({ ...layer, included: false });
  expect(excluded!.notice).toContain("not included");
});
