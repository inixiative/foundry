import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStack, EventStream, Executor, Harness, InterventionLog, Thread, type NativeEvidence } from "@inixiative/foundry-core";
import { createViewer } from "../src/viewer/server";
import { slim, slimTurn, taskLists, TASK_SOURCES } from "../src/viewer/turn-flow";
import { createViewerStreams } from "../src/viewer/data-streams";
import { ViewerThreadDirectory } from "../src/viewer/thread-directory";
import { createWebSocketServer } from "../src/ws/handler";
import { connectStreams } from "./helpers/data-stream";
import { instructions, interpretation, m0Scenario } from "./helpers/m0-domain-loop";
// @ts-expect-error native browser module
import { applyFlowFrame, emptyFlow, turnFlowGraph, learningLoop } from "../src/viewer/ui/flow-graph.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function scenario() {
  const s = await m0Scenario();
  cleanup.push(() => s.close());
  return s;
}

const appends = (frames: any[], kind: string) => frames.filter(f => f.action === "append" && f.payload.kind === kind).map(f => f.payload);

test("flow snapshot: recent turns as recorded flows, learning history and committed revisions, without provider payloads", async () => {
  const s = await scenario();
  await s.send("a", "t1", "Perform the migration");
  await s.committed("a", "architecture");
  await s.settled("a");
  await s.send("a", "t2", "Continue");
  await s.settled("a");
  const client = connectStreams(s.current);
  await client.open("flow:a");
  const [snapshot] = client.data("flow:a");
  expect(snapshot.action).toBe("snapshot");
  const flow = snapshot.payload;
  expect(flow).toMatchObject({ threadId: "a", journal: "available", limits: { turns: 16, learning: 200 } });
  expect(flow.turns.map((t: any) => t.turnId)).toEqual(["t1", "t2"]);
  const [t1, t2] = flow.turns;
  expect(t1).toMatchObject({ status: "completed", input: { preview: "Perform the migration" }, outcome: { executionOutcome: "completed", persistence: "committed" } });
  expect(t1.phases.map((p: any) => p.phase)).toEqual(["route", "advice", "guard-outcome"]);
  expect(t1.plan.contributions.map((c: any) => [c.domain, c.decision, c.provenance.threadKnowledgeRevision])).toEqual([["architecture", "contribute", 0], ["testing", "contribute", 0]]);
  expect(t2.plan.contributions.map((c: any) => c.provenance.threadKnowledgeRevision)).toEqual([1, 1]);
  expect(Number.isFinite(t1.plan.elapsed)).toBe(true);
  expect(t1.spans.find((span: any) => span.kind === "execute")).toMatchObject({ agentId: "worker", status: "ok" });
  expect(t1.delivery.committed).toEqual(expect.arrayContaining(["architecture", "testing"]));
  expect(flow.knowledge.domains).toMatchObject({ architecture: { revision: 1 }, testing: { revision: 1 } });
  expect(Object.keys(flow.review).sort()).toEqual(["architecture", "testing"]);
  const decisions = flow.learning.map((e: any) => `${e.signal.content.evidence.messageId}:${e.signal.content.domain}:${e.signal.content.decision}`);
  expect(decisions).toEqual(expect.arrayContaining(["t1:architecture:learned", "t1:testing:learned", "t2:architecture:abstain", "t2:testing:abstain"]));
  // Requests are reduced to their status and message count; expert segments to their lengths; knowledge text stays in the journal.
  const text = JSON.stringify(flow);
  for (const secret of [instructions("architecture"), interpretation("a", "architecture")]) expect(text).not.toContain(secret);
  expect(t1.plan.contributions[0].request).toEqual({ status: "supplied", phase: "advice", providerId: "controlled-domain", capturedAt: expect.any(Number), messageCount: expect.any(Number) });
  expect(typeof t1.plan.contributions[0].segments.instructions).toBe("number");
  client.disconnect();
}, 30_000);

