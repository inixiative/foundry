import { expect, test } from "bun:test";
import { expertParticipants, learningEntries, explanationLabel, domainUnderstanding, knowledgeInspectionSummary, deliverySummary } from "../src/viewer/ui/inspector-data.js";

// CORE-006 M1/M2: the inspector reads recorded fields only and labels absence as absence.

const participantsFixture = {
  decoration: {
    input: { hash: "in-1", capturedAt: 5 },
    blocks: [], omissions: [{ id: "security", reason: "timeout" }], conflicts: [],
    participants: [
      { id: "architecture", decision: "contribute", segments: { instructions: "I_A", domainKnowledge: "D_A", threadKnowledge: "T_A rev1" }, provenance: { threadKnowledgeRevision: 1, cacheHash: "c1", snippets: ["architecture guidance: x"], confidence: 1, deliveredCacheHash: "c1", revisionDrift: false } },
      { id: "testing", decision: "abstain", segments: { instructions: "I_T", domainKnowledge: "D_T", threadKnowledge: "" }, provenance: { threadKnowledgeRevision: 0, snippets: [] } },
    ],
  },
};

test("participants: exact recorded segments, revision, decision and guidance; empty thread understanding is empty, not absent", () => {
  const record = expertParticipants(participantsFixture)!;
  expect(record.participants.map((p: any) => p.id)).toEqual(["architecture", "testing"]);
  const [a, t] = record.participants;
  expect(a!).toMatchObject({ decision: "contribute", revision: 1, cacheHash: "c1", revisionDrift: false, snippets: ["architecture guidance: x"] });
  expect(a!.segments).toEqual({ instructions: "I_A", domainKnowledge: "D_A", threadKnowledge: "T_A rev1" });
  expect(t!).toMatchObject({ decision: "abstain", revision: 0, reason: null, snippets: [] });
  expect(t!.segments.threadKnowledge).toBe("");
  expect(record.omissions).toEqual([{ id: "security", reason: "timeout" }]);
});

test("participants: no decoration means not recorded (null), never an empty participant list", () => {
  expect(expertParticipants({ userMessage: "old record", blocks: [] })).toBeNull();
  expect(expertParticipants(undefined)).toBeNull();
  const partial = expertParticipants({ decoration: { participants: [{ id: "x", decision: "contribute", segments: {}, provenance: {} }] } })!;
  expect(partial.participants[0]!.segments).toEqual({ instructions: null, domainKnowledge: null, threadKnowledge: null });
  expect(partial.participants[0]!.revision).toBeNull();
});

const history = [
  { storedAt: 10, signal: { id: "s1", kind: "domain_learning", content: { domain: "architecture", decision: "learned", revision: 1, author: "architecture-reviewer", evidence: { messageId: "t1" }, job: { base: { revision: 0 } } } } },
  { storedAt: 11, signal: { id: "s2", kind: "domain_learning", content: { domain: "testing", decision: "delayed", reason: "soft observation expired; review remains eligible and owned", evidence: { messageId: "t1" } } } },
  { storedAt: 12, signal: { id: "s3", kind: "domain_learning", content: { domain: "architecture", decision: "abstain", reason: "No additional owned interpretation.", evidence: { messageId: "t2" } } } },
];

test("learning entries and explanation: a learned record without a reason is labelled absent, an abstention keeps its recorded reason", () => {
  const entries = learningEntries(history);
  expect(entries.map((e: any) => [e.domain, e.decision, e.revision, e.baseRevision, e.evidenceMessageId])).toEqual([
    ["architecture", "learned", 1, 0, "t1"], ["testing", "delayed", null, null, "t1"], ["architecture", "abstain", null, null, "t2"]]);
  expect(explanationLabel(entries[0]!)).toMatchObject({ state: "absent" });
  expect(explanationLabel(entries[0]!).text).toMatch(/not recorded by the runtime/);
  expect(explanationLabel(entries[2]!)).toEqual({ state: "recorded", text: "No additional owned interpretation." });
  expect(explanationLabel(null)).toMatchObject({ state: "none" });
  expect(learningEntries(history, "testing")).toHaveLength(1);
});

test("domain understanding: committed revision, before→after change, latest post-hook versus committed evidence, and pending keeps last committed readable", () => {
  const payload = { status: "durable", history,
    snapshot: { domains: { architecture: { revision: 1, hash: "h1", author: "architecture-reviewer", updatedAt: 10, content: "ARCH_a interpretation" } } },
    learning: { domains: { architecture: { status: "idle" }, testing: { status: "delayed", queued: 1 } } } };
  const summary = knowledgeInspectionSummary(payload);
  const arch = domainUnderstanding(summary, summary.history, "architecture");
  expect(arch).toMatchObject({ present: true, revision: 1, state: "committed", content: "ARCH_a interpretation", revisionChange: "0 → 1" });
  expect(arch.latest!.decision).toBe("abstain"); expect(arch.latest!.evidenceMessageId).toBe("t2");
  expect(arch.latestLearned!.evidenceMessageId).toBe("t1");
  const testing = domainUnderstanding(summary, summary.history, "testing");
  expect(testing).toMatchObject({ present: true, revision: 0, state: "none", status: "delayed", content: null, revisionChange: "0 (nothing committed)" });
  expect(testing.explanation).toMatchObject({ state: "recorded" });
  expect(domainUnderstanding(summary, summary.history, "security").present).toBe(false);
});

