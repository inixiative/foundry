import { expect, test } from "bun:test";
// @ts-expect-error native browser module
import { applyFlowFrame, emptyFlow, threadGraph, turnFlowGraph, learningLoop, layoutColumns, edgePath, domainLayer } from "../src/viewer/ui/flow-graph.js";

// Graph builders: recorded data in, positioned nodes and edges out. Absent records give absent nodes.

const thread = (threadId: string, meta: Record<string, unknown> = {}, layers: Array<{ id: string; state: string }> = []) =>
  ({ threadId, meta: { status: "idle", description: "", lastActiveAt: 0, ...meta }, agents: [{ id: "worker", agentId: "worker" }], layers });

const overlaps = (nodes: any[]) => nodes.some((a, i) => nodes.some((b, j) => i < j && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));

test("thread graph: subagent threads nest under their parent; a missing parent or a parent loop makes a root", () => {
  const g = threadGraph([
    thread("main", { description: "Main", lastActiveAt: 10 }, [{ id: "docs", state: "warm" }, { id: "memory", state: "cold" }]),
    thread("sub-1", { parentThreadId: "main", status: "active" }),
    thread("sub-2", { parentThreadId: "sub-1" }),
    thread("orphan", { parentThreadId: "gone" }),
    thread("loop-a", { parentThreadId: "loop-b" }), thread("loop-b", { parentThreadId: "loop-a" }),
  ], { activeThreadId: "sub-1", promptCounts: { main: 2 } });
  const byId = new Map(g.nodes.map((n: any) => [n.id, n]));
  expect(g.edges.map((e: any) => `${e.from}->${e.to}`).sort()).toEqual(["main->sub-1", "sub-1->sub-2"]);
  expect(["main", "orphan", "loop-a", "loop-b"].every(id => byId.get(id).depth === 0)).toBe(true);
  expect(byId.get("sub-2")).toMatchObject({ depth: 2, parentId: "sub-1" });
  expect(byId.get("sub-1")).toMatchObject({ active: true, childCount: 1, status: "active" });
  expect(byId.get("main")).toMatchObject({ label: "Main", warm: 1, agents: 1, prompts: 2 });
  expect(byId.get("main").layers).toEqual([{ id: "docs", state: "warm" }, { id: "memory", state: "cold" }]);
  // A child sits below its parent; no two nodes overlap.
  expect(byId.get("sub-1").y).toBeGreaterThan(byId.get("main").y);
  expect(overlaps(g.nodes)).toBe(false);
  expect(g.total).toBe(6);
});

test("thread graph: a big subtree folds past maxChildren into one node, expands on request, and the node budget folds the rest", () => {
  const threads = [thread("root"), ...Array.from({ length: 12 }, (_, i) => thread(`kid-${i}`, { parentThreadId: "root", lastActiveAt: 100 - i })),
    thread("grandkid", { parentThreadId: "kid-11" })];
  const folded = threadGraph(threads, { maxChildren: 4 });
  const more = folded.nodes.find((n: any) => n.kind === "more");
  expect(folded.nodes.filter((n: any) => n.kind === "thread").map((n: any) => n.id)).toEqual(["root", "kid-0", "kid-1", "kid-2", "kid-3"]);
  expect(more).toMatchObject({ id: "more:root", parentId: "root", label: "+8 more", hiddenCount: 9, expandable: true });
  expect(folded.hidden).toBe(9);
  const open = threadGraph(threads, { maxChildren: 4, expanded: new Set(["root"]) });
  expect(open.nodes.filter((n: any) => n.kind === "thread")).toHaveLength(14);
  expect(open.hidden).toBe(0);
  const capped = threadGraph([...threads, thread("other-root")], { maxChildren: 100, maxNodes: 6 });
  expect(capped.nodes.filter((n: any) => n.kind === "thread")).toHaveLength(6);
  // Fold ids carry a colon, so they never collide with a thread id (even a thread named "root").
  expect(capped.nodes.filter((n: any) => n.kind === "more").map((n: any) => [n.id, n.hiddenCount])).toEqual([["more:root", 8], ["more:", 1]]);
  expect(capped.hidden).toBe(9);
  expect(overlaps(capped.nodes)).toBe(false);
});

