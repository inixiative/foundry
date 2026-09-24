import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSessionStore } from "../src/persistence/local-session-store";
import { m0Scenario, abstain } from "./helpers/m0-domain-loop";
// @ts-ignore The production inspector is plain JavaScript.
import { guardOutcomes } from "../src/viewer/ui/inspector-data.js";

test("a configured request-journal failure must quarantine before admitting any reviewer", async () => {
  const f = await m0Scenario({ review: () => abstain });
  const runtime = f.current.manager.get("a")!;
  const store = f.current.localStore!;
  try {
    // Reject the actual SQLite write, not an absent optional persistence adapter.
    (store as unknown as { db: Database }).db.exec(`
      CREATE TRIGGER reject_requested BEFORE INSERT ON session_learning
      WHEN json_extract(NEW.record, '$.content.decision') = 'requested'
      BEGIN SELECT RAISE(ABORT, 'CONTROLLED_REQUESTED_WRITE_REFUSAL'); END
    `);
    await f.send("a", "write-failure", "Continue");
    await runtime.learningSettled();
    expect(runtime.disposed).toBe(true);
    expect(f.calls.filter(call => call.phase === "post")).toHaveLength(0);
    expect(store.learningHistory("a").filter(row =>
      (row.signal.content as { decision?: string }).decision === "learned")).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("phase idempotency includes immutable turn, dispatch and phase associations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase-identity-contract-"));
  const store = new LocalSessionStore(join(dir, "sessions.sqlite"));
  const thread = { id: "owned", meta: { projectId: "P", description: "Phase identity contract", tags: [],
    status: "idle" as const, createdAt: 1, lastActiveAt: 1 } };
  const row = { id: "request-original", turnId: "turn-1", dispatchId: "dispatch-1",
    phase: "guard-request" as const, record: { domain: "architecture" } };
  try {
    store.appendPhase(thread, row);
    const original = store.phaseHistory(thread.id);
    expect(() => store.appendPhase(thread, row)).not.toThrow();
    const accepted: string[] = [];
    for (const [field, value] of [["turnId", "turn-2"], ["dispatchId", "dispatch-2"], ["phase", "guard-outcome"]] as const) {
      try { store.appendPhase(thread, { ...row, [field]: value }); accepted.push(field); } catch {}
    }
    expect(accepted).toEqual([]);
    expect(store.phaseHistory(thread.id)).toEqual(original);
  } finally {
    store.close();
  }
});

test("guard history joins the referenced input and preserves another same-domain pending request", () => {
  const observation = { signalId: "original-signal", tool: "Write", callId: "call-1", dispatchId: "dispatch-1" };
  const association = { threadId: "owned", turnId: "turn-1", dispatchId: "dispatch-1" };
  const request = (id: string, text: string) => ({ ...association, id, phase: "guard-request",
    record: { domain: "architecture", observation, correlation: "live-dispatch",
      request: { status: "supplied", phase: "guard", providerId: "controlled", capturedAt: 1,
        messages: [{ role: "system", content: text }] } } });
  const outcome = { ...association, id: "outcome-1", phase: "guard-outcome",
    record: { observation, correlation: "live-dispatch", status: "reported", requests: { architecture: "request-1" },
      outcomes: [{ domain: "architecture", status: "completed", findings: 0, requestRecord: "request-1" }] } };
  const actual = guardOutcomes({ detail: { phases: [request("request-1", "ORIGINAL_REQUEST"),
    request("request-2", "SECOND_REQUEST"), outcome] } });
  const outcomes = actual.flatMap((entry: { outcomes: unknown[] }) => entry.outcomes);
  expect(outcomes.find((entry: { status: string }) => entry.status === "completed")?.request.messages[0].content)
    .toBe("ORIGINAL_REQUEST");
  expect(outcomes.filter((entry: { status: string }) => entry.status === "pending")).toHaveLength(1);
  expect(outcomes.find((entry: { status: string }) => entry.status === "pending")?.request.messages[0].content)
    .toBe("SECOND_REQUEST");
});
