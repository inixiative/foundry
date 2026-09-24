import { expect, test } from "bun:test";
import { ContextLayer, SignalBus, type LLMMessage } from "../../../packages/core/src/index";
import { DomainLibrarian, type ReviewInput } from "../../../packages/foundry/src/agents/domain-librarian";

const input: ReviewInput = { evidence: { kind: "dispatch", id: "controlled-evidence", timestamp: 1 },
  agentId: "worker", messageId: "controlled-message", userMessage: "Complete the migration", output: "Completed", ok: true, toolObservations: [] };

function fixture(response = JSON.stringify({ decision: "abstain", reason: "Nothing new" })) {
  const calls: LLMMessage[][] = [];
  const cache = new ContextLayer({ id: "conventions", prompt: "Configured domain instructions" });
  cache.set("DOMAIN_POLICY: migration order C before B");
  const lib = new DomainLibrarian({ domain: "conventions", cache, signals: new SignalBus(),
    reviewPrompt: "REVIEW_INSTRUCTIONS: maintain the owned migration convention", llm: {
      id: "controlled", async complete(messages) { calls.push(structuredClone(messages)); return { model: "controlled", content: response }; },
    },
  });
  return { lib, calls };
}

test("replacement review receives the complete committed knowledge including its valid tail", async () => {
  const f = fixture();
  const knowledge = "x".repeat(3100) + "\nCRITICAL_EXISTING_TAIL: never remove the rollback checkpoint";
  f.lib.threadKnowledge.learn(knowledge, input.evidence, "controlled-prior-review");
  const before = f.lib.threadKnowledge.snapshot();
  await f.lib.review(input);
  expect(f.calls.flat().map(m => m.content).join("\n")).toContain(knowledge);
  expect(f.lib.threadKnowledge.snapshot()).toEqual(before);
});

test("review receives explicit instructions and configured domain knowledge without assuming native retention", async () => {
  const f = fixture();
  await f.lib.review(input);
  const sent = f.calls.flat().map(m => m.content).join("\n");
  expect(sent).toContain("REVIEW_INSTRUCTIONS: maintain the owned migration convention");
  expect(sent).toContain("DOMAIN_POLICY: migration order C before B");
});

test("non-object and malformed reviewer JSON has a structured invalid outcome, never an escaped exception", async () => {
  for (const response of ["null", "[]", "true", "42", '"text"', "not JSON"]) {
    const f = fixture(response);
    const result = await f.lib.review(input);
    expect(result.decision).toBe("invalid");
    expect(f.lib.threadKnowledge.revision).toBe(0);
    expect(f.lib.threadKnowledge.content).toBe("");
  }
});

test("valid knowledge is proposed without publication and oversized knowledge is not clipped into validity", async () => {
  const valid = fixture(JSON.stringify({ decision: "learn", knowledge: "VALID_NEW_FACT", facts: ["VALID_NEW_FACT"] }));
  expect(await valid.lib.review(input)).toMatchObject({ decision: "learn", knowledge: "VALID_NEW_FACT" });
  expect(valid.lib.threadKnowledge.revision).toBe(0);
  const oversized = fixture(JSON.stringify({ decision: "learn", knowledge: "x".repeat(4001), facts: [] }));
  expect((await oversized.lib.review(input)).decision).toBe("invalid");
  expect(oversized.lib.threadKnowledge.revision).toBe(0);
});