test("flow stream appends each journalled change of a live turn and its learning, then stops with its last holder", async () => {
  const s = await scenario();
  const client = connectStreams(s.current);
  await client.open("flow:a");
  expect(client.data("flow:a")[0].payload.turns).toEqual([]);
  await s.send("a", "t1", "Perform the migration");
  await s.settled("a");
  await client.next(f => f.category === "data" && f.stream === "flow:a" && f.payload.kind === "knowledge" && f.payload.knowledge?.domains?.architecture?.revision === 1, "committed revision");
  await client.next(f => f.category === "data" && f.stream === "flow:a" && f.payload.kind === "turn" && f.payload.turn.status === "completed" && f.payload.turn.delivery, "completed turn");
  const turns = appends(client.data("flow:a"), "turn");
  expect(turns.every(p => p.turn.turnId === "t1")).toBe(true);
  // The route/advice phases are journalled before the executor is called; the turn is sent as each change lands.
  expect(turns[0].turn.phases.map((p: any) => p.phase)).toEqual(expect.arrayContaining(["route", "advice"]));
  const learned = appends(client.data("flow:a"), "learning").flatMap(p => p.entries).map((e: any) => `${e.signal.content.domain}:${e.signal.content.decision}`);
  expect(learned).toEqual(expect.arrayContaining(["architecture:learned", "testing:learned"]));
  // An unchanged turn is never re-sent: the last two turn appends differ.
  const texts = turns.map(p => JSON.stringify(p.turn));
  expect(new Set(texts).size).toBe(texts.length);

  // A second viewer joining mid-stream gets the same state as a snapshot.
  const late = connectStreams(s.current);
  await late.open("flow:a");
  const lateTurn = late.data("flow:a")[0].payload.turns[0];
  expect(lateTurn).toEqual(turns.at(-1)!.turn);

  client.disconnect();
  expect(s.current.socket.streams.isOpen("flow:a")).toBe(true);
  late.disconnect();
  expect(s.current.socket.streams.isOpen("flow:a")).toBe(false);
}, 30_000);

test("the recorded flow drives the graph builders end to end: turn loop, feedback from a learned revision to the next turn", async () => {
  const s = await scenario();
  await s.send("a", "t1", "Perform the migration");
  await s.committed("a", "architecture");
  await s.settled("a");
  await s.send("a", "t2", "Continue");
  await s.settled("a");
  const client = connectStreams(s.current);
  await client.open("flow:a");
  const flow = applyFlowFrame(emptyFlow("a"), client.data("flow:a")[0]);
  const t1 = turnFlowGraph(flow.turns[0], { learning: flow.learning });
  const ids = t1.nodes.map((n: any) => n.id);
  expect(ids).toEqual(expect.arrayContaining(["input", "routing", "domain:architecture", "domain:testing", "plan", "executor", "guard:0", "delivery", "learn:architecture", "learn:testing"]));
  expect(t1.nodes.find((n: any) => n.id === "learn:architecture").sub).toBe("learned · rev 0→1");
  expect(t1.edges.find((e: any) => e.from === "executor" && e.to === "guard:0").label).toBe("migration_evaluate");
  const loop = learningLoop(flow);
  expect(loop.lanes).toEqual(["architecture", "testing"]);
  expect(loop.edges.filter((e: any) => e.kind === "feedback" && e.to.startsWith("assess:t2")).map((e: any) => e.from).sort())
    .toEqual(["write:t1:architecture", "write:t1:testing"]);
  client.disconnect();
}, 30_000);

test("flow opens are authorized by thread; a viewer without a journal says so instead of an empty history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foundry-flow-stream-"));
  cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
  const main = new Thread("main", new ContextStack());
  main.register(new Executor({ id: "worker", stack: main.stack, handler: async () => "ok" }));
  const harness = new Harness(main); harness.setDefaultExecutor("worker");
  const viewer = createViewer({ harness, eventStream: new EventStream(), interventions: new InterventionLog(main.signals), configDir: dir, localStore: null });
  cleanup.push(() => viewer.analyticsReady.catch(() => {}));
  const client = connectStreams(viewer);
  await client.open("flow:missing");
  expect(client.frames().at(-1)).toEqual({ type: "openRejected", stream: "flow:missing" });
  await client.open("flow:main");
  expect(client.data("flow:main")[0].payload).toMatchObject({ threadId: "main", journal: "unavailable", turns: [], learning: [] });
  client.disconnect();
});

