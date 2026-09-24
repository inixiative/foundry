import { describe, expect, it } from "bun:test";
import { ContextLayer, SignalBus, type LLMMessage, type LLMProvider } from "@inixiative/foundry-core";
import { DomainLibrarian } from "../src/agents/domain-librarian";

function fixture(output: string) {
  const calls: LLMMessage[][] = [];
  const llm: LLMProvider = {
    id: "parent-advice-protocol",
    async complete(messages) {
      calls.push(structuredClone(messages));
      return { content: output, model: "controlled" };
    },
  };
  const cache = new ContextLayer({ id: "architecture", segment: "domain-knowledge" });
  cache.set("DOMAIN_KNOWLEDGE: migrations preserve existing values.");
  const lib = new DomainLibrarian({
    domain: "architecture", cache, signals: new SignalBus(), llm,
    advisePrompt: "DOMAIN_INSTRUCTIONS: inspect architecture and ownership boundaries.",
  });
  return { lib, calls };
}

describe("advice phase protocol independent of domain instructions", () => {
  it("supplies the response contract while retaining all three expert parts", async () => {
    const { lib, calls } = fixture('{"layers":[],"snippets":["Preserve existing names"],"confidence":0.9}');
    const result = await lib.advise("MESSAGE: add preferred names", "COMMON_EVIDENCE: A1", {
      threadKnowledge: "THREAD_UNDERSTANDING: legacy callers still exist",
    });
    expect(result.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.map(message => message.content).join("\n");
    for (const part of ["DOMAIN_INSTRUCTIONS", "DOMAIN_KNOWLEDGE", "THREAD_UNDERSTANDING", "COMMON_EVIDENCE", "MESSAGE"]) {
      expect(prompt).toContain(part);
    }
    for (const field of ["layers", "snippets", "confidence"]) expect(prompt).toContain(`"${field}"`);
    expect(prompt).not.toContain("verbatim excerpts");
    expect(result.snippets).toEqual(["Preserve existing names"]);
  });

  const invalid: Array<[string, unknown]> = [
    ["pilot-shaped arbitrary domain JSON", { domain: "architecture", assessment: { decisions: ["PRIVATE_OUTPUT_SENTINEL"] } }],
    ["empty object", {}],
    ["array instead of object", []],
    ["null", null],
    ["missing confidence", { layers: [], snippets: [] }],
    ["string layers", { layers: "PRIVATE_OUTPUT_SENTINEL", snippets: [], confidence: 0.5 }],
    ["non-string layer", { layers: [3], snippets: [], confidence: 0.5 }],
    ["object snippet", { layers: [], snippets: [{ text: "PRIVATE_OUTPUT_SENTINEL" }], confidence: 0.5 }],
    ["string confidence", { layers: [], snippets: [], confidence: "0.5" }],
    ["negative confidence", { layers: [], snippets: [], confidence: -1 }],
    ["confidence above one", { layers: [], snippets: [], confidence: 2 }],
    ["non-boolean abstention", { layers: [], snippets: [], confidence: 0, abstain: "yes" }],
    ["non-string reason", { layers: [], snippets: [], confidence: 0, abstain: true, reason: {} }],
  ];
  for (const [name, value] of invalid) {
    it(`records an explicit failure for ${name}, not successful empty advice`, async () => {
      const { lib } = fixture(JSON.stringify(value));
      const result = await lib.advise("inspect this migration");
      expect(typeof result.error).toBe("string");
      expect(result.error!.length).toBeGreaterThan(0);
      expect(result.error).not.toContain("PRIVATE_OUTPUT_SENTINEL");
      expect(result.layers).toEqual([]);
      expect(result.snippets).toEqual([]);
      expect(result.confidence).toBe(0);
      expect(result.abstain).not.toBe(true);
    });
  }

  it("preserves valid fenced advice and explicit abstention", async () => {
    const advice = { layers: [], snippets: [], confidence: 0, abstain: true, reason: "No relevant architecture change" };
    const { lib } = fixture(`\`\`\`json\n${JSON.stringify(advice)}\n\`\`\``);
    expect(await lib.advise("update the spelling")).toEqual(advice);
  });
});
