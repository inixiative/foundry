import { describe, test, expect } from "bun:test";
import { Trace } from "../src/agents/trace";

describe("Trace", () => {
  test("creates with root ingress span", () => {
    const trace = new Trace("msg-1");
    expect(trace.messageId).toBe("msg-1");
    expect(trace.id).toContain("msg-1");
    expect(trace.root).toBeTruthy();
    expect(trace.root.kind).toBe("ingress");
    expect(trace.root.status).toBe("running");
    expect(trace.depth).toBe(1); // root is on stack
  });

  test("start/end creates child spans", () => {
    const trace = new Trace("msg-1");

    trace.start("classify", "classify", { agentId: "classifier" });
    expect(trace.depth).toBe(2);
    expect(trace.current?.name).toBe("classify");

    trace.end({ category: "bug" });
    expect(trace.depth).toBe(1); // back to root
    expect(trace.current?.name).toBe("ingress");

    // Classify should be child of root
    expect(trace.root.children.length).toBe(1);
    expect(trace.root.children[0].name).toBe("classify");
    expect(trace.root.children[0].status).toBe("ok");
    expect(trace.root.children[0].output).toEqual({ category: "bug" });
  });

  test("nested spans form a tree", () => {
    const trace = new Trace("msg-1");

    trace.start("classify", "classify");
    trace.start("sub-task", "execute");
    trace.end("sub-result");
    trace.end("classify-result");

    expect(trace.root.children.length).toBe(1);
    const classify = trace.root.children[0];
    expect(classify.children.length).toBe(1);
    expect(classify.children[0].name).toBe("sub-task");
  });

  test("end with error sets error status", () => {
    const trace = new Trace("msg-1");
    trace.start("classify", "classify");
    trace.end(undefined, new Error("classification failed"));

    const classify = trace.root.children[0];
    expect(classify.status).toBe("error");
    expect(classify.error).toBeInstanceOf(Error);
  });

  test("end on empty stack returns undefined", () => {
    const trace = new Trace("msg-1");
    trace.finish(); // closes root
    expect(trace.end()).toBeUndefined();
  });

  test("finish closes all open spans", () => {
    const trace = new Trace("msg-1");
    trace.start("a", "classify");
    trace.start("b", "route");
    trace.start("c", "dispatch");
    // 4 spans open (root + a + b + c)
    expect(trace.depth).toBe(4);

    trace.finish();
    expect(trace.depth).toBe(0);
    expect(trace.endedAt).toBeDefined();

    // All should be ok (since they were running, finish marks them ok)
    expect(trace.root.status).toBe("ok");
    expect(trace.root.children[0].status).toBe("ok");
  });

  test("finish preserves error status on spans", () => {
    const trace = new Trace("msg-1");
    trace.start("failing", "execute");
    trace.end(undefined, "something went wrong");

    trace.start("another", "dispatch");
    // don't end this one — finish should close it
    trace.finish();

    const failing = trace.root.children[0];
    const another = trace.root.children[1];
    expect(failing.status).toBe("error");
    expect(another.status).toBe("ok");
  });

  test("spans returns flat sorted list", () => {
    const trace = new Trace("msg-1");
    trace.start("a", "classify");
    trace.end("done");
    trace.start("b", "route");
    trace.end("done");
    trace.finish();

    const spans = trace.spans;
    expect(spans.length).toBe(3); // root + a + b
    // Sorted by startedAt
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].startedAt).toBeGreaterThanOrEqual(spans[i - 1].startedAt);
    }
  });

  test("getSpan finds by id", () => {
    const trace = new Trace("msg-1");
    const span = trace.start("test", "classify");
    expect(trace.getSpan(span.id)).toBe(span);
    expect(trace.getSpan("nonexistent")).toBeUndefined();
  });

  test("durationMs is calculated after finish", () => {
    const trace = new Trace("msg-1");
    expect(trace.durationMs).toBeUndefined();
    trace.finish();
    expect(trace.durationMs).toBeDefined();
    expect(trace.durationMs!).toBeGreaterThanOrEqual(0);
  });

  test("summary produces structured overview", () => {
    const trace = new Trace("msg-1");
    trace.start("classify", "classify", { agentId: "classifier" });
    trace.end("bug");
    trace.start("route", "route", { agentId: "router" });
    trace.end("executor-fix");
    trace.finish();

    const summary = trace.summary();
    expect(summary.traceId).toBe(trace.id);
    expect(summary.messageId).toBe("msg-1");
    expect(summary.spanCount).toBe(3); // root + classify + route
    expect(summary.stages.length).toBe(3);

    // Check stage structure
    expect(summary.stages[0].kind).toBe("ingress");
    expect(summary.stages[0].depth).toBe(0);
    expect(summary.stages[1].kind).toBe("classify");
    expect(summary.stages[1].depth).toBe(1);
    expect(summary.stages[1].agentId).toBe("classifier");
    expect(summary.stages[2].kind).toBe("route");
    expect(summary.stages[2].depth).toBe(1);
  });

  test("span detail is preserved", () => {
    const trace = new Trace("msg-1");
    const span = trace.start("classify", "classify", {
      agentId: "classifier",
      threadId: "thread-1",
      layerIds: ["docs", "taxonomy"],
      contextHash: "abc123",
      input: { message: "hello" },
    });

    expect(span.agentId).toBe("classifier");
    expect(span.threadId).toBe("thread-1");
    expect(span.layerIds).toEqual(["docs", "taxonomy"]);
    expect(span.contextHash).toBe("abc123");
    expect(span.input).toEqual({ message: "hello" });
  });
});