test("task lists come from the executor's recorded plan tools; the latest list per tool wins", () => {
  const use = (toolName: string, toolInput: Record<string, unknown>, observedAt: number) => ({ schema: 1, nativeOutcome: "unknown", kind: "tool_use", toolName, toolInput, observedAt }) as NativeEvidence;
  const lists = taskLists([
    use("TodoWrite", { todos: [{ content: "Read the schema", status: "in_progress", activeForm: "Reading" }] }, 1),
    use("Bash", { command: "ls" }, 2),
    use("TodoWrite", { todos: [{ content: "Read the schema", status: "completed" }, { content: "Add the column", status: "pending" }] }, 3),
    use("update_plan", { explanation: "Migrate safely", plan: [{ step: "expand", status: "completed" }, { step: "contract", status: "pending" }] }, 4),
    use("update_plan", { plan: "not a list" }, 5),
  ]);
  expect(lists).toEqual([
    { source: "TodoWrite", observedAt: 3, items: [{ text: "Read the schema", status: "completed" }, { text: "Add the column", status: "pending" }] },
    { source: "update_plan", observedAt: 4, goal: "Migrate safely", items: [{ text: "expand", status: "completed" }, { text: "contract", status: "pending" }] },
  ]);
  expect(Object.keys(TASK_SOURCES).sort()).toEqual(["TodoWrite", "update_plan"]);
});

test("slim keeps record shape but drops request messages, segment text and long strings", () => {
  const out = slim({ phase: "advice", record: { participants: [{ domain: "d", segments: { instructions: "abc", threadKnowledge: "" },
    request: { status: "supplied", phase: "advice", providerId: "p", capturedAt: 1, messages: [{ role: "user", content: "secret" }] } }],
    reason: "x".repeat(2000), list: Array.from({ length: 100 }, (_, i) => i) } }) as any;
  const p = out.record.participants[0];
  expect(p.segments).toEqual({ instructions: 3, threadKnowledge: 0 });
  expect(p.request).toEqual({ status: "supplied", phase: "advice", providerId: "p", capturedAt: 1, messageCount: 1 });
  expect(out.record.reason.length).toBeLessThan(700);
  expect(out.record.list).toHaveLength(64);
  expect(JSON.stringify(out)).not.toContain("secret");
});

test("slimTurn tolerates a turn with no trace, plan or agent message (accepted, still running)", () => {
  const turn = slimTurn({ threadId: "a", turnId: "t", turn: { id: "t", threadId: "a", status: "active", startedAt: 5 }, messages: [{ id: "m", threadId: "a", turnId: "t", actor: "user", kind: "text", content: "hi", timestamp: 5 }],
    trace: null, injection: null, phases: [], taskUses: [] });
  expect(turn).toMatchObject({ status: "active", plan: null, delivery: null, trace: null, spans: [], tasks: [], input: { preview: "hi", chars: 2 } });
});

/** The flow family over a controllable journal: a fake store whose reads can fail, and a live review state. */
function fakeJournal() {
  const main = new Thread("main", new ContextStack());
  const events = new EventStream();
  const turns = new Map<string, { startedAt: number; status: string }>();
  const failing = new Set<string>();
  let review: any = { domains: { d: { status: "idle", queued: 0, queuedEvidence: [] } } };
  let blocked: string | undefined;
  const reads: string[] = [];
  const store: any = {
    recentTurnIds: (_t: string, limit: number) => [...turns].sort((a, b) => b[1].startedAt - a[1].startedAt).slice(0, limit).map(([id]) => id),
    turnFlowRecord: (threadId: string, turnId: string) => {
      reads.push(turnId);
      if (failing.has(turnId)) throw new Error(`checksum mismatch ${turnId}`);
      const t = turns.get(turnId);
      return t && { threadId, turnId, turn: { id: turnId, threadId, status: t.status, startedAt: t.startedAt }, messages: [], trace: null, injection: null, phases: [], taskUses: [] };
    },
    learningHistory: () => [],
    knowledge: () => undefined,
  };
  const directory = new ViewerThreadDirectory(main);
  let socket: ReturnType<typeof createWebSocketServer>;
  const streams = createViewerStreams({ directory, eventStream: events, deliverTo: () => {},
    journal: { store, learningState: () => review, blocked: () => blocked } });
  socket = createWebSocketServer({ families: streams.families });
  const viewer = { websocket: socket.websocket };
  const notice = (turnId: string) => events.push({ kind: "journal", threadId: "main", turnId, timestamp: Date.now() });
  return { viewer, events, turns, failing, reads, notice, setReview: (r: any) => { review = r; }, block: (reason?: string) => { blocked = reason; }, socket };
}
const turnAppends = (client: ReturnType<typeof connectStreams>) => appends(client.data("flow:main"), "turn").map(p => [p.turn.turnId, p.turn.status]);