const turn = {
  threadId: "a", turnId: "t1", status: "completed", startedAt: 1000, endedAt: 1400,
  input: { preview: "Perform the migration", chars: 21 },
  plan: null, snippets: null,
  phases: [
    { id: "p1", turnId: "t1", phase: "route", record: { routing: { status: "fallback", reason: "model timeout", domains: ["architecture"], layers: ["architecture"], confidence: 0.4, elapsedMs: 900 } } },
    { id: "p2", turnId: "t1", phase: "advice", record: { participants: [
      { domain: "architecture", decision: "contribute", threadKnowledgeRevision: 2 },
      { domain: "security", decision: "timeout", reason: "deadline" }] } },
    { id: "p3", turnId: "t1", dispatchId: "d", phase: "guard-outcome", record: { observation: { signalId: "s1", tool: "Bash", callId: "c1" }, status: "reported", findings: 2, critical: 1,
      outcomes: [{ domain: "security", status: "completed", findings: 2 }] } },
  ],
  spans: [{ kind: "classify", name: "classify:c", agentId: "c", status: "ok", durationMs: 12 }, { kind: "execute", name: "execute:worker", agentId: "worker", status: "ok", durationMs: 380 }],
  delivery: { layers: [{ id: "architecture", domain: "architecture", assessedHash: "aaa", deliveredHash: "bbb", drift: true },
    { id: "thread-knowledge:architecture", domain: "architecture", assessedHash: "k", deliveredHash: "k", assessedRevision: 2, deliveredRevision: 3, relation: "advanced", drift: false }],
    committed: ["architecture", "thread-knowledge:architecture"] },
  outcome: { executionOutcome: "completed" },
  tasks: [{ source: "TodoWrite", observedAt: 5, items: [{ text: "a", status: "completed" }, { text: "b", status: "in_progress" }] }],
  native: { events: 3, tools: 0 },
};
const learning = [
  { storedAt: 1, signal: { id: "l1", content: { domain: "architecture", decision: "requested", evidence: { messageId: "t1" } } } },
  { storedAt: 2, signal: { id: "l2", content: { domain: "architecture", decision: "native-evidence", evidence: { messageId: "t1" } } } },
  { storedAt: 3, signal: { id: "l3", content: { domain: "architecture", decision: "learned", revision: 3, job: { id: "j", base: { revision: 2 } }, evidence: { messageId: "t1" } } } },
  { storedAt: 4, signal: { id: "l4", content: { domain: "security", decision: "error", reason: "provider down", evidence: { messageId: "t1" } } } },
  { storedAt: 5, signal: { id: "l5", content: { domain: "architecture", decision: "learned", revision: 9, evidence: { messageId: "other-turn" } } } },
];

test("turn flow: input → harness stages → routing ∥ domains → sealed phases → delivered layers → executor → guards, tasks → delivery → writeback", () => {
  const g = turnFlowGraph(turn, { learning });
  const byId = new Map(g.nodes.map((n: any) => [n.id, n]));
  expect(g.nodes.map((n: any) => n.id)).toEqual(["input", "span:classify", "routing", "domain:architecture", "domain:security", "plan",
    "layer:architecture", "layer:thread-knowledge:architecture", "executor", "tasks:TodoWrite", "guard:0", "delivery", "learn:architecture", "learn:security"]);
  // Columns strictly advance along the loop.
  const col = (id: string) => byId.get(id).col;
  expect(col("input") < col("span:classify") && col("span:classify") < col("routing") && col("routing") === col("domain:security")).toBe(true);
  expect(col("plan") < col("layer:architecture") && col("layer:architecture") < col("executor") && col("executor") < col("guard:0") && col("guard:0") < col("delivery") && col("delivery") < col("learn:architecture")).toBe(true);
  // Recorded decisions drive status; nothing absent is filled in.
  expect(byId.get("routing")).toMatchObject({ status: "warn", sub: "fallback · 900 ms" });
  expect(byId.get("domain:architecture")).toMatchObject({ status: "ok", sub: "contribute · rev 2" });
  expect(byId.get("domain:security").status).toBe("warn");
  expect(byId.get("plan")).toMatchObject({ status: "skip", sub: "journalled phases only" });
  expect(byId.get("layer:architecture")).toMatchObject({ status: "warn", sub: "drift", target: { type: "layer", layerId: "architecture" } });
  expect(byId.get("layer:thread-knowledge:architecture").sub).toBe("delivered · rev 2→3");
  expect(byId.get("guard:0")).toMatchObject({ status: "error", sub: "reported · 2 findings" });
  expect(byId.get("tasks:TodoWrite")).toMatchObject({ sub: "1/2 completed", status: "pending" });
  expect(byId.get("delivery").sub).toBe("2 layers committed · 1 drift");
  // Writeback: the latest outcome per domain from this turn's evidence, bookkeeping and other turns excluded.
  expect(byId.get("learn:architecture")).toMatchObject({ sub: "learned · rev 2→3", status: "ok", target: { type: "layer", layerId: "architecture" } });
  expect(byId.get("learn:security")).toMatchObject({ status: "error", target: { type: "layer", layerId: "thread-knowledge:security" } });
  // Decisions ride the edges; every node but input has an incoming edge.
  const edge = (from: string, to: string) => g.edges.find((e: any) => e.from === from && e.to === to);
  expect(edge("routing", "plan").label).toBe("1 domain · conf 0.4");
  expect(edge("domain:security", "plan").label).toBe("timeout");
  expect(edge("executor", "guard:0")).toMatchObject({ label: "Bash", status: "error" });
  expect(edge("executor", "delivery").label).toBe("1 drift");
  expect(edge("delivery", "learn:architecture").label).toBe("learned");
  const targets = new Set(g.edges.map((e: any) => e.to));
  expect(g.nodes.filter((n: any) => n.id !== "input" && !targets.has(n.id))).toEqual([]);
  expect(g.nodes.every((n: any) => n.target)).toBe(true);
  expect(overlaps(g.nodes)).toBe(false);
  expect(g.width).toBeGreaterThan(0);
});

