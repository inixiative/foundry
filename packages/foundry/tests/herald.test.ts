import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  ContextLayer,
  type ContextSource,
  ContextStack,
  Thread,
  Executor,
} from "@inixiative/foundry-core";
import { SessionManager } from "../src/agents/session";
import {
  Herald,
  DuplicationDetector,
  ContradictionDetector,
  ConvergenceDetector,
  CrossPollinationDetector,
  ResourceImbalanceDetector,
  type ThreadSnapshot,
  type HeraldPattern,
  type PatternDetector,
} from "../src/agents/herald";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function source(id: string, content: string): ContextSource {
  return { id, load: async () => content };
}

function makeThread(
  id: string,
  opts?: {
    description?: string;
    tags?: string[];
    layerIds?: string[];
    layerContent?: string;
  }
): Thread {
  const layerContent = opts?.layerContent ?? `context-${id}`;
  const layerIds = opts?.layerIds ?? ["docs"];
  const layers = layerIds.map((lid) => {
    const layer = new ContextLayer({
      id: lid,
      trust: 10,
      sources: [source(lid, layerContent)],
    });
    layer.set(layerContent);
    return layer;
  });
  const stack = new ContextStack(layers);
  const thread = new Thread(id, stack, {
    description: opts?.description ?? "",
    tags: opts?.tags ?? [],
  });
  thread.register(
    new Executor({
      id: "worker",
      stack,
      handler: async (_ctx, payload) => `${id}: ${payload}`,
    })
  );
  return thread;
}

