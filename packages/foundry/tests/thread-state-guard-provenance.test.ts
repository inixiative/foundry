import { expect, test } from "bun:test";
import { ContextLayer, ContextStack, SignalBus } from "@inixiative/foundry-core";
import { Cartographer } from "../src/agents/cartographer";
import { DomainLibrarian } from "../src/agents/domain-librarian";
import { FlowOrchestrator } from "../src/agents/flow-orchestrator";
import { Librarian } from "../src/agents/librarian";

async function observedState(failed: boolean) {
  const signals = new SignalBus();
  const cache = new ContextLayer({ id: "architecture", segment: "domain-knowledge" });
  cache.set("Preserve existing storage values.");
  const stack = new ContextStack([cache]);
  const librarian = new Librarian({ stack, signals });
  const domain = new DomainLibrarian({ domain: "architecture", cache, signals, guardTriggers: ["Write"],
    llm: { id: "parent-guard-state", async complete() {
      if (failed) throw Error("CONTROLLED_CHECK_UNAVAILABLE");
      return { model: "controlled", content: '{"findings":[]}' };
    } } });
  const cartographer = new Cartographer({ stack, signals, llm: { id: "unused-route", async complete() { throw Error("No route call expected"); } } });
  const flow = new FlowOrchestrator({ stack, signals, librarian, cartographer, domainLibrarians: new Map([["architecture", domain]]) });
  const observation = { tool: "Write", input: { file_path: "contacts.ts" }, output: "Migration edited" };
  try {
    await signals.emit({ id: "original-tool-result", kind: "tool_observation", source: "thread:parent-state",
      content: { ...observation, ok: true, callId: "original-call" }, timestamp: 1 });
    const originalActivity = structuredClone(librarian.state.recentActivity);
    const report = await flow.postAction(observation);
    expect(report.outcomes[0]!.status).toBe(failed ? "provider-error" : "completed");
    return { originalActivity, activity: structuredClone(librarian.state.recentActivity) };
  } finally { flow.dispose(); cartographer.dispose(); librarian.dispose(); }
}

test("guard inspection does not invent a second execution of the observed tool", async () => {
  const { originalActivity, activity } = await observedState(false);
  expect(originalActivity).toHaveLength(1);
  expect(activity.filter(item => item === originalActivity[0])).toHaveLength(1);
});

test("shared thread activity distinguishes a failed guard from a completed all-clear", async () => {
  const completed = await observedState(false);
  const failed = await observedState(true);
  expect(failed.activity).not.toEqual(completed.activity);
});

test("legacy guard reports say unrecorded and never expose private inputs or errors", async () => {
  const signals = new SignalBus();
  const librarian = new Librarian({ stack: new ContextStack(), signals });
  try {
    await signals.emit({ id: "legacy-guard", kind: "tool_observation", source: "flow-orchestrator",
      content: { tool: "Write", input: { file_path: "PRIVATE_INPUT" }, guardsRan: ["architecture"], findingsCount: 0 }, timestamp: 1 });
    expect(librarian.state.recentActivity).toEqual(["Guard review: outcome not recorded"]);
    await signals.emit({ id: "failed-guard", kind: "tool_observation", source: "flow-orchestrator",
      content: { guardOutcomes: [{ domain: "architecture", status: "provider-error", error: "PRIVATE_ERROR", request: "PRIVATE_REQUEST" }] }, timestamp: 2 });
    expect(librarian.state.recentActivity.at(-1)).toBe("Guard (architecture): provider-error");
    expect(librarian.layer.content).not.toContain("PRIVATE_");
  } finally { librarian.dispose(); }
});

test("a guard report with no selected domains does not claim a check completed", async () => {
  const signals = new SignalBus();
  const librarian = new Librarian({ stack: new ContextStack(), signals });
  try {
    await signals.emit({ id: "no-guards", kind: "tool_observation", source: "flow-orchestrator",
      content: { guardOutcomes: [] }, timestamp: 1 });
    expect(librarian.state.recentActivity).toEqual(["Guard review: no domains checked"]);
  } finally { librarian.dispose(); }
});