test("turn flow: a sealed plan supplies timings; a running turn with no delivery ends at the executor; no turn, no graph", () => {
  const running = { ...turn, status: "active", phases: [], delivery: null, tasks: [], spans: [],
    plan: { elapsed: 42, layers: ["architecture"], domainsConsulted: ["architecture"], outstanding: [{ kind: "advise", participant: "security" }],
      routing: { status: "routed", domains: ["architecture"], layers: [], confidence: 1, elapsedMs: 30 },
      contributions: [{ domain: "architecture", decision: "abstain", provenance: { threadKnowledgeRevision: 0, elapsedMs: 17 }, snippets: [] }] } };
  const g = turnFlowGraph(running, { learning: [] });
  const byId = new Map(g.nodes.map((n: any) => [n.id, n]));
  expect(g.nodes.map((n: any) => n.id)).toEqual(["input", "routing", "domain:architecture", "plan", "executor"]);
  expect(byId.get("plan")).toMatchObject({ status: "warn", sub: "1 layer · 42 ms" });
  expect(byId.get("domain:architecture")).toMatchObject({ status: "skip", sub: "abstain · rev 0 · 17 ms" });
  expect(byId.get("routing").sub).toBe("routed · 30 ms");
  expect(byId.get("executor").status).toBe("pending");
  expect(turnFlowGraph(null)).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
});

const loopTurn = (turnId: string, startedAt: number, revisions: Record<string, number>) => ({ threadId: "a", turnId, status: "completed", startedAt, input: { preview: turnId },
  phases: [{ id: `adv-${turnId}`, turnId, phase: "advice", record: { participants: Object.entries(revisions).map(([domain, r]) => ({ domain, decision: "contribute", threadKnowledgeRevision: r })) } }],
  delivery: { layers: [{ id: "arch-cache", domain: "architecture", deliveredHash: "h", drift: false }], committed: [] } });
const entry = (id: string, turnId: string, domain: string, decision: string, revision?: number) =>
  ({ storedAt: 1, signal: { id, content: { domain, decision, evidence: { messageId: turnId }, ...(revision === undefined ? {} : { revision }) } } });

test("learning loop: a learned revision links to the first later turn that assessed it, and to the committed revision now", () => {
  const flow = { ...emptyFlow("a"), journal: "available",
    turns: [loopTurn("t1", 1, { architecture: 0, testing: 0 }), loopTurn("t2", 2, { architecture: 0, testing: 1 }), loopTurn("t3", 3, { architecture: 1, testing: 1 })],
    learning: [entry("old", "t0", "architecture", "learned", 0), entry("l1", "t1", "architecture", "learned", 1), entry("l2", "t1", "testing", "learned", 1),
      entry("l3", "t2", "architecture", "abstain"), entry("b", "t2", "testing", "capacity-settled")],
    knowledge: { domains: { architecture: { revision: 1 }, testing: { revision: 1 } } }, review: { architecture: { status: "idle" }, testing: { status: "pending", queued: 1 } } };
  const g = learningLoop(flow);
  expect(g.lanes).toEqual(["architecture", "testing"]);
  const feedback = g.edges.filter((e: any) => e.kind === "feedback").map((e: any) => `${e.from}->${e.to}`);
  // Architecture's revision 1 (learned at t1) is first assessed at t3; testing's at t2.
  expect(feedback).toEqual(expect.arrayContaining(["write:t1:architecture->assess:t3:architecture", "write:t1:testing->assess:t2:testing",
    "write:t1:architecture->now:architecture", "write:t1:testing->now:testing"]));
  expect(g.edges.filter((e: any) => e.kind === "writeback").map((e: any) => e.from).sort()).toEqual(["assess:t1:architecture", "assess:t1:testing", "assess:t2:architecture"]);
  const byId = new Map(g.nodes.map((n: any) => [n.id, n]));
  expect(byId.has("write:t2:testing")).toBe(false); // bookkeeping is not an outcome
  expect(byId.get("now:testing")).toMatchObject({ status: "pending", sub: "rev 1 · pending" });
  expect(byId.get("now:architecture").target).toEqual({ type: "layer", layerId: "arch-cache" });
  expect(byId.get("assess:t2:architecture").target).toEqual({ type: "turn", threadId: "a", turnId: "t2" });
  expect(g.earlier).toBe(1);
  // Lanes are rows, turns are columns, and time runs left to right.
  expect(byId.get("assess:t1:testing").y).toBeGreaterThan(byId.get("assess:t1:architecture").y);
  expect(byId.get("assess:t2:architecture").x).toBeGreaterThan(byId.get("write:t1:architecture").x);
  expect(overlaps(g.nodes)).toBe(false);
});

