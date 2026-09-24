import { expect, test } from "bun:test";
import { type InjectionArtifact } from "@inixiative/foundry-core";
import { type InjectionPlan } from "../src/agents/flow-orchestrator";
import { type LearningRecord } from "../src/agents/domain-librarian";
import { m0Scenario, domains, interpretation, privateReason, domainKnowledge, instructions, gate, learned, abstain, until } from "./helpers/m0-domain-loop";

type Turn = Awaited<ReturnType<Awaited<ReturnType<typeof m0Scenario>>["send"]>>;
const artifact = (turn: Turn) => turn.body.meta.injection as InjectionArtifact & { plan: InjectionPlan };
const text = (value: unknown) => JSON.stringify(value);

test("M0-M3: two production factory domains learn different interpretations and consume only their owned state on subsequent turns", async () => {
  const f = await m0Scenario();
  try {
    const first = await f.send("a", "a-migration", "Perform the migration");
    expect(first.status).toBe(200); expect(first.body.output).toContain("legacy-read=PASS");
    const frozen = text(first); await f.checkpoint("first prepared input and actual completion");
    for (const d of domains) await f.committed("a", d);
    await f.settled();
    const bundle = f.current.localStore!.knowledge("a")!;
    for (const d of domains) {
      expect(bundle.domains[d]).toMatchObject({ threadId: "a", projectId: "P", domain: d, revision: 1, content: interpretation("a", d) });
      const contribution = artifact(first).plan.contributions.find(c => c.domain === d)!;
      expect(contribution.segments).toMatchObject({ domainKnowledge: domainKnowledge(d), threadKnowledge: "" });
      expect(contribution.segments.instructions).toContain(instructions(d));
      expect(contribution.provenance.threadKnowledgeRevision).toBe(0);
    }
    await f.checkpoint("two domain-owned durable commits");
    const second = await f.send("a", "a-continue"); await f.settled();
    expect(second.message).toBe("Continue");
    for (const d of domains) {
      const other = domains.find(x => x !== d)!;
      const contribution = artifact(second).plan.contributions.find(c => c.domain === d)!;
      expect(contribution.segments.threadKnowledge).toBe(interpretation("a", d));
      expect(contribution.provenance.threadKnowledgeRevision).toBe(1);
      expect(text(artifact(second).providerMessages)).toContain(interpretation("a", d));
      const pre = f.calls.filter(c => c.thread === "a" && c.domain === d && c.phase === "pre").at(-1)!;
      const post = f.calls.filter(c => c.thread === "a" && c.domain === d && c.phase === "post").at(-1)!;
      for (const call of [pre, post]) {
        expect(text(call.messages)).toContain(instructions(d)); expect(text(call.messages)).toContain(domainKnowledge(d));
        expect(text(call.messages)).toContain(interpretation("a", d));
        expect(text(call.messages)).not.toContain(interpretation("a", other));
        expect(text(call.messages)).not.toContain(privateReason("a", other));
      }
      const review = f.calls.find(c => c.thread === "a" && c.domain === d && c.phase === "post")!;
      expect(text(review.messages)).toContain("migration_evaluate"); expect(text(review.messages)).toContain("legacy-read=PASS");
      expect(review.options).toMatchObject({ tools: false, maxTurns: 1, timeout: 0 });
      expect(review.options.threadId).not.toBe(pre.options.threadId);
      expect(f.current.stack.getLayer(d)!.content).toBe(domainKnowledge(d));
    }
    expect(text(first)).toBe(frozen);
    expect(text(f.current.localStore!.traceForTurn("a-migration"))).toBe(text(first.trace));
    const otherFirst = await f.send("b", "b-migration", "Perform the migration"); await f.settled("b");
    expect(text(artifact(otherFirst).providerMessages)).not.toContain(interpretation("a", "architecture"));
    const otherNext = await f.send("b", "b-continue"); await f.settled("b");
    for (const d of domains) expect(text(artifact(otherNext).providerMessages)).toContain(interpretation("b", d));
    const unrelated = await f.send("outside", "q-continue"); await f.settled("outside");
    for (const d of domains) { expect(text(artifact(unrelated).providerMessages)).not.toContain(interpretation("a", d)); expect(text(artifact(unrelated).providerMessages)).not.toContain(interpretation("b", d)); }
    const history = f.current.localStore!.learningHistory("a");
    expect(history.filter(r => (r.signal.content as any).decision === "learned")).toHaveLength(2);
    for (const d of domains) expect(history.some(r => (r.signal.content as any).job?.domain === d && (r.signal.content as any).job?.evidence.messageId === "a-migration")).toBe(true);
    await f.checkpoint("M0-M3 complete turn-to-turn evidence");
  } finally { await f.close(); }
});

