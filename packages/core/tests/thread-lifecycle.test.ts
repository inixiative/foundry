import { describe, test, expect } from "bun:test";
import { ContextLayer, ContextStack, Classifier, Executor, Harness, Thread, type Signal } from "../src";

function makeThread(id = "t") {
  const layer = new ContextLayer({ id: "system" });
  layer.set("baseline");
  return new Thread(id, new ContextStack([layer]), { cwd: "/work/t" });
}

describe("Thread archive during active work", () => {
  test("dispatch on an archived thread throws instead of running without wiring", async () => {
    const thread = makeThread();
    let ran = false;
    thread.register(new Executor({ id: "worker", stack: thread.stack, handler: async () => { ran = true; return "done"; } }));
    thread.archive();

    await expect(thread.dispatch("worker", "go")).rejects.toThrow(/archived/);
    expect(ran).toBe(false);
    expect(thread.meta.status).toBe("archived");
  });

  test("late completion of in-flight work does not flip an archived thread back to idle", async () => {
    const thread = makeThread();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    thread.register(new Executor({ id: "worker", stack: thread.stack, handler: async () => { await gate; return "late"; } }));

    const inFlight = thread.dispatch("worker", "go");
    expect(thread.meta.status).toBe("active");
    thread.archive();
    expect(thread.meta.status).toBe("archived");

    release();
    const result = await inFlight;
    expect(result.output).toBe("late");
    expect(thread.meta.status).toBe("archived");
  });
});

describe("Thread disposal", () => {
  test("dispose permanently closes dispatch, background dispatch and fan", async () => {
    const thread = makeThread();
    let ran = false;
    thread.register(new Executor({ id: "worker", stack: thread.stack, handler: async () => { ran = true; return "done"; } }));
    thread.dispose();

    expect(thread.disposed).toBe(true);
    expect(thread.meta.status).toBe("idle");
    await expect(thread.dispatch("worker", "go")).rejects.toThrow(/disposed/);
    const background = await thread.dispatchBackground("worker", "go").promise;
    expect(background.output).toBeNull();
    const fanned = await thread.fan(["worker"], "go");
    expect(fanned[0].status).toBe("rejected");
    expect(ran).toBe(false);
  });

  test("dispose is idempotent and runs each disposer once", () => {
    const thread = makeThread();
    let runs = 0;
    thread.onDispose(() => { runs++; });
    thread.dispose();
    thread.dispose();
    thread.archive();
    expect(runs).toBe(1);
    expect(thread.meta.status).toBe("archived");
  });

  test("late completion cannot resurrect a disposed thread", async () => {
    const thread = makeThread();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    thread.register(new Executor({ id: "worker", stack: thread.stack, handler: async () => { await gate; return "late"; } }));
    const inFlight = thread.dispatch("worker", "go");
    thread.dispose();
    release();
    expect((await inFlight).output).toBe("late");
    expect(thread.disposed).toBe(true);
    await expect(thread.dispatch("worker", "again")).rejects.toThrow(/disposed/);
  });

  test("start on a disposed thread throws instead of silently restarting its lifecycle", async () => {
    const thread = makeThread();
    const seen: string[] = [];
    thread.lifecycle.on("layer:stale", async (event) => { seen.push(event.layerId); });
    thread.start();
    thread.stack.getLayer("system")!.invalidate();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(["system"]);

    thread.dispose();
    expect(() => thread.start()).toThrow(/disposed/);

    thread.stack.getLayer("system")!.set("warm again");
    thread.stack.getLayer("system")!.invalidate();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(["system"]);
  });

  test("pause and resume stay distinct from disposal", async () => {
    const thread = makeThread();
    thread.register(new Executor({ id: "worker", stack: thread.stack, handler: async () => "done" }));
    thread.start();
    thread.meta.status = "waiting";
    thread.stop();
    expect(thread.disposed).toBe(false);

    thread.meta.status = "idle";
    thread.start();
    expect((await thread.dispatch("worker", "after resume")).output).toBe("done");
    expect(thread.meta.status).toBe("idle");
  });
});

