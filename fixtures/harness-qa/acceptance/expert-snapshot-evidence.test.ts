import { expect, test } from "bun:test";
import { m0Scenario } from "../../../packages/foundry/tests/helpers/m0-domain-loop";
import { domainUnderstanding, knowledgeInspectionSummary } from "../../../packages/foundry/src/viewer/ui/inspector-data.js";

test("current expert evidence survives a bounded history window after real commit and abstention", async () => {
  const scenario = await m0Scenario();
  try {
    expect((await scenario.send("a", "evidence-origin", "Perform the migration")).status).toBe(200);
    await scenario.settled("a");
    expect((await scenario.send("a", "later-abstention")).status).toBe(200);
    await scenario.settled("a");
    const response = await scenario.current.app.request("/api/threads/a/knowledge?limit=1");
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.history).toHaveLength(1);
    expect(payload.history[0].signal.content.decision).toBe("abstain");
    const snapshot = payload.snapshot.domains.architecture;
    expect(snapshot.revision).toBe(1);
    expect(snapshot.evidence.length).toBeGreaterThan(0);
    expect(snapshot.evidence.some((e: { messageId?: string }) => e.messageId === "evidence-origin")).toBe(true);

    const summary = knowledgeInspectionSummary(payload);
    const understanding = domainUnderstanding(summary, summary.history, "architecture");
    expect(understanding.state).toBe("committed");
    expect(understanding.revision).toBe(1);
    // The recent outcome window need not contain the event that produced the snapshot.
    expect(understanding.latestLearned).toBeNull();
    const committed = summary.domains.find(domain => domain.domain === "architecture")!.committed;
    expect(committed).toHaveProperty("evidence", snapshot.evidence);
  } finally {
    await scenario.close();
  }
});