function makeSession(...threads: Thread[]): SessionManager {
  const sm = new SessionManager();
  for (const t of threads) sm.add(t);
  return sm;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Herald", () => {
  let herald: Herald;

  afterEach(() => {
    herald?.stop();
  });

  // -- 1. Snapshot captures thread state correctly --
  test("snapshot captures thread state correctly", async () => {
    const thread = makeThread("t1", {
      description: "test thread",
      tags: ["auth", "api"],
      layerIds: ["docs", "rules"],
    });
    const session = makeSession(thread);
    herald = new Herald(session);

    // Dispatch to create some history
    await thread.dispatch("worker", "hello");

    const snap = herald.snapshot(thread);

    expect(snap.threadId).toBe("t1");
    expect(snap.status).toBe("idle");
    expect(snap.description).toBe("test thread");
    expect(snap.tags).toEqual(["auth", "api"]);
    expect(snap.agents).toContain("worker");
    expect(snap.layerIds).toEqual(["docs", "rules"]);
    expect(snap.contextHash).toBeTruthy();
    expect(snap.recentDispatches.length).toBe(1);
    expect(snap.recentDispatches[0].agentId).toBe("worker");
    expect(snap.timestamp).toBeGreaterThan(0);
  });

  // -- 2. SnapshotAll captures all threads --
  test("snapshotAll captures all active threads", () => {
    const t1 = makeThread("t1");
    const t2 = makeThread("t2");
    const t3 = makeThread("t3");
    t3.archive(); // archived threads should not appear
    const session = makeSession(t1, t2, t3);
    herald = new Herald(session);

    const snaps = herald.snapshotAll();
    expect(snaps.length).toBe(2);
    expect(snaps.map((s) => s.threadId).sort()).toEqual(["t1", "t2"]);
  });

  // -- 3. DuplicationDetector — detects same agent dispatched in two threads --
  test("DuplicationDetector detects same agent dispatched in two threads", async () => {
    const t1 = makeThread("t1");
    const t2 = makeThread("t2");
    const session = makeSession(t1, t2);
    herald = new Herald(session);

    // Dispatch same agent in both threads
    await t1.dispatch("worker", "task1");
    await t2.dispatch("worker", "task2");

    const snaps = herald.snapshotAll();
    const detector = new DuplicationDetector();
    const patterns = detector.detect(snaps, []);

    const dupPatterns = patterns.filter((p) => p.kind === "duplication");
    expect(dupPatterns.length).toBeGreaterThanOrEqual(1);

    // Should flag that "worker" is dispatched from both threads
    const agentDup = dupPatterns.find((p) =>
      p.description.includes("worker")
    );
    expect(agentDup).toBeTruthy();
    expect(agentDup!.threads).toContain("t1");
    expect(agentDup!.threads).toContain("t2");
  });

  // -- 4. ContradictionDetector — detects conflicting signals --
  test("ContradictionDetector detects conflicting signals", async () => {
    const t1 = makeThread("t1");
    const t2 = makeThread("t2");
    const session = makeSession(t1, t2);
    herald = new Herald(session);

    // t2 dispatches "worker"
    await t2.dispatch("worker", "original");

    // t1 emits a correction signal from "worker"
    await t1.signals.emit({
      id: "sig1",
      kind: "correction",
      source: "worker",
      content: { fix: "use different approach" },
      timestamp: Date.now(),
    });

    const snaps = herald.snapshotAll();
    const detector = new ContradictionDetector();
    const patterns = detector.detect(snaps, []);

    expect(patterns.length).toBeGreaterThanOrEqual(1);
    expect(patterns[0].kind).toBe("contradiction");
    expect(patterns[0].threads).toContain("t1");
    expect(patterns[0].threads).toContain("t2");
  });

  // -- 5. ConvergenceDetector — detects overlapping context --
  test("ConvergenceDetector detects overlapping context layers", () => {
    // 3 threads sharing the same layer
    const t1 = makeThread("t1", { layerIds: ["shared", "a"] });
    const t2 = makeThread("t2", { layerIds: ["shared", "b"] });
    const t3 = makeThread("t3", { layerIds: ["shared", "c"] });
    const session = makeSession(t1, t2, t3);
    herald = new Herald(session);

    const snaps = herald.snapshotAll();
    const detector = new ConvergenceDetector();
    const patterns = detector.detect(snaps, []);

    const convPatterns = patterns.filter((p) => p.kind === "convergence");
    expect(convPatterns.length).toBeGreaterThanOrEqual(1);
    expect(convPatterns[0].threads.length).toBeGreaterThanOrEqual(3);
  });

  // -- 6. CrossPollinationDetector — detects relevant signals for other threads --
  test("CrossPollinationDetector detects relevant signals for other threads", async () => {
    const t1 = makeThread("t1", { tags: ["security"] });
    const t2 = makeThread("t2", { tags: ["api"] });
    const session = makeSession(t1, t2);
    herald = new Herald(session);

    // t2 emits a "security" signal which matches t1's tags
    await t2.signals.emit({
      id: "sig2",
      kind: "security",
      source: "scanner",
      content: { finding: "vulnerability detected" },
      timestamp: Date.now(),
    });

    const snaps = herald.snapshotAll();
    const detector = new CrossPollinationDetector();
    const patterns = detector.detect(snaps, []);

    expect(patterns.length).toBeGreaterThanOrEqual(1);
    expect(patterns[0].kind).toBe("cross_pollination");
    // Source is t2, target is t1
    expect(patterns[0].threads).toContain("t1");
    expect(patterns[0].threads).toContain("t2");
  });

  // -- 7. ResourceImbalanceDetector — detects overloaded thread --
  test("ResourceImbalanceDetector detects overloaded thread", async () => {
    const t1 = makeThread("t1");
    const t2 = makeThread("t2");
    const t3 = makeThread("t3");
    const session = makeSession(t1, t2, t3);
    herald = new Herald(session);

    // t1 gets many dispatches, t2/t3 get none
    for (let i = 0; i < 6; i++) {
      await t1.dispatch("worker", `task${i}`);
    }

    const snaps = herald.snapshotAll();
    const detector = new ResourceImbalanceDetector();
    const patterns = detector.detect(snaps, []);

    const imbalance = patterns.filter((p) => p.kind === "resource_imbalance");
    expect(imbalance.length).toBeGreaterThanOrEqual(1);
    expect(imbalance[0].threads).toContain("t1");
  });

  // -- 8. observe() runs all detectors and returns patterns --
  test("observe() runs all detectors and returns patterns", async () => {
    const t1 = makeThread("t1");
    const t2 = makeThread("t2");
    const session = makeSession(t1, t2);
    herald = new Herald(session, { canInject: false });

    // Create a scenario that triggers duplication
    await t1.dispatch("worker", "task");
    await t2.dispatch("worker", "task");

    const patterns = await herald.observe();
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    // Patterns should be stored
    expect(herald.patterns.length).toBeGreaterThanOrEqual(1);
  });

  // -- 9. Pattern deduplication within time window --
  test("pattern deduplication within time window", async () => {
    const t1 = makeThread("t1");
    const t2 = makeThread("t2");
    const session = makeSession(t1, t2);
    herald = new Herald(session, { canInject: false });

    await t1.dispatch("worker", "task1");
    await t2.dispatch("worker", "task2");

    // First observe should return patterns
    const first = await herald.observe();
    const dupCount = first.filter((p) => p.kind === "duplication").length;
    expect(dupCount).toBeGreaterThanOrEqual(1);

    // Second observe should deduplicate the same patterns
    const second = await herald.observe();
    const dupCount2 = second.filter((p) => p.kind === "duplication").length;
    expect(dupCount2).toBe(0);
  });

  // -- 10. Herald.inject() pushes signal into target thread --
  test("inject() pushes signal into target thread", async () => {
    const t1 = makeThread("t1");
    const session = makeSession(t1);
    herald = new Herald(session);

    const pattern: HeraldPattern = {
      id: "test_pattern",
      kind: "duplication",
      severity: "warning",
      threads: ["t1"],
      description: "test",
      recommendation: "pause it",
      evidence: {},
      timestamp: Date.now(),
    };

    const signals: any[] = [];
    t1.signals.on("herald", (s) => {
      signals.push(s);
    });

    herald.inject({
      targetThreadId: "t1",
      pattern,
      action: "pause",
    });

    // Signal bus emit is async, wait a tick
    await new Promise((r) => setTimeout(r, 10));

    expect(signals.length).toBe(1);
    expect(signals[0].kind).toBe("herald");
    expect(signals[0].source).toBe("herald");
    expect(signals[0].content.action).toBe("pause");
  });

  // -- 11. onPattern callback fires --
  test("onPattern callback fires when patterns detected", async () => {
    const t1 = makeThread("t1");
    const t2 = makeThread("t2");
    const session = makeSession(t1, t2);
    herald = new Herald(session, { canInject: false });

    await t1.dispatch("worker", "task");
    await t2.dispatch("worker", "task");

    const received: HeraldPattern[] = [];
    const unsub = herald.onPattern((p) => received.push(p));

    await herald.observe();

    expect(received.length).toBeGreaterThanOrEqual(1);

    // Unsubscribe and verify no more callbacks
    unsub();
    const countBefore = received.length;

    // Need to create new dispatches to avoid dedup
    await t1.dispatch("worker", "new-task");

    // Force new patterns by adding a custom detector that always fires
    herald.addDetector({
      id: "always-fire",
      kind: "duplication",
      detect: () => [
        {
          id: `test_${Date.now()}`,
          kind: "duplication",
          severity: "warning",
          threads: ["unique-thread-set"],
          description: "always fires",
          recommendation: "test",
          evidence: {},
          timestamp: Date.now(),
        },
      ],
    });

    await herald.observe();
    // After unsubscribe, no new patterns should be received
    expect(received.length).toBe(countBefore);
  });

  // -- 12. start/stop lifecycle --
  test("start/stop lifecycle", async () => {
    const t1 = makeThread("t1");
    const session = makeSession(t1);
    herald = new Herald(session, {
      snapshotInterval: 50,
      canInject: false,
    });

    const patterns: HeraldPattern[] = [];
    herald.onPattern((p) => patterns.push(p));

    // Use a custom detector that always fires unique patterns
    let callCount = 0;
    herald.addDetector({
      id: "counter",
      kind: "convergence",
      detect: () => {
        callCount++;
        return [
          {
            id: `lifecycle_${callCount}_${Date.now()}`,
            kind: "convergence",
            severity: "warning",
            threads: [`unique_${callCount}`],
            description: `call ${callCount}`,
            recommendation: "test",
            evidence: {},
            timestamp: Date.now(),
          },
        ];
      },
    });

    herald.start();
    // Wait for at least 2 intervals
    await new Promise((r) => setTimeout(r, 150));
    herald.stop();

    const countAfterStop = callCount;
    expect(countAfterStop).toBeGreaterThanOrEqual(2);

    // After stop, no more calls
    await new Promise((r) => setTimeout(r, 100));
    expect(callCount).toBe(countAfterStop);
  });

  // -- 13. canInject=false prevents injection --
  test("canInject=false prevents injection", async () => {
    const t1 = makeThread("t1");
    const t2 = makeThread("t2");
    const session = makeSession(t1, t2);
    herald = new Herald(session, { canInject: false });

    const signals: any[] = [];
    t1.signals.onAny((s) => signals.push(s));
    t2.signals.onAny((s) => signals.push(s));

    // Trigger patterns that would normally generate recommendations + injections
    await t1.dispatch("worker", "task");
    await t2.dispatch("worker", "task");
    await herald.observe();

    // No herald signals should have been injected
    const heraldSignals = signals.filter((s) => s.kind === "herald");
    expect(heraldSignals.length).toBe(0);
  });

  // -- 14. addDetector / removeDetector --
  test("addDetector and removeDetector", async () => {
    const t1 = makeThread("t1");
    const session = makeSession(t1);
    herald = new Herald(session, { canInject: false });

    let detected = false;
    const custom: PatternDetector = {
      id: "custom:test",
      kind: "convergence",
      detect: () => {
        detected = true;
        return [];
      },
    };

    herald.addDetector(custom);
    await herald.observe();
    expect(detected).toBe(true);

    detected = false;
    const removed = herald.removeDetector("custom:test");
    expect(removed).toBe(true);

    await herald.observe();
    // Custom detector should not have run after removal
    expect(detected).toBe(false);

    // Removing non-existent returns false
    expect(herald.removeDetector("nonexistent")).toBe(false);
  });

  // -- 15. DuplicationDetector detects matching contextHashes --
  test("DuplicationDetector detects matching contextHashes", () => {
    const detector = new DuplicationDetector();
    const now = Date.now();

    const snaps: ThreadSnapshot[] = [
      {
        threadId: "t1",
        timestamp: now,
        status: "idle",
        description: "thread 1",
        tags: [],
        agents: ["worker"],
        layerIds: ["docs"],
        contextHash: "abc123",
        recentDispatches: [],
        recentSignals: [],
      },
      {
        threadId: "t2",
        timestamp: now,
        status: "idle",
        description: "thread 2",
        tags: [],
        agents: ["worker"],
        layerIds: ["docs"],
        contextHash: "abc123",
        recentDispatches: [],
        recentSignals: [],
      },
    ];

    const patterns = detector.detect(snaps, []);
    const hashDup = patterns.find(
      (p) => p.description.includes("identical context")
    );
    expect(hashDup).toBeTruthy();
    expect(hashDup!.threads).toEqual(["t1", "t2"]);
  });

  // -- 16. Recommendations generated for warning/critical patterns --
  test("recommendations generated for warning/critical patterns", async () => {
    const t1 = makeThread("t1");
    const t2 = makeThread("t2");
    const session = makeSession(t1, t2);
    herald = new Herald(session, { canInject: false });

    // Dispatch same agent to trigger duplication (warning severity)
    await t1.dispatch("worker", "task");
    await t2.dispatch("worker", "task");

    await herald.observe();

    // Should have recommendations
    expect(herald.recommendations.length).toBeGreaterThanOrEqual(1);
    expect(herald.recommendations[0].action).toBe("pause");
  });

  // -- 17. onRecommendation callback fires --
  test("onRecommendation callback fires", async () => {
    const t1 = makeThread("t1");
    const t2 = makeThread("t2");
    const session = makeSession(t1, t2);
    herald = new Herald(session, { canInject: false });

    await t1.dispatch("worker", "task");
    await t2.dispatch("worker", "task");

    const recs: any[] = [];
    const unsub = herald.onRecommendation((r) => recs.push(r));

    await herald.observe();
    expect(recs.length).toBeGreaterThanOrEqual(1);

    unsub();
  });
});
