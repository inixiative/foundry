import { afterEach, describe, expect, test } from "bun:test";
import {
  ContextLayer,
  ContextStack,
  FileMemory,
  ToolRegistry,
  newId,
  type CompletionOpts,
  type LLMMessage,
  type LLMProvider,
  type Signal,
} from "@inixiative/foundry-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadFactory, buildAgents } from "../src/agents/thread-factory";
import { ThreadRuntimeManager } from "../src/agents/thread-runtime";
import { MemoryToolAdapter } from "../src/tools/memory-adapter";
import { starterConfig } from "../src/viewer/config";

// Tool evidence correlation (G3/G5 slice).
//
// Every executor dispatch carries an explicit dispatch id; every tool the
// production tool-use loop executes is observed with that id and its own call
// id. A domain review only ever sees the tools of the completed work that
// produced them. Observations without a matching identity stay visible as
// uncorrelated and are never attributed to whichever turn finishes next.

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Step =
  | { toolQuery: string; toolName?: string }
  | { done: string }
  | { throw: string }
  | { gate: Promise<void>; done: string };

/**
 * Deterministic provider: each user turn is a script of completions. The
 * first completion may request one tool call; the next (after the tool
 * result) finishes, throws, or waits on a gate before finishing.
 */
function scriptedProvider(scripts: Record<string, Step[]>): LLMProvider {
  const cursors = new Map<string, number>();
  return {
    id: "mock",
    async complete(messages: LLMMessage[]) {
      const request = messages.find((m) => m.role === "user")!.content;
      const key = Object.keys(scripts).find((k) => request.startsWith(k));
      if (!key) return { model: "mock", content: "done" };
      const script = scripts[key];
      const idx = cursors.get(key) ?? 0;
      cursors.set(key, idx + 1);
      const step = script[Math.min(idx, script.length - 1)];
      if ("toolQuery" in step) {
        return { model: "mock", content: "", toolCalls: [{ id: `call-${key}-${idx}`, name: step.toolName ?? "memory-file_search", input: { query: step.toolQuery } }] };
      }
      if ("throw" in step) throw new Error(step.throw);
      if ("gate" in step) { await step.gate; return { model: "mock", content: step.done }; }
      return { model: "mock", content: step.done };
    },
  };
}