test("learning loop: no domains and no knowledge gives no lanes", () => {
  expect(learningLoop({ ...emptyFlow("a"), turns: [{ threadId: "a", turnId: "t", phases: [] }] }).lanes).toEqual([]);
});

test("flow frames: snapshot replaces, a turn append upserts in start order within the window, learning dedupes, knowledge replaces", () => {
  let state = applyFlowFrame(emptyFlow("a"), { action: "snapshot", payload: { threadId: "a", journal: "available", turns: [{ turnId: "t2", startedAt: 2 }, { turnId: "t1", startedAt: 1 }],
    learning: [{ signal: { id: "x" } }], knowledge: null, review: null, limits: { turns: 2, learning: 2 } } });
  expect(state.turns.map((t: any) => t.turnId)).toEqual(["t1", "t2"]);
  state = applyFlowFrame(state, { action: "append", payload: { kind: "turn", turn: { turnId: "t1", startedAt: 1, status: "completed" } } });
  expect(state.turns.map((t: any) => [t.turnId, t.status])).toEqual([["t1", "completed"], ["t2", undefined]]);
  state = applyFlowFrame(state, { action: "append", payload: { kind: "turn", turn: { turnId: "t3", startedAt: 3 } } });
  expect(state.turns.map((t: any) => t.turnId)).toEqual(["t2", "t3"]);
  const same = applyFlowFrame(state, { action: "append", payload: { kind: "learning", entries: [{ signal: { id: "x" } }] } });
  expect(same).toBe(state);
  state = applyFlowFrame(state, { action: "append", payload: { kind: "learning", entries: [{ signal: { id: "y" } }, { signal: { id: "z" } }] } });
  expect(state.learning.map((e: any) => e.signal.id)).toEqual(["y", "z"]);
  state = applyFlowFrame(state, { action: "append", payload: { kind: "knowledge", knowledge: { domains: { d: { revision: 2 } } }, review: { d: { status: "idle" } } } });
  expect(state.knowledge.domains.d.revision).toBe(2);
  expect(state.review.d.status).toBe("idle");
});

test("layout and edges: columns never overlap; paths leave the source's right edge (lr) or bottom (tb)", () => {
  const nodes = [{ col: 0 }, { col: 1 }, { col: 1 }, { col: 1 }, { col: 3 }].map((n, i) => ({ id: `n${i}`, ...n }));
  const size = layoutColumns(nodes);
  expect(overlaps(nodes)).toBe(false);
  expect(size.width).toBe(Math.max(...nodes.map((n: any) => n.x + n.w)));
  const a = { x: 0, y: 0, w: 100, h: 40 }, b = { x: 200, y: 100, w: 100, h: 40 };
  expect(edgePath(a, b).d.startsWith("M100,20 ")).toBe(true);
  expect(edgePath(a, b).d.endsWith(" 200,120")).toBe(true);
  expect(edgePath(a, b, "tb").d.startsWith("M50,40 ")).toBe(true);
  // An arc leaves the top centre of its source and lands on the top centre of its target.
  expect(edgePath(a, b, "lr", true).d).toMatch(/^M50,0 C50,-14 250,-14 250,100$/);
  expect(domainLayer({ delivery: { layers: [{ id: "thread-knowledge:x", domain: "x" }] } }, "x")).toBe("thread-knowledge:x");
});
