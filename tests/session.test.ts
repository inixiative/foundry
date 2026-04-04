import { describe, test, expect } from "bun:test";
import { ContextLayer, type ContextSource } from "../src/agents/context-layer";
import { ContextStack } from "../src/agents/context-stack";
import { Thread } from "../src/agents/thread";
import { Executor } from "../src/agents/executor";
import {
  SessionManager,
  type SessionEvent,
  type ThreadBlueprint,
} from "../src/agents/session";

function source(id: string, content: string): ContextSource {
  return { id, load: async () => content };
}

function makeThread(id: string): Thread {
  const layer = new ContextLayer({
    id: "docs",
    trust: 10,
    sources: [source("docs", "context")],
  });
  layer.set("context");
  const stack = new ContextStack([layer]);
  const thread = new Thread(id, stack);
  thread.register(
    new Executor({
      id: "worker",
      stack,
      handler: async (ctx, payload) => `${id}: ${payload}`,
    })
  );
  return thread;
}

describe("SessionManager", () => {
  describe("thread management", () => {
    test("add and get thread", () => {
      const sm = new SessionManager();
      const thread = makeThread("main");
      sm.add(thread);
      expect(sm.get("main")).toBe(thread);
      expect(sm.threads.size).toBe(1);
    });

    test("remove thread", () => {
      const sm = new SessionManager();
      sm.add(makeThread("main"));
      expect(sm.remove("main")).toBe(true);
      expect(sm.get("main")).toBeUndefined();
      expect(sm.remove("nonexistent")).toBe(false);
    });

    test("active and archived", () => {
      const sm = new SessionManager();
      const a = makeThread("a");
      const b = makeThread("b");
      sm.add(a);
      sm.add(b);
      b.archive();

      expect(sm.active.length).toBe(1);
      expect(sm.active[0].id).toBe("a");
      expect(sm.archived.length).toBe(1);
      expect(sm.archived[0].id).toBe("b");
    });
  });

  describe("blueprints and resolve", () => {
    test("resolve returns existing thread", async () => {
      const sm = new SessionManager();
      const thread = makeThread("main");
      sm.add(thread);

      const resolved = await sm.resolve("main");
      expect(resolved).toBe(thread);
    });

    test("resolve spawns from string blueprint", async () => {
      const sm = new SessionManager();
      sm.addBlueprint({
        match: "feature-auth",
        create(id) {
          return makeThread(id);
        },
      });

      const thread = await sm.resolve("feature-auth");
      expect(thread).toBeDefined();
      expect(thread!.id).toBe("feature-auth");
      // Should be registered now
      expect(sm.get("feature-auth")).toBe(thread);
    });

    test("resolve spawns from regex blueprint", async () => {
      const sm = new SessionManager();
      sm.addBlueprint({
        match: /^feature-.*/,
        create(id) {
          return makeThread(id);
        },
      });

      const t1 = await sm.resolve("feature-auth");
      const t2 = await sm.resolve("feature-billing");
      expect(t1?.id).toBe("feature-auth");
      expect(t2?.id).toBe("feature-billing");
    });

    test("resolve returns undefined for no match", async () => {
      const sm = new SessionManager();
      expect(await sm.resolve("unknown")).toBeUndefined();
    });

    test("resolve tracks parent-child relationship", async () => {
      const sm = new SessionManager();
      const parent = makeThread("main");
      sm.add(parent);

      sm.addBlueprint({
        match: /^child-.*/,
        create(id) {
          return makeThread(id);
        },
      });

      const child = await sm.resolve("child-1", parent);
      expect(sm.parentOf("child-1")).toBe(parent);
      expect(sm.childrenOf("main").length).toBe(1);
      expect(sm.childrenOf("main")[0]).toBe(child);
    });
  });

  describe("dispatch", () => {
    test("dispatch to thread agent", async () => {
      const sm = new SessionManager();
      const thread = makeThread("main");
      sm.add(thread);

      const result = await sm.dispatch("main", "hello", {
        sourceThread: thread,
        agentId: "worker",
      });
      // Since "main" is a registered thread, dispatches to its worker
      expect(result.output).toBe("main: hello");
    });

    test("dispatch to new thread via blueprint", async () => {
      const sm = new SessionManager();
      const main = makeThread("main");
      sm.add(main);

      sm.addBlueprint({
        match: /^feature-.*/,
        create(id) {
          return makeThread(id);
        },
      });

      const result = await sm.dispatch("feature-auth", "hello", {
        sourceThread: main,
      });
      expect(result.output).toBe("feature-auth: hello");
    });

    test("dispatch throws for unresolvable destination", async () => {
      const sm = new SessionManager();
      expect(sm.dispatch("unknown", "test")).rejects.toThrow(
        "Cannot resolve destination"
      );
    });
  });

  describe("events", () => {
    test("emits session events", async () => {
      const sm = new SessionManager();
      const events: SessionEvent[] = [];
      sm.onSession((e) => events.push(e));

      sm.add(makeThread("main"));
      sm.remove("main");

      expect(events.length).toBe(2);
      expect(events[0].type).toBe("thread:added");
      expect(events[1].type).toBe("thread:removed");
    });

    test("emits thread:spawned on resolve", async () => {
      const sm = new SessionManager();
      const events: SessionEvent[] = [];
      sm.onSession((e) => events.push(e));

      sm.addBlueprint({
        match: "test",
        create(id) {
          return makeThread(id);
        },
      });

      await sm.resolve("test");
      const spawned = events.find((e) => e.type === "thread:spawned");
      expect(spawned).toBeDefined();
      expect(spawned!.threadId).toBe("test");
    });
  });

  describe("evict", () => {
    test("evicts idle threads past threshold", async () => {
      const sm = new SessionManager();
      const thread = makeThread("old");
      sm.add(thread);

      // Artificially age the thread
      (thread.meta as any).lastActiveAt = Date.now() - 60000;

      const evicted = sm.evict(30000); // 30s threshold
      expect(evicted).toContain("old");
      expect(sm.get("old")).toBeUndefined();
    });

    test("does not evict active threads", async () => {
      const sm = new SessionManager();
      const thread = makeThread("active");
      sm.add(thread);
      (thread.meta as any).status = "active";
      (thread.meta as any).lastActiveAt = Date.now() - 60000;

      const evicted = sm.evict(30000);
      expect(evicted.length).toBe(0);
    });

    test("does not evict threads with active children", async () => {
      const sm = new SessionManager();
      const parent = makeThread("parent");
      sm.add(parent);
      (parent.meta as any).lastActiveAt = Date.now() - 60000;

      sm.addBlueprint({
        match: /^child-.*/,
        create(id) {
          return makeThread(id);
        },
      });

      const child = await sm.resolve("child-1", parent);
      (child!.meta as any).status = "active";

      const evicted = sm.evict(30000);
      expect(evicted.length).toBe(0);
      expect(sm.get("parent")).toBeDefined();
    });

    test("evicts children along with parent", async () => {
      const sm = new SessionManager();
      const parent = makeThread("parent");
      sm.add(parent);
      (parent.meta as any).lastActiveAt = Date.now() - 60000;

      sm.addBlueprint({
        match: /^child-.*/,
        create(id) {
          return makeThread(id);
        },
      });

      await sm.resolve("child-1", parent);

      const evicted = sm.evict(30000);
      expect(evicted).toContain("parent");
      expect(evicted).toContain("child-1");
    });
  });

  describe("stats", () => {
    test("returns correct counts", async () => {
      const sm = new SessionManager();
      sm.add(makeThread("a"));
      sm.add(makeThread("b"));
      const c = makeThread("c");
      c.archive();
      sm.add(c);

      const stats = sm.stats;
      expect(stats.total).toBe(3);
      expect(stats.idle).toBe(2);
      expect(stats.archived).toBe(1);
      expect(stats.active).toBe(0);
    });
  });

  describe("inheritLayers", () => {
    test("shares layers by reference", () => {
      const parent = makeThread("parent");
      const childStack = SessionManager.inheritLayers(parent, {
        share: ["docs"],
      });

      // Same instance
      expect(childStack.getLayer("docs")).toBe(parent.stack.getLayer("docs"));
    });

    test("copies layers as snapshots", () => {
      const parent = makeThread("parent");
      const childStack = SessionManager.inheritLayers(parent, {
        copy: ["docs"],
      });

      const parentLayer = parent.stack.getLayer("docs")!;
      const childLayer = childStack.getLayer("docs")!;

      // Different instance, same content
      expect(childLayer).not.toBe(parentLayer);
      expect(childLayer.content).toBe(parentLayer.content);
    });
  });
});
