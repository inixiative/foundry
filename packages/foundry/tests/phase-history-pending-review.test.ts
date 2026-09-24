import { expect, test } from "bun:test";
import { abstain, domains, gate, m0Scenario, until } from "./helpers/m0-domain-loop";

test("an executing review's exact input is durable before its answer or soft deadline", async () => {
  const held = gate<string>();
  const fixture = await m0Scenario({ learning: { timeoutMs: 1000, hardTimeoutMs: 3000 }, review: () => held.promise });
  try {
    const turn = await fixture.send("a", "parent-pending-review", "Continue");
    expect(turn.status).toBe(200);
    await until(() => fixture.calls.filter(call => call.phase === "post" && call.thread === "a").length === 2, "both original reviewers executing");
    const actual = fixture.calls.filter(call => call.phase === "post" && call.thread === "a");
    expect(actual.every(call => call.response === undefined)).toBe(true);
    // Read the owning SQLite journal, not the live runtime projection or another exclusive writer.
    const history = fixture.current.localStore!.learningHistory("a", 100).map(row => row.signal.content as Record<string, any>);
    for (const domain of domains) {
      const messages = actual.find(call => call.domain === domain)!.messages;
      expect(history.some(record => record.domain === domain
        && record.evidence?.messageId === "parent-pending-review"
        && record.request?.status === "supplied"
        && JSON.stringify(record.request.messages) === JSON.stringify(messages))).toBe(true);
    }
  } finally {
    held.resolve(abstain);
    await fixture.close();
  }
});