test("M4: failed executor evidence is rejected by both post hooks and cannot become learned success", async () => {
  const f = await m0Scenario({ failExecutor: true });
  try {
    const failed = await f.send("a", "executor-failed"); await f.settled();
    expect(failed.status).toBe(500); expect(failed.body.error).toContain("CONTROLLED_EXECUTOR_FAILURE");
    expect(f.calls.filter(c => c.phase === "post")).toHaveLength(0);
    for (const d of domains) {
      expect(f.current.manager.get("a")!.knowledgeSnapshot().domains[d].revision).toBe(0);
      expect(f.current.localStore!.learningHistory("a").some(r => (r.signal.content as any).domain === d && (r.signal.content as any).decision === "rejected" && (r.signal.content as any).evidence.ok === false)).toBe(true);
    }
    expect(f.current.localStore!.turn("executor-failed")!.status).toBe("failed");
    await f.checkpoint("failed work retained; no reviewer/provider success fabricated");
  } finally { await f.close(); }
});

for (const raw of ["null", JSON.stringify({ decision: "learn", knowledge: "X".repeat(4001), facts: [] }),
  JSON.stringify({ decision: "learn", knowledge: interpretation("a", "architecture"), facts: [], reason: "X".repeat(1001) })]) test(`M4: malformed/oversized architecture reply cannot corrupt testing's separate successful interpretation (${raw.length})`, async () => {
  const f = await m0Scenario({ review: c => c.domain === "architecture" ? raw : learned(c.thread, "testing") });
  try {
    const first = await f.send("a", "invalid-review", "Perform the migration"); await f.settled();
    expect(first.body.output).toContain("legacy-read=PASS");
    expect(f.current.manager.get("a")!.knowledgeSnapshot().domains.architecture.revision).toBe(0);
    expect(f.current.localStore!.knowledge("a")!.domains.testing.content).toBe(interpretation("a", "testing"));
    expect(f.current.localStore!.learningHistory("a").some(r => (r.signal.content as any).domain === "architecture" && (r.signal.content as any).decision === "invalid")).toBe(true);
    await f.checkpoint("invalid domain proposal rejected; independent expert commit retained");
  } finally { await f.close(); }
});

test("M4: duplicate observation cannot double-review, and stale restore cannot overwrite either committed domain", async () => {
  let holding = false; const held = gate<string>();
  const f = await m0Scenario({ review: c => holding ? held.promise : learned(c.thread, c.domain!) }); f.releases.push(() => held.resolve(abstain));
  try {
    await f.send("a", "original", "Perform the migration"); await f.settled();
    const runtime = f.current.manager.get("a")!; const before = f.current.localStore!.knowledge("a")!;
    const observation = f.signals.find(s => s.thread === "a" && s.signal.kind === "dispatch" && (s.signal.content as any).messageId === "original")!.signal;
    const count = f.calls.filter(c => c.phase === "post").length;
    await runtime.thread.signals.emit(observation); await f.settled(); expect(f.calls.filter(c => c.phase === "post")).toHaveLength(count);
    holding = true; await f.send("a", "stale-work");
    runtime.restoreKnowledge(before); // Only an actual prior committed bundle, no invented learned state.
    held.resolve(learned("a", "architecture")); await f.settled();
    for (const d of domains) expect(runtime.knowledgeSnapshot().domains[d]).toMatchObject({ revision: 1, content: interpretation("a", d) });
    expect(f.current.localStore!.knowledge("a")).toEqual(before);
    expect(f.current.localStore!.learningHistory("a").filter(r => (r.signal.content as any).decision === "stale")).toHaveLength(2);
    await f.checkpoint("duplicate and stale observations retained without knowledge replacement");
  } finally { await f.close(); }
});

