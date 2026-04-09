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
  type VisibilityTier,
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
    herald = new Herald(session, { canInject: false });

    herald.start();

    // Emit a trigger signal — should set dirty
    await t1.signals.emit({
      id: "lifecycle-sig",
      kind: "classification",
      source: "test",
      content: null,
      timestamp: Date.now(),
    });
    expect(herald.isDirty).toBe(true);

    // Explicit observe clears dirty
    await herald.observe();
    expect(herald.isDirty).toBe(false);

    herald.stop();

    // After stop, signals should not set dirty
    await t1.signals.emit({
      id: "lifecycle-sig-2",
      kind: "classification",
      source: "test",
      content: null,
      timestamp: Date.now(),
    });
    expect(herald.isDirty).toBe(false);
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

  // =========================================================================
  // Information Visibility Tiers
  // =========================================================================

  describe("visibility tiers", () => {
    // -- 18. setVisibility and getVisibility --
    test("setVisibility and getVisibility round-trip", () => {
      const session = makeSession(makeThread("t1"));
      herald = new Herald(session);

      herald.setVisibility("my-prefs", "personal-private", "user-1");
      herald.setVisibility("my-role", "personal-public", "user-1");
      herald.setVisibility("team-conventions", "team");
      herald.setVisibility("org-security", "org");

      expect(herald.getVisibility("my-prefs").tier).toBe("personal-private");
      expect(herald.getVisibility("my-prefs").ownerId).toBe("user-1");
      expect(herald.getVisibility("my-role").tier).toBe("personal-public");
      expect(herald.getVisibility("team-conventions").tier).toBe("team");
      expect(herald.getVisibility("org-security").tier).toBe("org");
    });

    // -- 19. unregistered layers default to "team" --
    test("unregistered layers default to team tier", () => {
      const session = makeSession(makeThread("t1"));
      herald = new Herald(session);

      expect(herald.getVisibility("unknown-layer").tier).toBe("team");
    });

    // -- 20. personal-private requester sees everything --
    test("personal-private requester sees own private + all higher tiers", () => {
      const session = makeSession(makeThread("t1"));
      herald = new Herald(session, {
        visibility: [
          { layerId: "my-prefs", tier: "personal-private", ownerId: "user-1" },
          { layerId: "other-prefs", tier: "personal-private", ownerId: "user-2" },
          { layerId: "my-role", tier: "personal-public", ownerId: "user-1" },
          { layerId: "team-conv", tier: "team" },
          { layerId: "org-sec", tier: "org" },
        ],
      });

      const all = ["my-prefs", "other-prefs", "my-role", "team-conv", "org-sec"];
      const visible = herald.filterByVisibility(all, "personal-private", "user-1");

      expect(visible).toContain("my-prefs");       // own private
      expect(visible).not.toContain("other-prefs"); // someone else's private
      expect(visible).toContain("my-role");          // personal-public
      expect(visible).toContain("team-conv");        // team
      expect(visible).toContain("org-sec");          // org
    });

    // -- 21. personal-public requester cannot see personal-private --
    test("personal-public requester cannot see personal-private", () => {
      const session = makeSession(makeThread("t1"));
      herald = new Herald(session, {
        visibility: [
          { layerId: "prefs", tier: "personal-private", ownerId: "user-1" },
          { layerId: "role", tier: "personal-public", ownerId: "user-1" },
          { layerId: "team", tier: "team" },
          { layerId: "org", tier: "org" },
        ],
      });

      const all = ["prefs", "role", "team", "org"];
      const visible = herald.filterByVisibility(all, "personal-public", "user-1");

      expect(visible).not.toContain("prefs");
      expect(visible).toContain("role");
      expect(visible).toContain("team");
      expect(visible).toContain("org");
    });

    // -- 22. team requester sees public + team + org --
    test("team requester sees personal-public + team + org but not private", () => {
      const session = makeSession(makeThread("t1"));
      herald = new Herald(session, {
        visibility: [
          { layerId: "priv", tier: "personal-private", ownerId: "user-1" },
          { layerId: "pub", tier: "personal-public", ownerId: "user-1" },
          { layerId: "team", tier: "team" },
          { layerId: "org", tier: "org" },
        ],
      });

      const all = ["priv", "pub", "team", "org"];
      const visible = herald.filterByVisibility(all, "team");

      expect(visible).not.toContain("priv");
      expect(visible).toContain("pub");
      expect(visible).toContain("team");
      expect(visible).toContain("org");
    });

    // -- 23. org requester sees only org --
    test("org requester sees only org-level layers", () => {
      const session = makeSession(makeThread("t1"));
      herald = new Herald(session, {
        visibility: [
          { layerId: "priv", tier: "personal-private", ownerId: "user-1" },
          { layerId: "pub", tier: "personal-public", ownerId: "user-1" },
          { layerId: "team", tier: "team" },
          { layerId: "org", tier: "org" },
        ],
      });

      const all = ["priv", "pub", "team", "org"];
      const visible = herald.filterByVisibility(all, "org");

      expect(visible).toEqual(["org"]);
    });

    // -- 24. constructor accepts initial visibility config --
    test("constructor accepts initial visibility via config", () => {
      const session = makeSession(makeThread("t1"));
      herald = new Herald(session, {
        visibility: [
          { layerId: "layer-a", tier: "team" },
          { layerId: "layer-b", tier: "org" },
        ],
      });

      expect(herald.getVisibility("layer-a").tier).toBe("team");
      expect(herald.getVisibility("layer-b").tier).toBe("org");
    });
  });

  // =========================================================================
  // Event-Driven Mode
  // =========================================================================

  describe("event-driven mode", () => {
    // -- 25. isDirty starts false --
    test("isDirty starts false", () => {
      const session = makeSession(makeThread("t1"));
      herald = new Herald(session, { canInject: false });
      expect(herald.isDirty).toBe(false);
    });

    // -- 26. signal on a subscribed thread sets isDirty --
    test("signal on subscribed thread sets isDirty", async () => {
      const t1 = makeThread("t1");
      const session = makeSession(t1);
      herald = new Herald(session, { canInject: false });
      herald.start();

      expect(herald.isDirty).toBe(false);

      // Emit a trigger signal on the thread
      await t1.signals.emit({
        id: "test-sig-1",
        kind: "classification",
        source: "test",
        content: { result: "auth" },
        timestamp: Date.now(),
      });

      expect(herald.isDirty).toBe(true);
    });

    // -- 27. non-trigger signal does NOT set isDirty --
    test("non-trigger signal does not set isDirty", async () => {
      const t1 = makeThread("t1");
      const session = makeSession(t1);
      herald = new Herald(session, { canInject: false });
      herald.start();

      // Emit a signal kind NOT in the default triggerSignals set
      await t1.signals.emit({
        id: "test-sig-2",
        kind: "custom_irrelevant" as any,
        source: "test",
        content: null,
        timestamp: Date.now(),
      });

      expect(herald.isDirty).toBe(false);
    });

    // -- 28. custom triggerSignals config is respected --
    test("custom triggerSignals config is respected", async () => {
      const t1 = makeThread("t1");
      const session = makeSession(t1);
      herald = new Herald(session, {
        canInject: false,
        triggerSignals: ["my_custom_signal"],
      });
      herald.start();

      // Default trigger should NOT fire
      await t1.signals.emit({
        id: "test-sig-3",
        kind: "classification",
        source: "test",
        content: null,
        timestamp: Date.now(),
      });
      expect(herald.isDirty).toBe(false);

      // Custom trigger SHOULD fire
      await t1.signals.emit({
        id: "test-sig-4",
        kind: "my_custom_signal" as any,
        source: "test",
        content: null,
        timestamp: Date.now(),
      });
      expect(herald.isDirty).toBe(true);
    });

    // -- 29. stop() unsubscribes from signals --
    test("stop unsubscribes from thread signals", async () => {
      const t1 = makeThread("t1");
      const session = makeSession(t1);
      herald = new Herald(session, { canInject: false });
      herald.start();
      herald.stop();

      await t1.signals.emit({
        id: "test-sig-5",
        kind: "classification",
        source: "test",
        content: null,
        timestamp: Date.now(),
      });

      // Should still be clean since we stopped
      expect(herald.isDirty).toBe(false);
    });

    // -- 30. new threads added after start() get subscribed --
    test("new threads added after start get subscribed", async () => {
      const t1 = makeThread("t1");
      const session = makeSession(t1);
      herald = new Herald(session, { canInject: false });
      herald.start();

      // Add a new thread after start
      const t2 = makeThread("t2");
      session.add(t2);

      // Signal on the new thread should trigger dirty
      await t2.signals.emit({
        id: "test-sig-6",
        kind: "dispatch",
        source: "test",
        content: null,
        timestamp: Date.now(),
      });

      expect(herald.isDirty).toBe(true);
    });
  });

  // =========================================================================
  // Summary Layer
  // =========================================================================

  describe("summary layer", () => {
    // -- 31. summaryLayer exists and has content --
    test("summaryLayer exists and has initial content", () => {
      const t1 = makeThread("t1");
      const session = makeSession(t1);
      herald = new Herald(session);

      expect(herald.summaryLayer).toBeDefined();
      expect(herald.summaryLayer.id).toBe("__herald-summary");
      expect(herald.summaryLayer.content).toBeTruthy();
    });

    // -- 32. single thread shows "Single thread active" --
    test("single thread shows single-thread message", () => {
      const t1 = makeThread("t1");
      const session = makeSession(t1);
      herald = new Herald(session);

      expect(herald.summaryLayer.content).toContain("Single thread active");
    });

    // -- 33. multiple threads shows thread list --
    test("multiple threads shows thread list in summary", () => {
      const t1 = makeThread("t1", { description: "fix auth bug" });
      const t2 = makeThread("t2", { description: "write tests" });
      const session = makeSession(t1, t2);
      herald = new Herald(session);

      const content = herald.summaryLayer.content;
      expect(content).toContain("Active threads: 2");
      expect(content).toContain("t1");
      expect(content).toContain("fix auth bug");
      expect(content).toContain("t2");
      expect(content).toContain("write tests");
    });

    // -- 34. summary updates after observe() detects patterns --
    test("summary updates after observe detects patterns", async () => {
      const t1 = makeThread("t1");
      const t2 = makeThread("t2");
      const session = makeSession(t1, t2);
      herald = new Herald(session, { canInject: false });

      // Trigger a duplication pattern
      await t1.dispatch("worker", "task");
      await t2.dispatch("worker", "task");
      await herald.observe();

      const content = herald.summaryLayer.content;
      expect(content).toContain("Recent cross-thread patterns:");
    });

    // -- 35. summary layer has correct trust --
    test("summary layer has trust 0.8", () => {
      const session = makeSession(makeThread("t1"));
      herald = new Herald(session);

      expect(herald.summaryLayer.trust).toBe(0.8);
    });
  });
});
