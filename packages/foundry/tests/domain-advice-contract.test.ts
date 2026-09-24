import { expect, test } from "bun:test";
import { ContextLayer, SignalBus, type LLMMessage, type LLMProvider } from "@inixiative/foundry-core";
import { ADVICE_RESPONSE_PROTOCOL, DomainLibrarian, validateAdviceResponse } from "../src/agents/domain-librarian";

// Author cases for the advice-phase response contract (Fable). Controlled provider only; no model.
// The parent's protected protocol fixture covers the invalid-shape matrix; these cover the boundary
// choice: instructions stay verbatim and inspectable, the protocol travels as a phase message, the
// composition's broad instructions work unchanged, and error text never carries response content.

const BROAD_INSTRUCTIONS = "You are the architecture expert. Maintain your own evidence-grounded interpretation of this thread's design decisions, constraints and tradeoffs. Do not treat another expert's opinion as your memory.";
/** `advisePrompt: null` requests the librarian's built-in default instructions. */
function fixture(respond: (messages: LLMMessage[]) => Promise<{ content: string }> | { content: string }, advisePrompt: string | null = BROAD_INSTRUCTIONS) {
  const calls: LLMMessage[][] = [];
  const llm: LLMProvider = { id: "controlled-advice", async complete(messages) { calls.push(structuredClone(messages)); return { model: "controlled", ...(await respond(messages)) }; } };
  const cache = new ContextLayer({ id: "architecture", segment: "domain-knowledge" }); cache.set("Assess compatibility using observed evidence.");
  const lib = new DomainLibrarian({ domain: "architecture", cache, signals: new SignalBus(), llm, ...(advisePrompt !== null ? { advisePrompt } : {}) });
  return { lib, calls };
}

test("composition-style broad instructions stay verbatim as the system message; the protocol is a separate phase block in the request", async () => {
  const { lib, calls } = fixture(() => ({ content: '{"layers":["architecture"],"snippets":[],"confidence":0.7,"domain":"architecture"}' }));
  const result = await lib.advise("Add preferred names", "shared thread state");
  expect(result).toEqual({ layers: ["architecture"], snippets: [], confidence: 0.7 }); // unknown extra keys are tolerated; the schema fields are what count
  expect(lib.advisePrompt).toBe(BROAD_INSTRUCTIONS); // stored instructions untouched: inspectable provenance
  expect(calls[0]![0]).toEqual({ role: "system", content: BROAD_INSTRUCTIONS });
  expect(calls[0]![1]!.role).toBe("user"); expect(calls[0]![1]!.content).toContain(ADVICE_RESPONSE_PROTOCOL);
  expect(calls[0]![1]!.content).toContain("## Message\nAdd preferred names"); expect(calls[0]![1]!.content).toContain("## Thread state\nshared thread state");
  expect(calls[0]![1]!.content).not.toContain("Respond with JSON only.\n"); // the old bare instruction is replaced by the full protocol block
});

test("the default instructions also receive the phase protocol; the default advisePrompt text itself is unchanged", async () => {
  const { lib, calls } = fixture(() => ({ content: '{"layers":[],"snippets":["x"],"confidence":1}' }), null);
  expect(lib.advisePrompt).toContain("You are a architecture domain advisor");
  expect(await lib.advise("m")).toEqual({ layers: [], snippets: ["x"], confidence: 1 });
  expect(calls[0]!.map(m => m.content).join("\n")).toContain(ADVICE_RESPONSE_PROTOCOL);
});

test("protocol errors are explicit, bounded and never echo response content; provider failures keep their own message", async () => {
  const secret = "PRIVATE_OUTPUT_SENTINEL";
  for (const bad of [`{"domain":"architecture","assessment":"${secret}"}`, `not json at all ${secret}`, `{"layers":["${secret}"],"snippets":[],"confidence":1.5}`, "x".repeat(20_001)]) {
    const { lib } = fixture(() => ({ content: bad }));
    const result = await lib.advise("m");
    expect(result).toMatchObject({ layers: [], snippets: [], confidence: 0 }); expect(result.abstain).toBeUndefined();
    expect(typeof result.error).toBe("string"); expect(result.error!.length).toBeLessThan(200); expect(result.error).not.toContain(secret);
  }
  const failing = fixture(() => { throw Error("CONTROLLED_PROVIDER_FAILURE"); });
  expect((await failing.lib.advise("m")).error).toBe("CONTROLLED_PROVIDER_FAILURE"); // existing propagation of the model call's failure
});

test("valid forms: fenced JSON, confidence at both bounds, explicit abstention with reason, abstention defaulting its reason", async () => {
  expect(validateAdviceResponse('```json\n{"layers":[],"snippets":[],"confidence":0}\n```')).toEqual({ layers: [], snippets: [], confidence: 0 });
  expect(validateAdviceResponse('{"layers":["a"],"snippets":["b"],"confidence":1}')).toEqual({ layers: ["a"], snippets: ["b"], confidence: 1 });
  expect(validateAdviceResponse('{"layers":[],"snippets":[],"confidence":0,"abstain":true,"reason":"nothing relevant"}')).toEqual({ layers: [], snippets: [], confidence: 0, abstain: true, reason: "nothing relevant" });
  expect(validateAdviceResponse('{"layers":[],"snippets":[],"confidence":0,"abstain":true}')).toEqual({ layers: [], snippets: [], confidence: 0, abstain: true, reason: "declined" });
  expect(validateAdviceResponse('{"layers":[],"snippets":[],"confidence":0.4,"abstain":false,"reason":"ignored when not abstaining"}')).toEqual({ layers: [], snippets: [], confidence: 0.4 });
  expect(validateAdviceResponse('{"layers":[],"snippets":[],"confidence":"0.5"}')).toEqual({ error: 'advice response requires "confidence": finite number from 0 to 1' });
  expect(validateAdviceResponse(42 as unknown as string)).toEqual({ error: "advice response is not text" });
});

test("a cold cache still abstains explicitly before any model call", async () => {
  const calls: LLMMessage[][] = [];
  const llm: LLMProvider = { id: "controlled-advice", async complete(messages) { calls.push(messages); return { model: "controlled", content: "{}" }; } };
  const lib = new DomainLibrarian({ domain: "architecture", cache: new ContextLayer({ id: "architecture", segment: "domain-knowledge" }), signals: new SignalBus(), llm, advisePrompt: BROAD_INSTRUCTIONS });
  expect(await lib.advise("m")).toEqual({ layers: [], snippets: [], confidence: 0, abstain: true, reason: "cold-cache" }); expect(calls).toHaveLength(0);
});
