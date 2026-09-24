import { expect, test } from "bun:test";
import { ContextLayer, SignalBus, type LLMMessage } from "@inixiative/foundry-core";
import { DomainLibrarian } from "../src/agents/domain-librarian";

function fixture(respond: () => string) {
  const cache = new ContextLayer({ id: "architecture", segment: "domain-knowledge" });
  cache.set("DOMAIN_KNOWLEDGE: preserve compatibility.");
  const requests: LLMMessage[][] = [];
  const lib = new DomainLibrarian({ domain: "architecture", cache, signals: new SignalBus(),
    guardTriggers: ["Write"], llm: { id: "controlled-guard", async complete(messages) {
      requests.push(structuredClone(messages));
      return { model: "controlled", content: respond() };
    } },
  });
  return { lib, requests };
}

for (const fault of ["provider refusal", "malformed JSON", "missing findings"] as const) {
  test(`guard ${fault} is distinguishable from a completed no-findings check`, async () => {
    const good = fixture(() => '{"findings":[]}');
    const bad = fixture(() => {
      if (fault === "provider refusal") throw Error("CONTROLLED_REFUSAL_WITH_NO_CHECK");
      return fault === "malformed JSON" ? "CONTROLLED_INVALID_RESPONSE" : '{"assessment":"no evidence"}';
    });
    const observation = { tool: "Write", input: { file_path: "contacts.ts" }, output: "Changed schema" };
    const completed = await good.lib.guard(observation);
    const failed = await bad.lib.guard(observation);
    expect(completed).toMatchObject({ findings: [], ran: true });
    expect(good.requests).toHaveLength(1);
    expect(bad.requests).toHaveLength(1);
    // Do not prescribe a new result shape; require the failure to remain observable.
    expect(failed).not.toEqual(completed);
  });
}

test("a domain guard receives its own learned thread understanding, not only shared state", async () => {
  const { lib, requests } = fixture(() => '{"findings":[]}');
  lib.threadKnowledge.learn("OWN_THREAD_INTERPRETATION: legacy callers use display_name.",
    { kind: "dispatch", id: "verified-work", ok: true, timestamp: 1 }, "architecture-reviewer");
  await lib.guard({ tool: "Write", input: { file_path: "contacts.ts" } }, "COMMON_EVIDENCE: the migration is being edited.");
  expect(requests).toHaveLength(1);
  const actualInput = requests[0]!.map(message => message.content).join("\n");
  expect(actualInput).toContain("DOMAIN_KNOWLEDGE");
  expect(actualInput).toContain("COMMON_EVIDENCE");
  expect(actualInput).toContain("OWN_THREAD_INTERPRETATION");
});