describe("Concurrent dispatch status", () => {
  test("one dispatch finishing does not show idle while another is still active", async () => {
    const thread = makeThread();
    const gates: Array<() => void> = [];
    thread.register(new Executor({ id: "worker", stack: thread.stack, handler: async () => {
      await new Promise<void>((r) => gates.push(r));
      return "done";
    } }));
    const first = thread.dispatch("worker", "1");
    const second = thread.dispatch("worker", "2");
    expect(thread.meta.status).toBe("active");
    gates[0]();
    await first;
    expect(thread.meta.status).toBe("active");
    gates[1]();
    await second;
    expect(thread.meta.status).toBe("idle");
  });
});

describe("Dispatch observations at the thread boundary", () => {
  function observed(thread: Thread): Signal[] {
    const seen: Signal[] = [];
    thread.signals.on("dispatch", (s) => { seen.push(s); });
    return seen;
  }

  test("direct, background and fan dispatches each emit exactly one scoped observation", async () => {
    const thread = makeThread("obs-direct");
    const other = makeThread("obs-other");
    thread.register(new Executor({ id: "worker", stack: thread.stack, handler: async () => "done" }));
    thread.register(new Executor({ id: "second", stack: thread.stack, handler: async () => "done" }));
    other.register(new Executor({ id: "worker", stack: other.stack, handler: async () => "done" }));
    const seen = observed(thread);
    const seenOther = observed(other);

    await thread.dispatch("worker", "direct");
    await thread.dispatchBackground("worker", "background").promise;
    await thread.fan(["worker", "second"], "fan");

    expect(seen.map((s) => (s.content as { agentId: string }).agentId)).toEqual(["worker", "worker", "worker", "second"]);
    expect(seen[0].source).toBe("thread:obs-direct");
    expect(seen[0].content).toMatchObject({ agentId: "worker", payload: "direct", ok: true, threadId: "obs-direct" });
    expect(typeof (seen[0].content as { durationMs: number }).durationMs).toBe("number");
    expect(seenOther).toHaveLength(0);
  });

  test("a failed dispatch emits one structured failure observation and still rejects", async () => {
    const thread = makeThread("obs-fail");
    thread.register(new Executor({ id: "boom", stack: thread.stack, handler: async () => { throw new Error("handler exploded"); } }));
    const seen = observed(thread);
    await expect(thread.dispatch("boom", "go")).rejects.toThrow("handler exploded");
    expect(seen).toHaveLength(1);
    expect(seen[0].content).toMatchObject({ agentId: "boom", ok: false, error: "handler exploded", payload: "go" });
    expect(thread.dispatches).toHaveLength(0);
  });

  test("role and message correlation ride along when the caller supplies them", async () => {
    const thread = makeThread("obs-corr");
    thread.register(new Executor({ id: "worker", stack: thread.stack, handler: async () => "done" }));
    const seen = observed(thread);
    await thread.dispatch("worker", "go", undefined, { role: "execute", messageId: "m-1" });
    expect(seen[0].content).toMatchObject({ role: "execute", messageId: "m-1" });
    expect(seen[0].source).toBe("harness:worker");
  });

  test("non-string payloads are serialized and bounded in the observation", async () => {
    const thread = makeThread("obs-payload");
    thread.register(new Executor({ id: "worker", stack: thread.stack, handler: async () => "done" }));
    const seen = observed(thread);
    await thread.dispatch("worker", { big: "x".repeat(5000) });
    const payload = (seen[0].content as { payload: string }).payload;
    expect(payload.startsWith('{"big":"xxx')).toBe(true);
    expect(payload.length).toBeLessThanOrEqual(2048);
  });
});

describe("Decider dispatch metadata", () => {
  test("Decider handlers receive threadId and cwd from the dispatching thread", async () => {
    const thread = makeThread("meta-thread");
    let seen: unknown;
    thread.register(new Classifier<string>({
      id: "classifier",
      stack: thread.stack,
      handler: async (_context, _payload, meta) => {
        seen = meta;
        return { value: { category: "bug" } };
      },
    }));

    await thread.dispatch("classifier", "Fix it");
    expect(seen).toMatchObject({ threadId: "meta-thread", cwd: "/work/t" });
  });
});

