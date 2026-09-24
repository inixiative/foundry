import { expect, test } from "bun:test";
import { ContextLayer, ContextStack, SignalBus } from "@inixiative/foundry-core";
import { Cartographer } from "../src/agents/cartographer";
import { DomainLibrarian } from "../src/agents/domain-librarian";
import { FlowOrchestrator } from "../src/agents/flow-orchestrator";
import { Librarian } from "../src/agents/librarian";

test("malformed advice remains an inspectable error beside a valid contribution", async () => {
  const signals = new SignalBus();
  const layers = ["architecture", "testing"].map(id => {
    const layer = new ContextLayer({ id, segment: "domain-knowledge" });
    layer.set(`Knowledge for ${id}`);
    return layer;
  });
  const stack = new ContextStack(layers);
  const librarian = new Librarian({ stack, signals });
  const cartographer = new Cartographer({ stack, signals, llm: {
    id: "parent-route", async complete() {
      return { model: "controlled", content: JSON.stringify({ layers: [], domains: ["architecture", "testing"], confidence: 1 }) };
    },
  } });
  const domains = new Map(layers.map(cache => [cache.id, new DomainLibrarian({
    domain: cache.id, cache, signals, advisePrompt: `Instructions for ${cache.id}`,
    llm: { id: `parent-${cache.id}`, async complete() {
      return { model: "controlled", content: JSON.stringify(cache.id === "architecture"
        ? { domain: "architecture", assessment: { decisions: ["PRIVATE_MALFORMED_OUTPUT"] } }
        : { layers: [], snippets: ["Verify legacy readers after reopening"], confidence: 1 }) };
    } },
  })]));
  const flow = new FlowOrchestrator({ stack, signals, librarian, cartographer, domainLibrarians: domains });
  try {
    const plan = await flow.preMessage("Add preferred names without losing existing data");
    expect(plan.contributions.map(c => [c.domain, c.decision])).toEqual([
      ["architecture", "error"], ["testing", "contribute"],
    ]);
    expect(plan.snippets).toEqual(["Verify legacy readers after reopening"]);
    const failed = plan.contributions[0]!;
    expect(failed.reason).toBeTruthy();
    expect(failed.reason).not.toContain("PRIVATE_MALFORMED_OUTPUT");
    expect(failed.segments).toEqual({
      instructions: "Instructions for architecture", domainKnowledge: "Knowledge for architecture", threadKnowledge: "",
    });
    const sealed = JSON.stringify(plan);
    const prepared = await flow.hydrateDelta(plan);
    const participant = prepared.decoration.participants.find(p => p.id === "architecture")!;
    expect(participant.decision).toBe("error");
    expect(participant.reason).toBe(failed.reason);
    expect(participant.segments).toEqual(failed.segments);
    expect(JSON.stringify(prepared.decoration)).not.toContain("PRIVATE_MALFORMED_OUTPUT");
    expect(JSON.stringify(plan)).toBe(sealed);
    expect(Object.isFrozen(plan)).toBe(true);
  } finally {
    flow.dispose(); cartographer.dispose(); librarian.dispose();
  }
});
