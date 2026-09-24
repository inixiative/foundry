import { expect, test } from "bun:test";
import { knowledgeInspectionSummary, liveRuntimeLabel } from "../src/viewer/ui/inspector-data.js";

// D2: a /knowledge response without `learning` (as both live backends return) is missing live-state
// data, not evidence of runtime absence. Durable snapshot and history stay visible.
const snapshot = { domains: { conventions: { revision: 3, hash: "abc", author: "librarian", updatedAt: 1 } } };
const history = [{ storedAt: 1, signal: { kind: "domain_learning", content: { domain: "conventions", decision: "committed" } } }];

test("missing learning: live state not reported, durable snapshot and history preserved", () => {
  const summary = knowledgeInspectionSummary({ status: "idle", snapshot, history });
  expect(summary.learningAvailable).toBe(false);
  expect(summary.domains.map(d => d.domain)).toEqual(["conventions"]);
  expect(summary.domains[0]!.committed.available).toBe(true);
  expect(summary.history).toHaveLength(1);
  const label = liveRuntimeLabel(summary);
  expect(label.text).toMatch(/not reported by this server/i);
  expect(label.text).not.toMatch(/no owned runtime/i);
  expect(label.text).toMatch(/durable snapshot and history/i);
  expect(label.state).toBe("not-reported");
});

test("explicit reported live state reads as reporting", () => {
  const summary = knowledgeInspectionSummary({ status: "idle", snapshot, history, learning: { domains: { conventions: { status: "idle", queued: 0 } } } });
  expect(summary.learningAvailable).toBe(true);
  expect(liveRuntimeLabel(summary)).toMatchObject({ state: "reporting" });
});

test("malformed response is unavailable with a refresh hint, never a runtime-absence claim", () => {
  const summary = knowledgeInspectionSummary({ status: "idle", history: "not-a-list" });
  expect(summary.status).toBe("unavailable");
  const label = liveRuntimeLabel(summary);
  expect(label.state).toBe("unavailable");
  expect(label.text).toMatch(/malformed/i);
  expect(label.text).not.toMatch(/no owned runtime/i);
});

test("empty snapshot without learning says nothing is recorded yet and live state is not reported", () => {
  const summary = knowledgeInspectionSummary({ status: "idle", snapshot: { domains: {} }, history: [] });
  const label = liveRuntimeLabel(summary);
  expect(label.state).toBe("not-reported");
  expect(label.text).toMatch(/no durable knowledge recorded/i);
  expect(label.text).not.toMatch(/no owned runtime/i);
});
