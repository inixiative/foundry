import { describe, test, expect } from "bun:test";
import {
  ContextLayer,
  type ContextSource,
  ContextStack,
  Thread,
  Executor,
  SignalBus,
  type Signal,
} from "@inixiative/foundry-core";
import { SessionManager, type ThreadBlueprint } from "../src/agents/session";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function source(id: string, content: string): ContextSource {
  return { id, load: async () => content };
}

function makeStack(content: string = "test context"): ContextStack {
  const layer = new ContextLayer({
    id: "docs",
    trust: 10,
    sources: [source("docs", content)],
  });
  layer.set(content);
  return new ContextStack([layer]);
}

function makeThread(id: string = "test", content?: string): Thread {
  const stack = makeStack(content);
  return new Thread(id, stack, {
    description: `thread-${id}`,
    tags: ["test"],
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let signalCounter = 0;
function makeSignal(kind: string, content: unknown = {}): Signal {
  return {
    id: `sig-${++signalCounter}`,
    kind,
    source: "test",
    content,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Thread Fan-Out Race Conditions
// ---------------------------------------------------------------------------

describe("Thread fan-out race conditions", () => {
  test("concurrent fan dispatch to 5+ agents completes without data corruption", async () => {
    const thread = makeThread();

    for (let i = 0; i < 8; i++) {
      thread.register(
        new Executor({
          id: `agent-${i}`,
          stack: thread.stack,
          handler: async (_ctx, payload: string) => {
            // Simulate varied work
            await delay(Math.random() * 5);
            return `result-${i}:${payload}`;
          },
        })
      );
    }

    const agentIds = Array.from({ length: 8 }, (_, i) => `agent-${i}`);
    const results = await thread.fan(agentIds, "payload");

    expect(results.length).toBe(8);
    for (let i = 0; i < 8; i++) {
      expect(results[i].status).toBe("fulfilled");
      expect(results[i].agentId).toBe(`agent-${i}`);
      expect(results[i].result?.output).toBe(`result-${i}:payload`);
    }
  });

  test("fan with slow and fast agents collects all results correctly", async () => {
    const thread = makeThread();

    // Fast agent: no delay
    thread.register(
      new Executor({
        id: "fast",
        stack: thread.stack,
        handler: async (_ctx, payload: string) => `fast:${payload}`,
      })
    );

    // Slow agent: 50ms delay
    thread.register(
      new Executor({
        id: "slow",
        stack: thread.stack,
        handler: async (_ctx, payload: string) => {
          await delay(50);
          return `slow:${payload}`;
        },
      })
    );

    // Medium agent: 20ms delay
    thread.register(
      new Executor({
        id: "medium",
        stack: thread.stack,
        handler: async (_ctx, payload: string) => {
          await delay(20);
          return `medium:${payload}`;
        },
      })
    );

    const results = await thread.fan(["fast", "slow", "medium"], "data");

    expect(results.length).toBe(3);

    // All should be fulfilled regardless of timing
    const byAgent = new Map(results.map((r) => [r.agentId, r]));
    expect(byAgent.get("fast")!.result?.output).toBe("fast:data");
    expect(byAgent.get("slow")!.result?.output).toBe("slow:data");
    expect(byAgent.get("medium")!.result?.output).toBe("medium:data");
  });

  test("fan with failing agents: others still complete (allSettled behavior)", async () => {
    const thread = makeThread();

    thread.register(
      new Executor({
        id: "ok-1",
        stack: thread.stack,
        handler: async () => "ok-1-result",
      })
    );
    thread.register(
      new Executor({
        id: "fail-1",
        stack: thread.stack,
        handler: async () => {
          throw new Error("fail-1-error");
        },
      })
    );
    thread.register(
      new Executor({
        id: "ok-2",
        stack: thread.stack,
        handler: async () => {
          await delay(10);
          return "ok-2-result";
        },
      })
    );
    thread.register(
      new Executor({
        id: "fail-2",
        stack: thread.stack,
        handler: async () => {
          await delay(5);
          throw new Error("fail-2-error");
        },
      })
    );
    thread.register(
      new Executor({
        id: "ok-3",
        stack: thread.stack,
        handler: async () => "ok-3-result",
      })
    );

    const results = await thread.fan(
      ["ok-1", "fail-1", "ok-2", "fail-2", "ok-3"],
      "test"
    );

    expect(results.length).toBe(5);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled.length).toBe(3);
    expect(rejected.length).toBe(2);

    expect(fulfilled.map((r) => r.result?.output).sort()).toEqual([
      "ok-1-result",
      "ok-2-result",
      "ok-3-result",
    ]);
  });

  test("concurrent dispatches to same thread: no state corruption in middleware/context", async () => {
    const thread = makeThread();
    const annotations: Record<string, unknown>[] = [];

    thread.middleware.use("track", async (ctx, next) => {
      ctx.annotations.dispatchId = ctx.agentId;
      const result = await next();
      // Capture a snapshot of annotations at completion time
      annotations.push({ ...ctx.annotations });
      return result;
    });

    for (let i = 0; i < 5; i++) {
      thread.register(
        new Executor({
          id: `worker-${i}`,
          stack: thread.stack,
          handler: async (_ctx, payload: string) => {
            await delay(Math.random() * 10);
            return `done-${i}`;
          },
        })
      );
    }

    // Fire all dispatches concurrently
    const promises = Array.from({ length: 5 }, (_, i) =>
      thread.dispatch(`worker-${i}`, `payload-${i}`)
    );

    const results = await Promise.all(promises);

    // All dispatches completed
    expect(results.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(results[i].output).toBe(`done-${i}`);
    }

    // Each middleware invocation saw its own annotation, not a shared one
    expect(annotations.length).toBe(5);
    const seenIds = new Set(annotations.map((a) => a.dispatchId));
    expect(seenIds.size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Signal Bus Under Load
// ---------------------------------------------------------------------------

describe("Signal bus under load", () => {
  test("high-volume signal emission: all handlers called and history correct", async () => {
    const bus = new SignalBus(500);
    const received: string[] = [];

    bus.on("correction", (signal) => {
      received.push(signal.id);
    });

    const signals: Signal[] = [];
    for (let i = 0; i < 150; i++) {
      signals.push({
        id: `sig-vol-${i}`,
        kind: "correction",
        source: "test",
        content: { index: i },
        timestamp: Date.now(),
      });
    }

    // Emit all signals (sequentially since emit is async)
    for (const signal of signals) {
      await bus.emit(signal);
    }

    // All handlers were called
    expect(received.length).toBe(150);
    expect(received[0]).toBe("sig-vol-0");
    expect(received[149]).toBe("sig-vol-149");

    // History is correct
    const history = bus.recent("correction", 200);
    expect(history.length).toBe(150);
  });

  test("signal handler that emits another signal (re-entrancy)", async () => {
    const bus = new SignalBus(100);
    const received: string[] = [];

    // Handler for "correction" emits a "convention" signal
    bus.on("correction", async (signal) => {
      received.push(`correction:${signal.id}`);
      await bus.emit({
        id: `derived-${signal.id}`,
        kind: "convention",
        source: "re-entrant",
        content: { derived: true },
        timestamp: Date.now(),
      });
    });

    bus.on("convention", (signal) => {
      received.push(`convention:${signal.id}`);
    });

    await bus.emit({
      id: "trigger",
      kind: "correction",
      source: "test",
      content: {},
      timestamp: Date.now(),
    });

    // Both handlers should have fired
    expect(received).toContain("correction:trigger");
    expect(received).toContain("convention:derived-trigger");

    // History should contain both signals
    const allHistory = bus.recent(undefined, 100);
    expect(allHistory.length).toBe(2);
    expect(allHistory.map((s) => s.id)).toEqual(["trigger", "derived-trigger"]);
  });
});

// ---------------------------------------------------------------------------
// Middleware Chain Concurrency
// ---------------------------------------------------------------------------

describe("Middleware chain concurrency", () => {
  test("concurrent middleware execution: multiple dispatches through same chain", async () => {
    const thread = makeThread();
    const order: string[] = [];

    thread.middleware.use("logger", async (ctx, next) => {
      order.push(`enter:${ctx.agentId}`);
      await delay(5); // Simulate async work
      const result = await next();
      order.push(`exit:${ctx.agentId}`);
      return result;
    });

    for (let i = 0; i < 3; i++) {
      thread.register(
        new Executor({
          id: `worker-${i}`,
          stack: thread.stack,
          handler: async (_ctx, payload: string) => {
            await delay(5);
            return `result-${i}`;
          },
        })
      );
    }

    const results = await Promise.all([
      thread.dispatch("worker-0", "a"),
      thread.dispatch("worker-1", "b"),
      thread.dispatch("worker-2", "c"),
    ]);

    // All completed with correct results
    expect(results[0].output).toBe("result-0");
    expect(results[1].output).toBe("result-1");
    expect(results[2].output).toBe("result-2");

    // All middleware entries and exits happened
    const enters = order.filter((o) => o.startsWith("enter:"));
    const exits = order.filter((o) => o.startsWith("exit:"));
    expect(enters.length).toBe(3);
    expect(exits.length).toBe(3);

    // Each dispatch had its own enter/exit pair
    for (let i = 0; i < 3; i++) {
      expect(order).toContain(`enter:worker-${i}`);
      expect(order).toContain(`exit:worker-${i}`);
    }
  });

  test("middleware with shared state: no corruption when accessing annotations", async () => {
    const thread = makeThread();
    const annotationSnapshots: Record<string, unknown>[] = [];

    // First middleware writes agent-specific annotation
    thread.middleware.use("annotator", async (ctx, next) => {
      ctx.annotations.agent = ctx.agentId;
      ctx.annotations.startTime = Date.now();
      await delay(Math.random() * 5);
      return next();
    });

    // Second middleware reads annotations and captures them
    thread.middleware.use("reader", async (ctx, next) => {
      const result = await next();
      annotationSnapshots.push({ ...ctx.annotations });
      return result;
    });

    for (let i = 0; i < 4; i++) {
      thread.register(
        new Executor({
          id: `agent-${i}`,
          stack: thread.stack,
          handler: async () => `done-${i}`,
        })
      );
    }

    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        thread.dispatch(`agent-${i}`, "test")
      )
    );

    // Each dispatch should have its own annotation, not cross-contaminated
    expect(annotationSnapshots.length).toBe(4);
    const agents = annotationSnapshots.map((a) => a.agent).sort();
    expect(agents).toEqual(["agent-0", "agent-1", "agent-2", "agent-3"]);

    // Each snapshot should have its own agent id matching
    for (const snap of annotationSnapshots) {
      expect(typeof snap.agent).toBe("string");
      expect((snap.agent as string).startsWith("agent-")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Context Stack Concurrent Access
// ---------------------------------------------------------------------------

describe("Context stack concurrent access", () => {
  test("concurrent layer warming: multiple layers warm simultaneously", async () => {
    let loadCount = 0;

    const layers = Array.from({ length: 5 }, (_, i) =>
      new ContextLayer({
        id: `layer-${i}`,
        trust: i,
        sources: [
          {
            id: `src-${i}`,
            load: async () => {
              loadCount++;
              await delay(Math.random() * 10);
              return `content-${i}`;
            },
          },
        ],
      })
    );

    const stack = new ContextStack(layers);
    await stack.warmAll();

    // All layers warmed
    expect(loadCount).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(layers[i].isWarm).toBe(true);
      expect(layers[i].content).toBe(`content-${i}`);
    }
  });

  test("warm during assemble: one task warms while another assembles", async () => {
    const layer1 = new ContextLayer({
      id: "existing",
      trust: 10,
      sources: [source("existing", "existing-content")],
    });
    layer1.set("existing-content");

    const layer2 = new ContextLayer({
      id: "new-layer",
      trust: 5,
      sources: [
        {
          id: "slow-source",
          load: async () => {
            await delay(20);
            return "new-content";
          },
        },
      ],
    });

    const stack = new ContextStack([layer1, layer2]);

    // Run warm and assemble concurrently
    const [, assembled] = await Promise.all([
      stack.warmAll(),
      (async () => {
        // Assemble while warming is in progress
        // layer1 is already warm, layer2 may or may not be warm yet
        const result = stack.assemble("system prompt");
        return result;
      })(),
    ]);

    // The assemble should have at least the already-warm layer
    expect(assembled.blocks.length).toBeGreaterThanOrEqual(2); // system + at least layer1

    // After warmAll completes, both layers should be warm
    expect(layer1.isWarm).toBe(true);
    expect(layer2.isWarm).toBe(true);

    // A second assemble after warming should include both
    const finalAssembled = stack.assemble("system prompt");
    const contentBlocks = finalAssembled.blocks.filter((b) => b.role === "content");
    expect(contentBlocks.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Session Manager
// ---------------------------------------------------------------------------

describe("SessionManager concurrency", () => {
  test("concurrent thread creation: dispatches to different lazy threads", async () => {
    const sm = new SessionManager();
    const createdIds: string[] = [];

    sm.addBlueprint({
      match: /^worker-/,
      create: async (destId) => {
        await delay(Math.random() * 10);
        const thread = makeThread(destId);
        thread.register(
          new Executor({
            id: "handler",
            stack: thread.stack,
            handler: async (_ctx, payload: string) => `${destId}:${payload}`,
          })
        );
        createdIds.push(destId);
        return thread;
      },
    });

    // Dispatch to 5 different destinations concurrently
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        sm.dispatch(`worker-${i}`, `payload-${i}`, { agentId: "handler" })
      )
    );

    // All dispatches completed correctly
    expect(results.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(results[i].output).toBe(`worker-${i}:payload-${i}`);
    }

    // All threads were created
    expect(createdIds.length).toBe(5);
    expect(sm.threads.size).toBe(5);
  });

  test("blueprint race: two dispatches to same unresolved blueprint", async () => {
    const sm = new SessionManager();
    let createCount = 0;

    sm.addBlueprint({
      match: "shared-thread",
      create: async (destId) => {
        createCount++;
        await delay(10); // Simulate async thread creation
        const thread = makeThread(destId);
        thread.register(
          new Executor({
            id: "handler",
            stack: thread.stack,
            handler: async (_ctx, payload: string) => `result:${payload}`,
          })
        );
        return thread;
      },
    });

    // Two concurrent dispatches to the same unresolved destination
    const results = await Promise.allSettled([
      sm.dispatch("shared-thread", "first", { agentId: "handler" }),
      sm.dispatch("shared-thread", "second", { agentId: "handler" }),
    ]);

    // At least one should succeed
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    // The thread should exist in the manager
    expect(sm.get("shared-thread")).toBeDefined();

    // Both results should produce valid output (whether from same or different thread)
    // The key assertion: no crash, no undefined behavior, results are valid
    for (const r of fulfilled) {
      const output = (r as PromiseFulfilledResult<{ output: unknown }>).value
        .output as string;
      expect(output).toMatch(/^result:(first|second)$/);
    }
  });
});