test("a turn read that fails is retried, then sent as unreadable; other turns in the batch still arrive", async () => {
  const f = fakeJournal();
  const client = connectStreams(f.viewer);
  await client.open("flow:main");
  f.turns.set("good", { startedAt: 1, status: "completed" });
  f.turns.set("bad", { startedAt: 2, status: "completed" });
  f.failing.add("bad");
  f.notice("good"); f.notice("bad");
  await client.next(f2 => f2.category === "data" && f2.payload.kind === "turn" && f2.payload.turn.turnId === "good", "good turn");
  expect(turnAppends(client)).toEqual([["good", "completed"]]);
  // A transient failure: the retry reads it once it is readable.
  f.failing.delete("bad");
  await client.next(f2 => f2.category === "data" && f2.payload.kind === "turn" && f2.payload.turn.turnId === "bad", "retried turn", 5000);
  expect(turnAppends(client)).toEqual([["good", "completed"], ["bad", "completed"]]);
  // A persistent failure: after the attempts, the turn is reported as unreadable, not silently dropped.
  f.failing.add("bad");
  f.notice("bad");
  await client.next(f2 => f2.category === "data" && f2.payload.kind === "turn" && f2.payload.turn.status === "unreadable", "unreadable turn", 8000);
  expect(appends(client.data("flow:main"), "turn").at(-1).turn.error).toContain("checksum mismatch bad");
  client.disconnect();
}, 20_000);

test("a later opener first delivers review changes that had no notice to the current holders", async () => {
  const f = fakeJournal();
  const a = connectStreams(f.viewer);
  await a.open("flow:main");
  expect(a.data("flow:main")[0].payload.review).toEqual({ d: { status: "idle", queued: 0, closed: false } });
  f.setReview({ domains: { d: { status: "delayed", queued: 2, queuedEvidence: [] } } }); // no event
  const b = connectStreams(f.viewer);
  await b.open("flow:main");
  expect(b.data("flow:main")[0].payload.review.d).toMatchObject({ status: "delayed", queued: 2 });
  expect(appends(a.data("flow:main"), "knowledge").map(p => p.review.d.status)).toEqual(["delayed"]);
  // A thread signal (queue growth rides on tool observations) re-reads the review status.
  f.setReview({ domains: { d: { status: "pending", queued: 0, queuedEvidence: [] } } });
  f.events.push({ kind: "signal", threadId: "main", signal: { id: "s", kind: "tool_observation", source: "t", content: {}, timestamp: 1 } as never });
  await a.next(fr => fr.category === "data" && fr.payload.kind === "knowledge" && fr.payload.review.d.status === "pending", "pending review");
  a.disconnect(); b.disconnect();
});

test("a turn outside a full window is not sent; quarantined learning is withheld with its reason", async () => {
  const f = fakeJournal();
  for (let i = 1; i <= 16; i++) f.turns.set(`t${i}`, { startedAt: 100 + i, status: "completed" });
  f.turns.set("old", { startedAt: 1, status: "completed" });
  f.block("Knowledge durability failure for main: bad row");
  const client = connectStreams(f.viewer);
  await client.open("flow:main");
  const snapshot = client.data("flow:main")[0].payload;
  expect(snapshot.turns.map((t: any) => t.turnId)).toEqual(Array.from({ length: 16 }, (_, i) => `t${i + 1}`));
  expect(snapshot).toMatchObject({ learning: [], knowledge: null, review: null, learningError: "Knowledge durability failure for main: bad row" });
  f.notice("old");
  f.turns.set("t17", { startedAt: 200, status: "active" });
  f.notice("t17");
  await client.next(fr => fr.category === "data" && fr.payload.kind === "turn" && fr.payload.turn.turnId === "t17", "new turn");
  expect(turnAppends(client)).toEqual([["t17", "active"]]);
  client.disconnect();
});