describe("Harness observation signals", () => {
  test("a classified turn emits classification and dispatch signals on the thread bus", async () => {
    const thread = makeThread("obs");
    thread.register(new Classifier<string>({
      id: "classifier", stack: thread.stack,
      handler: async () => ({ value: { category: "bug", tags: ["qa"] }, confidence: 1 }),
    }));
    thread.register(new Executor({ id: "worker", stack: thread.stack, handler: async () => "done" }));
    const seen: Signal[] = [];
    thread.signals.onAny((s) => { seen.push(s); });

    const harness = new Harness(thread);
    harness.setClassifier("classifier");
    harness.setDefaultExecutor("worker");
    await harness.send({ id: "turn-1", payload: "Fix the bug" });

    const classification = seen.filter((s) => s.kind === "classification");
    expect(classification).toHaveLength(1);
    expect(classification[0].content).toMatchObject({ category: "bug", tags: ["qa"] });
    expect(classification[0].source).toBe("harness:classifier");

    const dispatches = seen.filter((s) => s.kind === "dispatch");
    expect(dispatches.map((s) => (s.content as { agentId: string }).agentId)).toEqual(["classifier", "worker"]);
    expect(dispatches[0].content).toMatchObject({ agentId: "classifier", role: "classify", messageId: "turn-1", invocation: "always" });
    expect(dispatches[1].content).toMatchObject({ agentId: "worker", role: "execute", messageId: "turn-1", payload: "Fix the bug", invocation: "always" });
  });

  test("background, on-demand and direct harness dispatches are observed once each with correlation", async () => {
    const thread = makeThread("obs-harness");
    thread.register(new Executor({ id: "worker", stack: thread.stack, handler: async () => "done" }));
    thread.register(new Executor({ id: "observer", stack: thread.stack, handler: async () => "seen" }));
    thread.register(new Executor({ id: "helper", stack: thread.stack, handler: async () => "helped" }));
    const seen: Signal[] = [];
    thread.signals.on("dispatch", (s) => { seen.push(s); });

    const harness = new Harness(thread);
    let background: Promise<void> | undefined;
    harness.onBackground(() => {});
    harness.setFlow({
      defaultExecutor: "worker",
      stages: [
        { agentId: "routed", role: "execute", invocation: "always" },
        { agentId: "observer", role: "observe", invocation: "always", background: true },
      ],
    });
    thread.middleware.use("request-helper", async (_ctx, next) => next());
    await harness.send({ id: "turn-bg", payload: "Do it" });
    await harness.invokeOnDemand("helper", "extra");
    await harness.dispatch("worker", "direct");
    background = new Promise((r) => setTimeout(r, 5));
    await background;

    const byAgent = (id: string) => seen.filter((s) => (s.content as { agentId: string }).agentId === id);
    expect(byAgent("worker")).toHaveLength(2);
    expect(byAgent("worker")[0].content).toMatchObject({ role: "execute", messageId: "turn-bg" });
    expect(byAgent("worker")[1].content).not.toHaveProperty("messageId");
    expect(byAgent("observer")).toHaveLength(1);
    expect(byAgent("observer")[0].content).toMatchObject({ role: "observe", messageId: "turn-bg", invocation: "background" });
    expect(byAgent("helper")).toHaveLength(1);
    expect(byAgent("helper")[0].content).toMatchObject({ invocation: "on-demand" });
  });

  test("a failing execute stage is observed once as a failure and the send rejects", async () => {
    const thread = makeThread("obs-harness-fail");
    thread.register(new Executor({ id: "worker", stack: thread.stack, handler: async () => { throw new Error("stage failed"); } }));
    const seen: Signal[] = [];
    thread.signals.on("dispatch", (s) => { seen.push(s); });
    const harness = new Harness(thread);
    harness.setDefaultExecutor("worker");
    await expect(harness.send({ id: "turn-fail", payload: "Break" })).rejects.toThrow("stage failed");
    expect(seen).toHaveLength(1);
    expect(seen[0].content).toMatchObject({ agentId: "worker", ok: false, error: "stage failed", role: "execute", messageId: "turn-fail" });
  });
});
