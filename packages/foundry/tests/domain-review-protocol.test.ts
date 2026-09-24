import { expect, test } from "bun:test";
import { ContextLayer, SignalBus, type LLMMessage, type LLMProvider } from "@inixiative/foundry-core";
import { DomainLibrarian, type ReviewInput } from "../src/agents/domain-librarian";

for (const custom of [false, true]) {
  test(`post-work response protocol survives ${custom ? "custom" : "default"} domain instructions`, async () => {
    const calls: LLMMessage[][] = [];
    const llm: LLMProvider = { id: "parent-review-contract", async complete(messages) {
      calls.push(structuredClone(messages));
      return { model: "controlled", content: JSON.stringify({ decision: "learn", knowledge: "Keep legacy writes compatible", facts: [], reason: "observed result" }) };
    } };
    const cache = new ContextLayer({ id: "architecture", segment: "domain-knowledge" });
    cache.set("DOMAIN_KNOWLEDGE: preserve existing records");
    const instructions = "DOMAIN_INSTRUCTIONS: track architecture decisions and their evidence.";
    const lib = new DomainLibrarian({ domain: "architecture", cache, signals: new SignalBus(), llm,
      ...(custom ? { reviewPrompt: instructions } : {}) });
    const evidence = { kind: "dispatch" as const, id: "completed-work", timestamp: 1 };
    lib.threadKnowledge.learn("OWN_UNDERSTANDING: legacy callers remain", evidence, "parent-fixture");
    const input: ReviewInput = { evidence, agentId: "worker", userMessage: "REQUEST: add preferred names",
      output: "RESULT: migration passed", ok: true,
      toolObservations: [{ tool: "Bash", callId: "test-call", ok: true, output: "TOOL_EVIDENCE: nine tests passed" }] };
    const result = await lib.review(input);
    expect(result.decision).toBe("learn");
    expect(calls).toHaveLength(1);
    if (custom) expect(calls[0]![0]).toEqual({ role: "system", content: instructions });
    const user = calls[0]!.filter(m => m.role === "user").map(m => m.content).join("\n");
    for (const part of ["DOMAIN_KNOWLEDGE", "OWN_UNDERSTANDING", "REQUEST", "RESULT", "TOOL_EVIDENCE"]) expect(user).toContain(part);
    // The phase owns its response contract independently of configurable domain instructions.
    for (const field of ["decision", "knowledge", "facts", "reason"]) expect(user).toContain(`"${field}"`);
    for (const decision of ["learn", "abstain"]) expect(user).toContain(`"${decision}"`);
  });
}