test("M4: hard closure and disposal retain late evidence without admitting replacement work", async () => {
  for (const close of ["expiry", "dispose"] as const) {
    let now = 0; const held = gate<string>();
    const f = await m0Scenario({ learning: { clock: () => now, hardTimeoutMs: 1000 }, review: () => held.promise }); f.releases.push(() => held.resolve(abstain));
    try {
      await f.send("a", `${close}-origin`, "Perform the migration"); const runtime = f.current.manager.get("a")!;
      await f.send("a", `${close}-queued`);
      if (close === "expiry") now = 1000; else runtime.dispose();
      held.resolve(learned("a", "architecture")); await runtime.learningSettled(); await until(() => runtime.learningOutstanding === 0, "late completed reviewer");
      expect(f.calls.filter(c => c.thread === "a" && c.phase === "post")).toHaveLength(2);
      expect(f.current.localStore!.knowledge("a")).toBeUndefined();
      for (const d of domains) expect(runtime.knowledgeSnapshot().domains[d].revision).toBe(0);
      expect(f.current.localStore!.learningHistory("a").some(r => (r.signal.content as any).decision === (close === "expiry" ? "expired" : "discarded"))).toBe(true);
      await f.checkpoint(`${close}: late terminal is evidence only; queued work never admitted`);
    } finally { await f.close(); }
  }
});

test("M4: unknown reviewer failure retains durable closure through restart with no hidden admission", async () => {
  const f = await m0Scenario({ review: c => { if (c.domain === "architecture") throw Error("CONTROLLED_UNKNOWN_REVIEW_FAILURE"); return abstain; } });
  try {
    await f.send("a", "unknown-origin"); await f.settled();
    const count = f.calls.filter(c => c.phase === "post" && c.domain === "architecture").length;
    await f.send("a", "unknown-next"); await f.settled();
    expect(f.calls.filter(c => c.phase === "post" && c.domain === "architecture")).toHaveLength(count);
    expect(f.current.manager.get("a")!.learningState.domains.architecture.closed).toBe(true);
    const priorHistory = f.current.localStore!.learningHistory("a");
    expect(priorHistory.some(r => (r.signal.content as any).decision === "error" && (r.signal.content as any).reason === "CONTROLLED_UNKNOWN_REVIEW_FAILURE")).toBe(true);
    expect(priorHistory.some(r => (r.signal.content as any).decision === "deferred")).toBe(true);
    await f.restart(); await f.send("a", "unknown-reconstructed"); await f.settled();
    expect(f.calls.filter(c => c.phase === "post" && c.domain === "architecture")).toHaveLength(count);
    expect(f.current.manager.get("a")!.learningState.domains.architecture.closed).toBe(true);
    await f.checkpoint("reconstruction retains unresolved ownership without replay");
  } finally { await f.close(); }
});

test("M4: real SQLite commit failure preserves completed central output and the previous two-domain revision", async () => {
  let failWrite = false; const held = gate<string>();
  const f = await m0Scenario({ review: c => failWrite ? held.promise : learned(c.thread, c.domain!) }); f.releases.push(() => held.resolve(abstain));
  try {
    await f.send("a", "durable-base", "Perform the migration"); await f.settled();
    const before = f.current.localStore!.knowledge("a"); const old = text(f.current.localStore!.traceForTurn("durable-base"));
    failWrite = true; const completed = await f.send("a", "learning-storage-failure");
    (f.current.localStore as any).db.exec("CREATE TEMP TRIGGER deny_m0_knowledge BEFORE INSERT ON session_knowledge BEGIN SELECT RAISE(ABORT, 'M0_SQL_REJECTED'); END");
    const runtime = f.current.manager.get("a")!; held.resolve(learned("a", "architecture")); await runtime.learningSettled();
    expect(completed.status).toBe(200); expect(completed.body.output).toBe("CONTINUED_WITHOUT_REPEATING_MIGRATION");
    expect(f.current.localStore!.turn("learning-storage-failure")!.status).toBe("completed");
    expect(f.current.localStore!.knowledge("a")).toEqual(before); expect(text(f.current.localStore!.traceForTurn("durable-base"))).toBe(old);
    expect(f.current.localStore!.learningHistory("a").some(r => (r.signal.content as any).decision === "write-failed")).toBe(true);
    expect(runtime.disposed).toBe(true); await f.checkpoint("atomic knowledge failure preserves successful central completion and old knowledge");
  } finally { await f.close(); }
});

