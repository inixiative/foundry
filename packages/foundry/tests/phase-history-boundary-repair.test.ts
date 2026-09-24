import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSessionStore } from "../src/persistence/local-session-store";
import { durabilityFixture, untilSettled } from "./phase-history-durability.test";
// @ts-ignore untyped viewer module (plain JS)
import { guardOutcomes } from "../src/viewer/ui/inspector-data.js";

// Author coverage for the three boundary repairs (Fable, CORE-006 LI), beside the parent's protected contract.

const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });
const GUARD = "## Response protocol (guard phase)";

test("appendPhase: exact replay with null correlations is idempotent; any contradicted association is refused and the original row is untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase-identity-")); const store = new LocalSessionStore(join(dir, "sessions.sqlite")); closes.push(() => store.close());
  const thread = { id: "owned", meta: { projectId: "P" } } as any;
  const loose = { id: "loose-1", turnId: null, dispatchId: null, phase: "guard-request" as const, record: { domain: "architecture", correlation: "no-dispatch-id" } };
  store.appendPhase(thread, loose); store.appendPhase(thread, loose); // exact replay
  const original = store.phaseHistory("owned");
  expect(original).toHaveLength(1); expect(original[0]).toMatchObject({ id: "loose-1", turnId: null, dispatchId: null });
  for (const contradiction of [{ turnId: "turn-1" }, { dispatchId: "dispatch-1" }, { phase: "guard-outcome" as const }, { record: { domain: "testing" } }]) {
    expect(() => store.appendPhase(thread, { ...loose, ...contradiction })).toThrow("identity conflict");
  }
  expect(() => store.appendPhase({ id: "other", meta: { projectId: "P" } } as any, loose)).toThrow("identity conflict");
  expect(store.phaseHistory("owned")).toEqual(original);
  expect(store.phaseHistory("owned", { uncorrelated: true })).toHaveLength(1);
});

test("guard join: missing and foreign references are labelled, the foreign request stays pending under its own observation, and duplicate outcome rows are a recorded conflict", () => {
  const supplied = (text: string) => ({ status: "supplied", phase: "guard", providerId: "controlled", capturedAt: 1, messages: [{ role: "system", content: text }] });
  const obsA = { signalId: "sig-a", tool: "Write", callId: "call-a", dispatchId: "d1" }, obsB = { signalId: "sig-b", tool: "Edit", callId: "call-b", dispatchId: "d1" };
  const base = { threadId: "owned", turnId: "turn-1", dispatchId: "d1" };
  const rows = [
    { ...base, id: "req-a", phase: "guard-request", record: { domain: "architecture", observation: obsA, correlation: "live-dispatch", request: supplied("A_INPUT") } },
    { ...base, id: "req-b", phase: "guard-request", record: { domain: "architecture", observation: obsB, correlation: "live-dispatch", request: supplied("B_INPUT") } },
    { ...base, id: "out-a", phase: "guard-outcome", record: { observation: obsA, correlation: "live-dispatch", status: "reported", requests: { architecture: "req-b" }, // recorded mapping points at another observation's request
      outcomes: [{ domain: "architecture", status: "completed", findings: 0, requestRecord: "req-b" }, { domain: "testing", status: "completed", findings: 0, requestRecord: "req-gone" }] } },
    { ...base, id: "out-a-dup", phase: "guard-outcome", record: { observation: obsA, correlation: "live-dispatch", status: "reported", requests: {}, outcomes: [{ domain: "architecture", status: "completed", findings: 3 }] } },
  ];
  const entries = guardOutcomes({ detail: { phases: rows } })!;
  const a = entries.find((e: any) => e.callId === "call-a")!, b = entries.find((e: any) => e.callId === "call-b")!;
  expect(a).toMatchObject({ status: "reported", conflict: "duplicate-outcome", duplicates: ["out-a-dup"], findings: null });
  const [arch, testing, ...rest] = a.outcomes;
  expect(rest.map((o: any) => [o.status, o.requestRecord])).toEqual([["pending", "req-a"]]); // A's own unreferenced request stays pending, never attached to the outcome
  expect(arch).toMatchObject({ domain: "architecture", status: "completed", reference: "foreign", requestRecord: "req-b", request: { state: "not-recorded" } }); // never coalesced from another observation
  expect(testing).toMatchObject({ domain: "testing", status: "completed", reference: "missing", requestRecord: "req-gone", request: { state: "not-recorded" } });
  expect(b).toMatchObject({ status: "pending", outcomes: [{ domain: "architecture", status: "pending", reference: "unreferenced", requestRecord: "req-b", request: { state: "recorded", messages: [{ role: "system", content: "B_INPUT" }] } }] });
  expect(JSON.stringify(arch)).not.toContain("B_INPUT"); expect(JSON.stringify(arch)).not.toContain("A_INPUT"); // the completed outcome carries neither input: its reference is foreign, and A's own row is unreferenced
  expect(a.outcomes.some((o: any) => o.status === "pending" && o.requestRecord === "req-a" && o.request.messages[0].content === "A_INPUT")).toBe(true);
});

