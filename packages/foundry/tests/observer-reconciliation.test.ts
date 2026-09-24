import { expect, test } from "bun:test";
import { reconcileThreadMessages, reconcileTargets } from "../src/viewer/ui/conversation-state.js";
import { deliverySummary, knowledgeInspectionSummary } from "../src/viewer/ui/inspector-data.js";

// Written RED before the implementation. These are the pure helpers the store and
// drawer use to show externally admitted work and to inspect historical versus
// current learning without replaying work or rewriting prior inputs.

const user = (turnId: string, content: string, timestamp: number) => ({ actor: "user", turnId, content, timestamp });
const agent = (turnId: string, content: string, timestamp: number, extra: Record<string, unknown> = {}) =>
  ({ actor: "agent", turnId, content, timestamp, traceId: `trace-${turnId}`, meta: { persistence: "committed", executionOutcome: "completed" }, ...extra });

test("externally admitted durable work is appended once and the array identity is stable when nothing changed", () => {
  const cache = [user("a", "first", 1), agent("a", "A", 2)];
  const server = [user("a", "first", 1), agent("a", "A", 2), user("b", "external", 3), agent("b", "B", 4)];
  const next = reconcileThreadMessages(cache, server, "main");
  expect(next.map((m: any) => m.content)).toEqual(["first", "A", "external", "B"]);
  expect(next.filter((m: any) => m.turnId === "b")).toHaveLength(2);
  expect(reconcileThreadMessages(next, server, "main")).toBe(next);
});

test("an in-progress stream owned by this tab is never replaced by a durable row for the same turn", () => {
  const cache = [user("a", "first", 1), { actor: "agent", turnId: "a", content: "partial", streaming: true, timestamp: 2 }];
  const server = [user("a", "first", 1), agent("a", "COMPLETE", 3)];
  const next = reconcileThreadMessages(cache, server, "main");
  expect(next.find((m: any) => m.actor === "agent" && m.turnId === "a")).toMatchObject({ content: "partial", streaming: true });
  expect(next).toHaveLength(2);
});

test("a completed result that only reached this browser stays as browser-only evidence beside the journal's interrupted row", () => {
  const cache = [user("a", "first", 1), agent("a", "DONE-IN-TAB", 2, { meta: { executionOutcome: "completed", persistence: "failed" }, storage: "browser-only" })];
  const server = [user("a", "first", 1), { actor: "agent", turnId: "a", content: "interrupted", timestamp: 3, meta: { turnStatus: "interrupted" } }];
  const next = reconcileThreadMessages(cache, server, "main");
  const kept = next.find((m: any) => m.actor === "agent" && m.turnId === "a");
  expect(kept.content).toBe("DONE-IN-TAB");
  expect(kept.storage).toBe("browser-only");
  expect(kept.journalRecord?.meta?.turnStatus).toBe("interrupted");
});

test("rows that name another thread are never written into this thread's cache", () => {
  const cache = [user("a", "first", 1), agent("a", "A", 2)];
  const server = [user("a", "first", 1), agent("a", "A", 2), { ...user("z", "foreign", 9), threadId: "other" }];
  expect(reconcileThreadMessages(cache, server, "main")).toBe(cache);
});

test("reconcile targets name the owning thread for completed work and learning, and ignore token-level noise", () => {
  expect(reconcileTargets({ kind: "signal", threadId: "main", signal: { kind: "dispatch", content: { ok: true, messageId: "m1" } } }))
    .toEqual({ threadId: "main", messages: true, knowledge: false });
  expect(reconcileTargets({ kind: "signal", threadId: "main", signal: { kind: "domain_learning", content: { decision: "delayed" } } }))
    .toEqual({ threadId: "main", messages: false, knowledge: true });
  expect(reconcileTargets({ kind: "signal", threadId: "main", signal: { kind: "context_loaded" } })).toBeNull();
  expect(reconcileTargets({ kind: "error", threadId: "main", message: "x" })).toEqual({ threadId: "main", messages: true, knowledge: false });
  expect(reconcileTargets({ kind: "session", event: { type: "thread:added", threadId: "b" } })).toBeNull();
  expect(reconcileTargets({ kind: "signal", signal: { kind: "dispatch" } })).toBeNull();
});

test("historical delivery metadata is read from the trace, else from the matching durable message, never from current state", () => {
  const pending = { learningBarrier: { outcome: "pending", waitedMs: 0, pending: [{ domain: "conventions", reviews: 1 }], stale: ["conventions"] },
    layers: [{ id: "conventions", deliveredHash: "h1", assessedHash: "h1", drift: false }], committed: [{ id: "conventions", hash: "h1" }] };
  const fromMessage = deliverySummary({ id: "t" }, { traceId: "t", meta: { delivery: pending } });
  expect(fromMessage.source).toBe("message");
  expect(fromMessage.learning).toMatchObject({ outcome: "pending", waitedMs: 0, historical: true });
  expect(fromMessage.learning.pending).toEqual([{ domain: "conventions", reviews: 1 }]);
  expect(fromMessage.learning.label).toMatch(/learning[^\n]*pending/i);
  expect(fromMessage.learning.label).toMatch(/0 ?ms/);
  expect(fromMessage.learning.label).not.toMatch(/current/i);
  expect(fromMessage.layers[0]).toMatchObject({ id: "conventions", drift: false });
  const fromTrace = deliverySummary({ id: "t", delivery: { learningBarrier: { outcome: "none", waitedMs: 0, pending: [], stale: [] }, layers: [], committed: [] } }, undefined);
  expect(fromTrace.source).toBe("trace");
  expect(fromTrace.learning.outcome).toBe("none");
  expect(deliverySummary({ id: "t" }, { traceId: "t", meta: {} })).toBeNull();
  expect(deliverySummary({ id: "t" }, undefined)).toBeNull();
});