test("M4: foreign bundle restore refuses the actual learned owner without changing another project's input", async () => {
  const f = await m0Scenario();
  try {
    await f.send("a", "foreign-source", "Perform the migration"); await f.settled();
    const bundle = f.current.localStore!.knowledge("a")!; const outside = f.current.manager.get("outside")!;
    const before = outside.knowledgeSnapshot();
    expect(() => outside.restoreKnowledge(bundle)).toThrow('Knowledge bundle is for thread "a", not "outside"');
    for (const d of domains) expect(outside.knowledgeSnapshot().domains[d]).toEqual(before.domains[d]);
    const next = await f.send("outside", "foreign-recipient"); await f.settled("outside");
    for (const d of domains) expect(text(artifact(next).providerMessages)).not.toContain(interpretation("a", d));
    await f.checkpoint("foreign committed bundle rejected without relabeling owner");
  } finally { await f.close(); }
});

test("M4: committed knowledge survives publication failure and reconstructs without repeating central or review work", async () => {
  const held = gate<string>(); const f = await m0Scenario({ review: c => c.domain === "architecture" ? held.promise : abstain });
  f.releases.push(() => held.resolve(abstain));
  try {
    const completed = await f.send("a", "publish-failed", "Perform the migration");
    const runtime = f.current.manager.get("a")!;
    runtime.domainLibrarians.get("architecture")!.threadKnowledge.layer.set = () => { throw Error("M0_PUBLICATION_REJECTED"); };
    held.resolve(learned("a", "architecture")); await runtime.learningSettled();
    expect(completed.body.output).toContain("legacy-read=PASS");
    expect(f.current.localStore!.knowledge("a")!.domains.architecture.content).toBe(interpretation("a", "architecture"));
    expect(f.current.localStore!.learningHistory("a").some(r => (r.signal.content as any).decision === "reconciliation-needed" && (r.signal.content as any).persistence === "reconciliation-needed")).toBe(true);
    const count = f.calls.length; await f.restart(); expect(f.calls).toHaveLength(count);
    expect(f.current.manager.get("a")!.knowledgeSnapshot().domains.architecture.content).toBe(interpretation("a", "architecture"));
    expect(f.current.localStore!.turn("publish-failed")!.status).toBe("completed");
    await f.checkpoint("durable publication reconciliation across reconstruction; no replay");
  } finally { await f.close(); }
});

test("M3-M4: pending review does not serialize immediate work; first post-commit turn and journal reconstruction use each new revision", async () => {
  const held = { architecture: gate<string>(), testing: gate<string>() };
  const f = await m0Scenario({ review: c => text(c.messages).includes("MIGRATION_APPLIED") ? held[c.domain!].promise : abstain });
  for (const d of domains) f.releases.push(() => held[d].resolve(abstain));
  try {
    const first = await f.send("a", "pending-origin", "Perform the migration"); const original = text(first.trace);
    const immediate = await f.send("a", "pending-continue");
    expect(immediate.status).toBe(200); expect(immediate.body.meta.delivery.learningBarrier).toMatchObject({ outcome: "pending", waitedMs: 0 });
    expect(f.calls.filter(c => c.thread === "a" && c.phase === "post")).toHaveLength(2);
    for (const d of domains) expect(text(artifact(immediate).providerMessages)).not.toContain(interpretation("a", d));
    await f.checkpoint("central completed while both reviewers remain held");
    for (const d of domains) held[d].resolve(learned("a", d));
    for (const d of domains) await f.committed("a", d); await f.settled();
    const next = await f.send("a", "after-commit"); await f.settled();
    for (const d of domains) expect(text(artifact(next).providerMessages)).toContain(interpretation("a", d));
    const before = f.current.localStore!.knowledge("a"); const history = f.current.localStore!.learningHistory("a");
    const centralBefore = f.calls.filter(c => c.phase === "central").length;
    await f.restart();
    expect(f.calls.filter(c => c.phase === "central")).toHaveLength(centralBefore);
    expect(f.current.localStore!.knowledge("a")).toEqual(before); expect(f.current.localStore!.learningHistory("a")).toEqual(history);
    expect(text(f.current.localStore!.traceForTurn("pending-origin"))).toBe(original);
    const resumed = await f.send("a", "reconstructed-continue"); await f.settled();
    for (const d of domains) expect(artifact(resumed).plan.contributions.find(c => c.domain === d)!.segments.threadKnowledge).toBe(interpretation("a", d));
    await f.checkpoint("reconstruction without replay; committed interpretations delivered");
  } finally { await f.close(); }
});