test("a configured phase-journal refusal at the guard boundary is not admitted: no guard provider call, the failure is retained, the central turn completes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase-refusal-")); const path = join(dir, "sessions.sqlite");
  let guardCalls = 0;
  const f = durabilityFixture(path, { guard: () => { guardCalls++; return '{"findings":[]}'; } }); closes.push(() => f.store.close());
  (f.store as unknown as { db: Database }).db.exec(`CREATE TRIGGER refuse_guard_request BEFORE INSERT ON session_phase WHEN NEW.phase = 'guard-request'
    BEGIN SELECT RAISE(ABORT, 'CONTROLLED_GUARD_REQUEST_REFUSAL'); END`);
  const done = await f.turn("turn-1", "Add preferred names");
  expect(done.ok).toBe(true); // the central turn is never blocked on guards or persistence
  await untilSettled(() => f.store.phaseHistory(f.thread.id, { turnId: "turn-1" }).some(r => r.phase === "guard-outcome"), "outcome row");
  expect(guardCalls).toBe(0);
  const rows = f.store.phaseHistory(f.thread.id, { turnId: "turn-1" });
  expect(rows.map(r => r.phase)).toEqual(["route", "advice", "guard-outcome"]); // no request row could be written
  const outcome = rows[2]!.record as any;
  expect(outcome.status).toBe("reported"); expect(outcome.failed).toEqual(["architecture"]);
  expect(outcome.requestJournal).toEqual({ architecture: "failed" }); expect(outcome.requests).toEqual({ architecture: "failed" });
  const refusedOutcome = outcome.outcomes[0];
  expect(refusedOutcome.domain).toBe("architecture"); expect(refusedOutcome.status).toBe("not-admitted"); expect(refusedOutcome.admission).toBe("not-admitted");
  expect(refusedOutcome.requestRecord).toBeNull(); expect(refusedOutcome.requestState).toBe("supplied");
  expect(outcome.outcomes[0].error).toContain("CONTROLLED_GUARD_REQUEST_REFUSAL");
  const view = guardOutcomes({ detail: f.store.turnDetail(f.thread.id, "turn-1") })!;
  expect(view[0]).toMatchObject({ status: "reported", failed: ["architecture"] });
  expect(view[0]!.outcomes[0]).toMatchObject({ domain: "architecture", status: "not-admitted", reference: "journal-failed", requestRecord: null, request: { state: "not-recorded" } });
  const meta = f.store.turnDetail(f.thread.id, "turn-1")!.messages.find(m => m.actor === "agent")!.meta as any;
  expect(meta.phases.guards[0].journal).toEqual({ requests: { architecture: "failed" }, outcome: "durable" });
  expect(meta.phases.guards[0].outcomes[0].request.status).toBe("supplied"); // the prepared input is retained in the turn's own record
});

test("a configured journal refusal at plan seal is recorded as failed, the central turn still completes, and an absent journal is 'absent', not failed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase-seal-")); const path = join(dir, "sessions.sqlite");
  const f = durabilityFixture(path); closes.push(() => f.store.close());
  (f.store as unknown as { db: Database }).db.exec(`CREATE TRIGGER refuse_route BEFORE INSERT ON session_phase WHEN NEW.phase = 'route'
    BEGIN SELECT RAISE(ABORT, 'CONTROLLED_ROUTE_REFUSAL'); END`);
  const done = await f.turn("turn-1", "Add preferred names");
  expect(done.ok).toBe(true);
  const meta = f.store.turnDetail(f.thread.id, "turn-1")!.messages.find(m => m.actor === "agent")!.meta as any;
  expect(meta.phases.journal).toEqual({ route: "failed", advice: "durable" });
  expect(meta.phases.routing.request.status).toBe("supplied"); // supplied input retained on the turn even though its durable row was refused
  expect(f.store.phaseHistory(f.thread.id, { turnId: "turn-1" }).map(r => r.phase)).not.toContain("route");
  const g = durabilityFixture(join(dir, "absent.sqlite"), { journal: false }); closes.push(() => g.store.close());
  expect((await g.turn("turn-1", "Add preferred names")).ok).toBe(true);
  await untilSettled(() => ((g.store.turnDetail(g.thread.id, "turn-1")?.messages.find(m => m.actor === "agent")?.meta as any)?.phases?.guards?.[0]?.status ?? "pending") !== "pending", "absent-journal guard settles");
  const absent = g.store.turnDetail(g.thread.id, "turn-1")!.messages.find(m => m.actor === "agent")!.meta as any;
  expect(absent.phases.journal).toEqual({ route: "absent", advice: "absent" });
  expect(absent.phases.guards[0].journal).toEqual({ requests: { architecture: "absent" }, outcome: "absent" });
  expect(absent.phases.guards[0].outcomes[0].status).toBe("completed");
});