test("an unfamiliar recorded barrier outcome is shown as recorded, not assumed pending or complete", () => {
  const summary = deliverySummary({ id: "t" }, { traceId: "t", meta: { delivery: { learningBarrier: { outcome: "closed", waitedMs: 0, pending: [], stale: [] } } } });
  expect(summary.learning.outcome).toBe("closed");
  expect(summary.learning.known).toBe(false);
  expect(summary.learning.label).toContain("closed");
  expect(summary.learning.label).not.toMatch(/pending/i);
});

const sample = {
  status: "empty", snapshot: null, history: [],
  learning: { domains: { conventions: {
    status: "delayed", queued: 1, queuedEvidence: [{ kind: "dispatch", id: "sig-2", messageId: "visual-before-commit", timestamp: 2 }],
    localSettled: false, nativeOutcome: "unknown", deadlineAt: 120,
    job: { id: "review_1", domain: "conventions", threadId: "main", generation: "runtime_1", epoch: 0,
      evidence: { kind: "dispatch", id: "sig-1", messageId: "visual-origin", timestamp: 1 },
      base: { revision: 0, hash: "409638ee2bde459" }, admittedAt: 1, eligibleUntil: 120001,
      segments: { instructions: "REVIEW INSTRUCTIONS", domainKnowledge: "Configured domain knowledge", threadKnowledge: "" },
      requested: { model: "explicit-review-model", maxTokens: 1600, thinking: "high", tools: false, maxTurns: 1, timeout: 0 },
      providerId: "claude-code",
      budgets: { maxKnowledgeChars: 4000, maxResponseChars: 20000, nativeTokens: "requested-unenforced", nativeEffort: "requested-unenforced" } },
  } } },
};

test("current knowledge inspection separates status, queue, committed revision, ownership, requested config and segments", () => {
  const summary = knowledgeInspectionSummary(sample);
  expect(summary.status).toBe("empty");
  const domain = summary.domains[0];
  expect(domain).toMatchObject({ domain: "conventions", status: "delayed", known: true, queued: 1 });
  expect(domain.queuedEvidence).toEqual(["message visual-before-commit (sig-2)"]);
  expect(domain.committed).toMatchObject({ revision: 0, available: false });
  expect(domain.job).toMatchObject({ id: "review_1", threadId: "main", generation: "runtime_1", epoch: 0, baseRevision: 0, evidenceMessageId: "visual-origin" });
  expect(domain.requested.items.find((i: any) => i.label === "model")).toMatchObject({ value: "explicit-review-model", acknowledged: false });
  expect(domain.requested.notice).toMatch(/requested/i);
  expect(domain.requested.notice).not.toMatch(/acknowledged by/i);
  expect(domain.requested.limits).toEqual(expect.arrayContaining([expect.stringMatching(/tokens.*not enforced/i), expect.stringMatching(/effort.*not enforced/i)]));
  expect(domain.segments).toEqual({ instructions: "REVIEW INSTRUCTIONS", domainKnowledge: "Configured domain knowledge", threadKnowledge: "", source: "job" });
  expect(domain.nativeOutcome).toBe("unknown");
});

test("a committed durable snapshot yields the latest committed revision and thread knowledge even without an active job", () => {
  const committed = { status: "durable", history: [],
    snapshot: { threadId: "main", capturedAt: 5, domains: { conventions: { revision: 1, hash: "abc", author: "conventions-reviewer", updatedAt: 5, content: "Zephyr fact", evidence: [] } } },
    learning: { domains: { conventions: { status: "learned", queued: 0, queuedEvidence: [] } } } };
  const domain = knowledgeInspectionSummary(committed).domains[0];
  expect(domain.committed).toMatchObject({ revision: 1, hash: "abc", author: "conventions-reviewer", available: true });
  expect(domain.segments).toMatchObject({ threadKnowledge: "Zephyr fact", source: "snapshot" });
  expect(domain.segments.instructions).toBeUndefined();
  expect(domain.job).toBeNull();
});

test("unknown future statuses and unavailable endpoints are reported as such, never as pending or zero", () => {
  const future = knowledgeInspectionSummary({ status: "durable", snapshot: null, history: [],
    learning: { domains: { conventions: { status: "not-admitted", queued: 3, queuedEvidence: [] } } } });
  expect(future.domains[0]).toMatchObject({ status: "not-admitted", known: false, queued: 3 });
  expect(future.domains[0].statusLabel).toContain("not-admitted");
  expect(future.domains[0].statusLabel).not.toMatch(/pending/i);
  const unavailable = knowledgeInspectionSummary({ status: "unavailable", error: "Durable knowledge runtime is not configured" });
  expect(unavailable).toMatchObject({ status: "unavailable", domains: [] });
  expect(unavailable.error).toContain("not configured");
  const noRuntime = knowledgeInspectionSummary({ status: "durable", snapshot: null, history: [] });
  expect(noRuntime.domains).toEqual([]);
  expect(noRuntime.learningAvailable).toBe(false);
  expect(knowledgeInspectionSummary(null)).toMatchObject({ status: "unavailable", domains: [] });
});