for (const supplied of [true, false]) test(`M1-M4: successful review rationale stays in owned durable audit across reconstruction (supplied=${supplied})`, async () => {
  const reason = (d: typeof domains[number]) => privateReason("a", d).padEnd(1000, "_");
  const f = await m0Scenario({ review: c => text(c.messages).includes("MIGRATION_APPLIED")
    ? JSON.stringify({ decision: "learn", knowledge: interpretation(c.thread, c.domain!), facts: ["legacy-read=PASS"],
      ...(supplied ? { reason: reason(c.domain!) } : {}) }) : abstain });
  try {
    const first = await f.send("a", "owned-rationale", "Perform the migration"); await f.settled();
    const frozen = text(first.trace);
    const runtime = f.current.manager.get("a")!;
    const history = f.current.localStore!.learningHistory("a");
    const committed = history.filter(r => (r.signal.content as LearningRecord).decision === "learned");
    expect(committed).toHaveLength(2);
    for (const d of domains) {
      const stored = committed.find(r => (r.signal.content as LearningRecord).job?.domain === d)!;
      const record = stored.signal.content as LearningRecord;
      const signal = runtime.thread.signals.recent("domain_learning", 100).find(s => s.id === stored.signal.id)!;
      expect(record).toMatchObject({ decision: "learned", revision: 1,
        job: { domain: d, threadId: "a", projectId: "P", evidence: { messageId: "owned-rationale" },
          base: { domain: d, threadId: "a", projectId: "P", revision: 0, content: "" } } });
      expect((signal.content as LearningRecord).job).toEqual(record.job);
      for (const retained of [record, signal.content as LearningRecord]) {
        expect(Object.hasOwn(retained, "reason")).toBe(supplied);
        expect(retained.reason).toBe(supplied ? reason(d) : undefined);
      }
      expect(runtime.librarian.layer.content).toContain(`Learning (${d}): learned rev 1`);
      expect(runtime.librarian.layer.content).not.toContain(privateReason("a", d));
    }
    await f.checkpoint("supplied bounded successful reason or honest absence retained in original owned journal");
    const calls = f.calls.length; await f.restart();
    expect(f.calls).toHaveLength(calls);
    expect(f.current.localStore!.learningHistory("a")).toEqual(history);
    expect(text(f.current.localStore!.traceForTurn("owned-rationale"))).toBe(frozen);
    const next = await f.send("a", "after-rationale-reconstruction"); await f.settled();
    for (const d of domains) {
      expect(text(artifact(next).providerMessages)).toContain(interpretation("a", d));
      expect(text(artifact(next).providerMessages)).not.toContain(privateReason("a", d));
      for (const phase of ["pre", "post"] as const) {
        const call = f.calls.filter(c => c.thread === "a" && c.domain === d && c.phase === phase).at(-1)!;
        for (const expert of domains) expect(text(call.messages)).not.toContain(privateReason("a", expert));
      }
    }
    expect(text(first.trace)).toBe(frozen);
    await f.checkpoint("reconstructed audit unchanged; expert and central next input exclude private rationale");
  } finally { await f.close(); }
});

test("M1 ownership: an expert's private abstention rationale stays in its audit, not another expert's pre-message state", async () => {
  const f = await m0Scenario({ review: c => JSON.stringify({ decision: "abstain", reason: privateReason(c.thread, c.domain!) }) });
  try {
    await f.send("a", "private-abstention"); await f.settled();
    const history = f.current.localStore!.learningHistory("a");
    for (const d of domains) expect(history.some(r => (r.signal.content as any).reason === privateReason("a", d))).toBe(true);
    await f.send("a", "after-private-abstention"); await f.settled();
    for (const d of domains) {
      const other = domains.find(x => x !== d)!;
      const pre = f.calls.filter(c => c.thread === "a" && c.domain === d && c.phase === "pre").at(-1)!;
      expect(text(pre.messages)).not.toContain(privateReason("a", other));
      expect(text(pre.messages)).toContain("Dispatched: worker"); // shared actual activity remains available
      expect(text(pre.messages)).toContain(`Learning (${other}): abstain`); // outcome remains factual shared metadata
    }
    await f.checkpoint("private rationale retained only in owned audit; shared outcomes remain visible");
  } finally { await f.close(); }
});
