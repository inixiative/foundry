import { expect, test } from "bun:test";
import { m0Scenario, abstain, gate, until, learned } from "./helpers/m0-domain-loop";
import type { Database } from "bun:sqlite";
// @ts-ignore Production viewer modules are JavaScript.
import { selectedDetailTarget } from "../src/viewer/ui/conversation-state.js";
// @ts-ignore Production viewer modules are JavaScript.
import { guardOutcomes } from "../src/viewer/ui/inspector-data.js";

test("selected detail refresh requires the original active thread and exact turn", () => {
  const selected = { threadId: "a", turnId: "original" };
  const event = { kind: "journal", threadId: "a", turnId: "original", scope: "phase" };
  expect(selectedDetailTarget(event, selected, "a")).toEqual({ threadId: "a", turnId: "original" });
  for (const bad of [{ ...event, threadId: "b" }, { ...event, turnId: "later" }, { ...event, turnId: null }]) {
    expect(selectedDetailTarget(bad, selected, "a")).toBeNull();
  }
  expect(selectedDetailTarget(event, selected, "b")).toBeNull();
});

test("guard reference correlation refuses contradicted thread and original tool/call/agent fields", () => {
  const observation = { signalId: "signal", tool: "fixture_evaluate", callId: "call", agentId: "worker", dispatchId: "dispatch" };
  const base = { threadId: "a", turnId: "original", dispatchId: "dispatch" };
  const request = { ...base, id: "request", phase: "guard-request", record: { domain: "architecture", observation,
    request: { status: "supplied", phase: "guard", messages: [{ role: "system", content: "ORIGINAL" }] } } };
  const outcome = { ...base, id: "outcome", phase: "guard-outcome", record: { observation, status: "reported",
    outcomes: [{ domain: "architecture", status: "completed", requestRecord: "request", findings: 0 }] } };
  const result = (row: unknown) => guardOutcomes({ detail: { phases: [row, outcome] } })[0].outcomes[0];
  expect(result(request).reference).toBe("resolved");
  for (const row of [{ ...request, threadId: "foreign" }, ...["tool", "callId", "agentId", "dispatchId"].map(field => ({
    ...request, record: { ...request.record, observation: { ...observation, [field]: "foreign" } },
  }))]) {
    expect(result(row).reference).toBe("foreign");
    expect(result(row).request.state).toBe("not-recorded");
  }
});

test("pending and settled review journal changes notify only the original owner without private request payloads", async () => {
  const held = gate<string>(); const f = await m0Scenario({ review: () => held.promise });
  const events = async (): Promise<any[]> => (await f.current.app.request("/api/events?limit=200")).json();
  try {
    await f.send("a", "connected-original", "Continue");
    await until(() => f.calls.filter(c => c.phase === "post").length === 2, "original reviews");
    const requested = (await events()).filter(e => e.kind === "journal" && e.scope === "learning");
    expect(requested.length).toBeGreaterThanOrEqual(2);
    expect(requested.every(e => e.threadId === "a" && e.projectId === "P" && e.turnId === "connected-original")).toBe(true);
    expect(JSON.stringify(requested)).not.toContain("messages");
    const count = requested.length; held.resolve(abstain); await f.settled();
    expect((await events()).filter(e => e.kind === "journal" && e.scope === "learning").length).toBeGreaterThan(count);
    expect(f.calls.filter(c => c.phase === "post")).toHaveLength(2);
  } finally { held.resolve(abstain); await f.close(); }
});

for (const mode of ["sql", "publication"] as const) test(`late ${mode} failure invalidates the original selected audit without replay or false durable status`, async () => {
  const held = gate<string>(); const f = await m0Scenario({ review: call => call.domain === "architecture" ? held.promise : abstain });
  try {
    await f.send("a", "original-failure", "Continue");
    const runtime = f.current.manager.get("a")!, store = f.current.localStore!;
    const before = ((await (await f.current.app.request("/api/events?limit=300")).json()) as unknown[]).length;
    if (mode === "sql") (store as unknown as { db: Database }).db.exec("CREATE TRIGGER reject_connected BEFORE INSERT ON session_knowledge BEGIN SELECT RAISE(ABORT, 'CONTROLLED_CONNECTED_SQL'); END");
    else runtime.domainLibrarians.get("architecture")!.threadKnowledge.layer.set = () => { throw Error("CONTROLLED_CONNECTED_PUBLICATION"); };
    held.resolve(learned("a", "architecture")); await f.settled();
    const events = await (await f.current.app.request("/api/events?limit=300")).json() as any[];
    expect(events.slice(before).some(e => e.kind === "journal" && e.threadId === "a" && e.projectId === "P" && e.turnId === "original-failure" && e.scope === "learning")).toBe(true);
    const inspection = await (await f.current.app.request("/api/threads/a/knowledge")).json() as any;
    expect(inspection.status).toBe(mode === "sql" ? "blocked" : "reconciliation-needed");
    expect(f.calls.filter(c => c.phase === "post" && c.domain === "architecture")).toHaveLength(1);
    expect(store.knowledge("a")?.domains.architecture?.revision ?? 0).toBe(mode === "sql" ? 0 : 1);
  } finally { held.resolve(abstain); await f.close(); }
});
