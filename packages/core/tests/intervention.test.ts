import { describe, test, expect } from "bun:test";
import { InterventionLog } from "../src/intervention";
import { SignalBus, type Signal } from "../src/signal";

describe("InterventionLog", () => {
  test("records intervention and emits correction signal", async () => {
    const signals = new SignalBus();
    const emitted: Signal[] = [];
    signals.on("correction", (s) => emitted.push(s));

    const log = new InterventionLog(signals);
    const intervention = await log.intervene(
      "trace-1",
      "span-1",
      { category: "feature" },
      { category: "bug" },
      "aron",
      "was actually a bug"
    );

    expect(intervention.traceId).toBe("trace-1");
    expect(intervention.spanId).toBe("span-1");
    expect(intervention.actual).toEqual({ category: "feature" });
    expect(intervention.correction).toEqual({ category: "bug" });
    expect(intervention.operator).toBe("aron");
    expect(intervention.reason).toBe("was actually a bug");
    expect(intervention.id).toBeTruthy();
    expect(intervention.timestamp).toBeGreaterThan(0);

    // Should have emitted a correction signal
    expect(emitted.length).toBe(1);
    expect(emitted[0].kind).toBe("correction");
    expect(emitted[0].confidence).toBe(1.0);
    expect(emitted[0].source).toBe("operator:aron");
  });

  test("history returns newest first", async () => {
    const signals = new SignalBus();
    const log = new InterventionLog(signals);

    await log.intervene("t1", "s1", null, "fix-1", "op");
    await log.intervene("t2", "s2", null, "fix-2", "op");
    await log.intervene("t3", "s3", null, "fix-3", "op");

    const history = log.history;
    expect(history.length).toBe(3);
    expect(history[0].traceId).toBe("t3"); // newest first
    expect(history[2].traceId).toBe("t1");
  });

  test("forTrace filters by traceId", async () => {
    const signals = new SignalBus();
    const log = new InterventionLog(signals);

    await log.intervene("t1", "s1", null, "fix", "op");
    await log.intervene("t2", "s2", null, "fix", "op");
    await log.intervene("t1", "s3", null, "fix", "op");

    expect(log.forTrace("t1").length).toBe(2);
    expect(log.forTrace("t2").length).toBe(1);
    expect(log.forTrace("t999").length).toBe(0);
  });

  test("recentCorrections returns correction content", async () => {
    const signals = new SignalBus();
    const log = new InterventionLog(signals);

    await log.intervene("t1", "s1", "wrong", "right", "op", "reason");

    const corrections = log.recentCorrections();
    expect(corrections.length).toBe(1);
    expect(corrections[0].actual).toBe("wrong");
    expect(corrections[0].correction).toBe("right");
    expect(corrections[0].reason).toBe("reason");
  });

  test("history is bounded by maxHistory", async () => {
    const signals = new SignalBus();
    const log = new InterventionLog(signals, 3);

    for (let i = 0; i < 5; i++) {
      await log.intervene(`t${i}`, "s", null, `fix-${i}`, "op");
    }

    expect(log.history.length).toBe(3);
  });
});