test("historical delivery is read from the owned detail row when the index row carries no delivery record", () => {
  const detailRow = { actor: "agent", meta: { delivery: { layers: [], committed: ["architecture"], learningBarrier: { outcome: "pending", waitedMs: 0, pending: [{ domain: "testing", reviews: 1 }] } } } };
  const indexRow = { actor: "agent", meta: { turnStatus: "completed" } };
  expect(deliverySummary({}, indexRow)).toBeNull();
  const summary = deliverySummary({}, detailRow)!;
  expect(summary.learning!.outcome).toBe("pending");
  expect(summary.learning!.label).toMatch(/pending \(historical/);
  expect(summary.learning!.pending).toEqual([{ domain: "testing", reviews: 1 }]);
});

// --- Snapshot evidence independent of the bounded history window; strict matching of learn outcomes ---
import { knowledgeEmptyLabel, expertAbsenceLabel } from "../src/viewer/ui/inspector-data.js";

const snapshotEvidence = [{ kind: "dispatch", id: "sig-x", messageId: "evidence-origin", agentId: "worker", ok: true, timestamp: 9 }];
const snapshotOnly = { status: "durable", history: [{ storedAt: 20, signal: { id: "s9", kind: "domain_learning", content: { domain: "architecture", decision: "abstain", reason: "Nothing new.", evidence: { messageId: "later-abstention" } } } }],
  snapshot: { domains: { architecture: { revision: 1, hash: "h1", author: "architecture-reviewer", updatedAt: 10, content: "ARCH interpretation", evidence: snapshotEvidence } } },
  learning: { domains: { architecture: { status: "idle" } } } };

test("committed revision provenance comes from the snapshot's own evidence when the recent history omits the learn outcome", () => {
  const summary = knowledgeInspectionSummary(snapshotOnly);
  expect(summary.domains[0]!.committed).toHaveProperty("evidence", snapshotEvidence);
  const und = domainUnderstanding(summary, summary.history, "architecture");
  expect(und).toMatchObject({ state: "committed", revision: 1, latestLearned: null, matchedLearn: null, revisionEvidenceMessageId: "evidence-origin" });
  expect(und.revisionChange).toMatch(/→ 1 \(before-revision not in the recent history window\)/);
  expect(und.revisionExplanation.state).toBe("unavailable");
  expect(und.explanation).toEqual({ state: "recorded", text: "Nothing new." }); // latest review, distinct from the revision's outcome
});

test("an older or mismatched learned event is not attached to a newer durable snapshot", () => {
  const stale = { ...snapshotOnly, history: [{ storedAt: 5, signal: { id: "s0", kind: "domain_learning", content: { domain: "architecture", decision: "learned", revision: 1, reason: "old", evidence: { messageId: "other-turn" }, job: { base: { revision: 0 } } } } }],
    snapshot: { domains: { architecture: { ...snapshotOnly.snapshot.domains.architecture, revision: 2 } } } };
  const und = domainUnderstanding(knowledgeInspectionSummary(stale), stale.history, "architecture");
  expect(und.revision).toBe(2); expect(und.matchedLearn).toBeNull();
  expect(und.revisionEvidenceMessageId).toBe("evidence-origin");
  expect(und.revisionChange).toBe("→ 2 (before-revision not in the recent history window)");
  const mismatchedTurn = { ...snapshotOnly, history: [{ storedAt: 5, signal: { id: "s0", kind: "domain_learning", content: { domain: "architecture", decision: "learned", revision: 1, evidence: { messageId: "other-turn" } } } }] };
  expect(domainUnderstanding(knowledgeInspectionSummary(mismatchedTurn), mismatchedTurn.history, "architecture").matchedLearn).toBeNull();
});

test("a matching learn outcome without a base revision reports the before-revision as unrecorded, never 0", () => {
  const matching = { ...snapshotOnly, history: [{ storedAt: 5, signal: { id: "s1", kind: "domain_learning", content: { domain: "architecture", decision: "learned", revision: 1, evidence: { messageId: "evidence-origin" } } } }] };
  const und = domainUnderstanding(knowledgeInspectionSummary(matching), matching.history, "architecture");
  expect(und.matchedLearn?.evidenceMessageId).toBe("evidence-origin");
  expect(und.revisionChange).toBe("unrecorded → 1");
  expect(und.revisionExplanation.state).toBe("absent");
});

test("legacy servers: unreported live state is not read as empty or not-configured", () => {
  const legacy = knowledgeInspectionSummary({ status: "empty", snapshot: null, history: [] });
  expect(knowledgeEmptyLabel(legacy)).toMatchObject({ state: "unreported" });
  expect(expertAbsenceLabel(legacy, "architecture")).toMatchObject({ state: "unavailable" });
  const live = knowledgeInspectionSummary({ status: "empty", snapshot: null, history: [], learning: { domains: {} } });
  expect(knowledgeEmptyLabel(live)).toMatchObject({ state: "empty" });
  expect(expertAbsenceLabel(live, "architecture")).toMatchObject({ state: "not-configured" });
  expect(expertAbsenceLabel(knowledgeInspectionSummary(null), "x")).toMatchObject({ state: "unavailable" });
});
