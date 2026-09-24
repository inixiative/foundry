import { expect, test } from "bun:test";
import { ContextLayer, ContextStack, SignalBus, type LLMMessage } from "@inixiative/foundry-core";
import { Cartographer } from "../src/agents/cartographer";
import { DomainLibrarian } from "../src/agents/domain-librarian";
import { FlowOrchestrator } from "../src/agents/flow-orchestrator";
import { Librarian } from "../src/agents/librarian";

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

test("historical expert evidence retains the actual phase protocol, separately from its three owned parts", async () => {
  const cache = new ContextLayer({ id: "architecture", segment: "domain-knowledge" });
  cache.set("DOMAIN_BEFORE: existing readers must keep working.");
  const stack = new ContextStack([cache]), signals = new SignalBus();
  const librarian = new Librarian({ stack, signals });
  const cartographer = new Cartographer({ stack, signals, llm: {
    id: "controlled-phase-route", async complete() {
      return { model: "controlled", content: '{"layers":[],"domains":["architecture"],"confidence":1}' };
    },
  } });
  const calls: LLMMessage[][] = [];
  const expert = new DomainLibrarian({ domain: "architecture", cache, signals,
    advisePrompt: "INSTRUCTIONS_BEFORE: assess architecture decisions.", llm: {
      id: "controlled-phase-expert", async complete(messages) {
        calls.push(structuredClone(messages));
        return { model: "controlled", content: '{"layers":[],"snippets":["Keep the legacy reader regression"],"confidence":1}' };
      },
    },
  });
  const flow = new FlowOrchestrator({ stack, signals, librarian, cartographer,
    domainLibrarians: new Map([["architecture", expert]]) });
  try {
    const plan = await flow.preMessage("Add preferred names");
    const prepared = await flow.hydrateDelta(plan);
    expect(calls).toHaveLength(1);
    const actualUserInput = calls[0]!.find(message => message.role === "user")!.content;
    const protocolStart = actualUserInput.indexOf("## Response protocol (advice phase)");
    expect(protocolStart).toBeGreaterThanOrEqual(0);
    const actualProtocol = actualUserInput.slice(protocolStart).trim();
    expect(actualProtocol).toContain('"layers"');

    // Inspect persisted-shaped evidence, not the current expert or source constant.
    const historical = JSON.parse(JSON.stringify({ plan, decoration: prepared.decoration }));
    cache.set("DOMAIN_AFTER: changed after the turn.");
    expect(historical.plan.contributions[0].segments).toEqual({
      instructions: "INSTRUCTIONS_BEFORE: assess architecture decisions.",
      domainKnowledge: "DOMAIN_BEFORE: existing readers must keep working.", threadKnowledge: "",
    });
    expect(JSON.stringify(historical)).not.toContain("DOMAIN_AFTER");
    expect(strings(historical).some(value => value.includes(actualProtocol))).toBe(true);
  } finally {
    flow.dispose(); cartographer.dispose(); librarian.dispose();
  }
});