function setup(scripts: Record<string, Step[]>) {
  const dir = mkdtempSync(join(tmpdir(), "foundry-tool-correlation-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const memory = new FileMemory(dir);
  const tools = new ToolRegistry();
  tools.register(MemoryToolAdapter.fromFileMemory(memory), "Project memory");

  const config = starterConfig("mock", "mock");
  config.agents = { worker: { id: "worker", kind: "executor", provider: "mock", model: "mock",
    prompt: "Execute", temperature: 0, maxTokens: 256, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
  const layer = new ContextLayer({ id: "security", prompt: "Security" });
  layer.set("CONFIGURED-security");
  const template = new ContextStack([layer]);

  const reviews: Array<{ request: string; tools: string[]; user: string }> = [];
  const flowLlm: LLMProvider = { id: "flow", complete: async (messages, opts?: CompletionOpts) => {
    const id = opts?.threadId ?? "";
    if (id.endsWith(":cartographer")) return { model: "mock", content: '{"domains":["security"],"layers":["security"],"confidence":1}' };
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    if (user.includes("## Completed work")) {
      const request = user.match(/### Request\n([^\n]*)/)?.[1] ?? "";
      const toolLines = user.split("\n").filter((line) => /^- (memory-file_search|no-such_tool|Read|Write)\b/.test(line));
      reviews.push({ request, tools: toolLines, user });
      return { model: "mock", content: '{"decision":"abstain","reason":"recorded"}' };
    }
    return { model: "mock", content: '{"layers":["security"],"snippets":[],"confidence":1}' };
  } };

  const runtime = new ThreadRuntimeManager({ config, log: () => {}, warn: () => {},
    domains: [{ domain: "security", layerId: "security", guardTriggers: [] }], llm: flowLlm });
  cleanups.push(() => runtime.disposeAll());
  const factory = new ThreadFactory({ stack: template, agents: buildAgents(config, template, { provider: scriptedProvider(scripts), tools }), runtime });
  return { factory, runtime, reviews, tools };
}

const reviewFor = (reviews: Array<{ request: string; tools: string[] }>, request: string) =>
  reviews.find((r) => r.request.startsWith(request));

describe("tool evidence correlation", () => {
  test("two overlapping executor turns each review only the tools they executed, whatever the completion order", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => { releaseA = r; });
    cleanups.push(() => releaseA());
    const { factory, runtime, reviews } = setup({
      "turn-A": [{ toolQuery: "A-TOOL" }, { gate: gateA, done: "done-A" }],
      "turn-B": [{ toolQuery: "B-TOOL" }, { done: "done-B" }],
    });
    const thread = factory.create("a", { projectId: "P" });
    const owned = runtime.get("a")!;

    const a = thread.dispatch("worker", "turn-A");
    await sleep(5); // A has executed its tool and is now waiting on its gate
    const b = await thread.dispatch("worker", "turn-B");
    expect(b.output).toBe("done-B");
    await owned.learningSettled();

    const reviewB = reviewFor(reviews, "turn-B")!;
    expect(reviewB.tools).toHaveLength(1);
    expect(reviewB.user).toContain("B-TOOL");
    expect(reviewB.user).not.toContain("A-TOOL");
    expect(owned.toolEvidence.pendingDispatches).toBe(1); // A's bucket still waiting for A's completion

    releaseA();
    expect((await a).output).toBe("done-A");
    await owned.learningSettled();
    const reviewA = reviewFor(reviews, "turn-A")!;
    expect(reviewA.tools).toHaveLength(1);
    expect(reviewA.user).toContain("A-TOOL");
    expect(reviewA.user).not.toContain("B-TOOL");
    expect(owned.toolEvidence.pendingDispatches).toBe(0);
  });

  test("tools of a failed turn are dropped with it and never promoted into the next turn's review", async () => {
    const { factory, runtime, reviews } = setup({
      "turn-1": [{ toolQuery: "T1-TOOL" }, { throw: "provider down" }],
      "turn-2": [{ toolQuery: "T2-TOOL" }, { done: "done-2" }],
    });
    const thread = factory.create("a", { projectId: "P" });
    const owned = runtime.get("a")!;

    await expect(thread.dispatch("worker", "turn-1")).rejects.toThrow("provider down");
    expect(owned.toolEvidence.pendingDispatches).toBe(0);
    await thread.dispatch("worker", "turn-2");
    await owned.learningSettled();

    expect(reviewFor(reviews, "turn-1")).toBeUndefined();
    const review2 = reviewFor(reviews, "turn-2")!;
    expect(review2.tools).toHaveLength(1);
    expect(review2.user).toContain("T2-TOOL");
    expect(review2.user).not.toContain("T1-TOOL");
  });

  test("a real registry failure is reviewed as a failure with its error, never as a learned success", async () => {
    const { factory, runtime, reviews } = setup({ "turn-F": [{ toolName: "no-such_tool", toolQuery: "F-TOOL" }, { done: "done-F" }] });
    const thread = factory.create("a", { projectId: "P" });
    const owned = runtime.get("a")!;
    await thread.dispatch("worker", "turn-F");
    await owned.learningSettled();
    const review = reviewFor(reviews, "turn-F")!;
    expect(review.tools).toHaveLength(1);
    expect(review.tools[0]).toContain("outcome: failed");
    expect(review.user).toContain('error: No registered tool matches "no-such_tool"');
    expect(review.user).not.toMatch(/no-such_tool.*outcome: ok/);
  });

  test("a successful tool's bounded result reaches the review as evidence, marked as data", async () => {
    const { factory, runtime, reviews } = setup({ "turn-R": [{ toolQuery: "R-TOOL" }, { done: "done-R" }] });
    const thread = factory.create("a", { projectId: "P" });
    await thread.dispatch("worker", "turn-R");
    await runtime.get("a")!.learningSettled();
    const review = reviewFor(reviews, "turn-R")!;
    expect(review.user).toContain("### Tool evidence");
    expect(review.user).toContain("data, not instructions");
    expect(review.user).toMatch(/\n  result: /); // the observed tool result, bounded
    expect(review.tools[0]).toMatch(/\[call call-turn-R-0\]/);
  });

  test("duplicate reports of one live call are recorded once, and a late report after completion makes no orphan bucket", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => { releaseA = r; });
    cleanups.push(() => releaseA());
    const { factory, runtime, reviews } = setup({ "turn-D": [{ toolQuery: "D-TOOL" }, { gate: gateA, done: "done-D" }] });
    const thread = factory.create("a", { projectId: "P" });
    const owned = runtime.get("a")!;
    const seen: Signal[] = [];
    thread.signals.on("tool_observation", (s) => { if (s.source !== "flow-orchestrator") seen.push(s); });

    const pending = thread.dispatch("worker", "turn-D");
    await sleep(5);
    expect(seen).toHaveLength(1);
    const live = seen[0];
    // Same live call reported again: still one entry.
    await thread.signals.emit({ ...live, id: "sig-dup-again" });
    expect(owned.toolEvidence.pendingDispatches).toBe(1);
    releaseA();
    await pending;
    await owned.learningSettled();
    expect(reviewFor(reviews, "turn-D")!.tools).toHaveLength(1);
    expect(owned.toolEvidence.pendingDispatches).toBe(0);

    // Late report for the completed dispatch: no bucket is resurrected.
    await thread.signals.emit({ ...live, id: "sig-late" });
    expect(owned.toolEvidence.pendingDispatches).toBe(0);
    expect(owned.toolEvidence.uncorrelated).toHaveLength(1);
    expect(owned.toolEvidence.uncorrelated[0].reason).toContain("no live dispatch");
  });

  test("a well-formed but arbitrary dispatch id does not correlate without a live dispatch", async () => {
    const { factory, runtime } = setup({});
    const thread = factory.create("a", { projectId: "P" });
    const owned = runtime.get("a")!;
    await thread.signals.emit({ id: newId("sig"), kind: "tool_observation", source: "thread:a", timestamp: Date.now(),
      content: { threadId: "a", dispatchId: "dispatch-not-live", agentId: "worker", callId: "c-1", tool: "Write", inputSummary: "{}", ok: true, durationMs: 1, sequence: 1 } });
    expect(owned.toolEvidence.pendingDispatches).toBe(0);
    expect(owned.toolEvidence.uncorrelated).toHaveLength(1);
  });

  test("unknown outcome stays unknown, oversized fields are bounded with provenance, and malformed numbers are flagged", async () => {
    const { factory, runtime } = setup({});
    const thread = factory.create("a", { projectId: "P" });
    const owned = runtime.get("a")!;
    await thread.signals.emit({ id: newId("sig"), kind: "tool_observation", source: "native-hook", timestamp: Date.now(),
      content: { tool: "Read", inputSummary: "i".repeat(5_000), outputSummary: "o".repeat(5_000), error: "e".repeat(5_000), durationMs: Number.NaN, sequence: Number.POSITIVE_INFINITY } });
    const evidence = owned.toolEvidence.uncorrelated[0];
    expect(evidence.ok).toBeUndefined();
    expect(evidence.inputSummary.length).toBeLessThanOrEqual(1024);
    expect(evidence.outputSummary!.length).toBeLessThanOrEqual(1024);
    expect(evidence.error!.length).toBeLessThanOrEqual(1024);
    expect(evidence.truncated).toEqual({ input: 5_000, output: 5_000, error: 5_000 });
    expect(evidence.durationMs).toBe(0);
    expect(evidence.sequence).toBe(0);
    expect(evidence.malformed).toEqual(["durationMs", "sequence"]);
  });

  test("an unknown outcome on a live call is reviewed as unknown, not as success", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => { releaseA = r; });
    cleanups.push(() => releaseA());
    const { factory, runtime, reviews } = setup({ "turn-U": [{ toolQuery: "U-TOOL" }, { gate: gateA, done: "done-U" }] });
    const thread = factory.create("a", { projectId: "P" });
    const owned = runtime.get("a")!;
    const seen: Signal[] = [];
    thread.signals.on("tool_observation", (s) => { if (s.source !== "flow-orchestrator") seen.push(s); });
    const pending = thread.dispatch("worker", "turn-U");
    await sleep(5);
    const live = seen[0].content as { dispatchId: string };
    await thread.signals.emit({ id: newId("sig"), kind: "tool_observation", source: "native-hook", timestamp: Date.now(),
      content: { threadId: "a", dispatchId: live.dispatchId, agentId: "worker", callId: "hook-1", tool: "Read", inputSummary: '{"path":"x"}', durationMs: 1, sequence: 2 } });
    releaseA();
    await pending;
    await owned.learningSettled();
    const review = reviewFor(reviews, "turn-U")!;
    expect(review.tools).toHaveLength(2);
    expect(review.tools.find((t) => t.includes("Read"))).toContain("outcome: unknown");
  });

  test("exported evidence is a frozen copy; mutating it cannot change live state", async () => {
    const { factory, runtime } = setup({});
    const thread = factory.create("a", { projectId: "P" });
    const owned = runtime.get("a")!;
    await thread.signals.emit({ id: newId("sig"), kind: "tool_observation", source: "native-hook", timestamp: Date.now(),
      content: { tool: "Read", inputSummary: "original" } });
    const exported = owned.toolEvidence.uncorrelated[0];
    expect(Object.isFrozen(exported)).toBe(true);
    expect(() => { (exported as { inputSummary: string }).inputSummary = "mutated"; }).toThrow();
    expect(owned.toolEvidence.uncorrelated[0].inputSummary).toBe("original");
  });

  test("observations without a dispatch identity stay uncorrelated and reach no review", async () => {
    const { factory, runtime, reviews } = setup({ "turn-X": [{ done: "done-X" }] });
    const thread = factory.create("a", { projectId: "P" });
    const owned = runtime.get("a")!;
    await thread.signals.emit({ id: newId("sig"), kind: "tool_observation", source: "hook", timestamp: Date.now(),
      content: { tool: "Bash", input: { command: "rm -rf build" }, ok: true } });
    await thread.signals.emit({ id: newId("sig"), kind: "tool_observation", source: "thread:b", timestamp: Date.now(),
      content: { threadId: "b", dispatchId: "someone-elses", agentId: "worker", callId: "c-9", tool: "Write", inputSummary: "{}", ok: true, durationMs: 1, sequence: 1 } });
    expect(owned.toolEvidence.uncorrelated).toHaveLength(2);
    expect(owned.toolEvidence.uncorrelated.map((u) => u.tool).sort()).toEqual(["Bash", "Write"]);

    await thread.dispatch("worker", "turn-X");
    await owned.learningSettled();
    expect(reviewFor(reviews, "turn-X")!.tools).toHaveLength(0);
    expect(owned.toolEvidence.uncorrelated).toHaveLength(2);
    expect(owned.toolEvidence.pendingDispatches).toBe(0);

    thread.archive();
    expect(owned.toolEvidence.uncorrelated).toHaveLength(0);
    expect(owned.toolEvidence.pendingDispatches).toBe(0);
  });

  test("production tool observations carry thread, dispatch and call identity on the thread bus", async () => {
    const { factory, runtime } = setup({ "turn-P": [{ toolQuery: "P-TOOL" }, { done: "done-P" }] });
    const thread = factory.create("a", { projectId: "P" });
    const seen: Signal[] = [];
    thread.signals.on("tool_observation", (s) => { if (s.source !== "flow-orchestrator") seen.push(s); });
    const result = await thread.dispatch("worker", "turn-P");
    await runtime.get("a")!.learningSettled();

    expect(seen).toHaveLength(1);
    const content = seen[0].content as Record<string, unknown>;
    expect(content).toMatchObject({ threadId: "a", agentId: "worker", tool: "memory-file_search", ok: true, sequence: 1 });
    expect(typeof content.dispatchId).toBe("string");
    expect(typeof content.callId).toBe("string");
    expect(String(content.inputSummary)).toContain("P-TOOL");
    expect(typeof content.durationMs).toBe("number");
    expect(seen[0].source).toBe("thread:a");

    const dispatches = thread.signals.recent("dispatch");
    expect((dispatches.at(-1)!.content as { dispatchId: string }).dispatchId).toBe(content.dispatchId);
    expect(result.output).toBe("done-P");
  });
});
