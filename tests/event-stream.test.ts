import { describe, test, expect } from "bun:test";
import { EventStream, type StreamEvent } from "../src/agents/event-stream";

function makeEvent(
  kind: StreamEvent["kind"],
  threadId: string = "main"
): StreamEvent {
  if (kind === "session") {
    return {
      kind: "session",
      event: { type: "thread:added", threadId, timestamp: Date.now() },
    };
  }
  if (kind === "signal") {
    return {
      kind: "signal",
      threadId,
      signal: {
        id: "s1",
        kind: "correction",
        source: "test",
        content: {},
        timestamp: Date.now(),
      },
    };
  }
  return {
    kind: "dispatch",
    threadId,
    dispatch: {
      agentId: "test",
      timestamp: Date.now(),
      contextHash: "abc",
      result: { output: "done", contextHash: "abc" },
      durationMs: 10,
    },
  };
}

describe("EventStream", () => {
  test("push notifies subscribers", () => {
    const stream = new EventStream();
    const received: StreamEvent[] = [];
    stream.subscribe((e) => received.push(e));

    stream.push(makeEvent("dispatch"));
    expect(received.length).toBe(1);
    expect(received[0].kind).toBe("dispatch");
  });

  test("multiple subscribers all get events", () => {
    const stream = new EventStream();
    const a: StreamEvent[] = [];
    const b: StreamEvent[] = [];
    stream.subscribe((e) => a.push(e));
    stream.subscribe((e) => b.push(e));

    stream.push(makeEvent("dispatch"));
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
  });

  test("unsubscribe stops notifications", () => {
    const stream = new EventStream();
    const received: StreamEvent[] = [];
    const unsub = stream.subscribe((e) => received.push(e));

    stream.push(makeEvent("dispatch"));
    unsub();
    stream.push(makeEvent("dispatch"));
    expect(received.length).toBe(1);
  });

  test("unsubscribe during iteration doesn't skip", () => {
    const stream = new EventStream();
    const order: string[] = [];
    let unsub2: () => void;

    stream.subscribe(() => {
      order.push("first");
      unsub2(); // unsubscribe second listener during iteration
    });
    unsub2 = stream.subscribe(() => {
      order.push("second");
    });
    stream.subscribe(() => {
      order.push("third");
    });

    stream.push(makeEvent("dispatch"));
    // Because we snapshot, all three should fire
    expect(order).toEqual(["first", "second", "third"]);
  });

  test("bad listener doesn't break others", () => {
    const stream = new EventStream();
    const received: string[] = [];

    stream.subscribe(() => {
      throw new Error("bad");
    });
    stream.subscribe(() => {
      received.push("ok");
    });

    stream.push(makeEvent("dispatch"));
    expect(received).toEqual(["ok"]);
  });

  test("recent returns history", () => {
    const stream = new EventStream();
    stream.push(makeEvent("dispatch", "main"));
    stream.push(makeEvent("signal", "main"));
    stream.push(makeEvent("dispatch", "child"));

    expect(stream.recent().length).toBe(3);
  });

  test("recent filters by kind", () => {
    const stream = new EventStream();
    stream.push(makeEvent("dispatch"));
    stream.push(makeEvent("signal"));
    stream.push(makeEvent("dispatch"));

    const signals = stream.recent({ kind: "signal" });
    expect(signals.length).toBe(1);
  });

  test("recent filters by threadId", () => {
    const stream = new EventStream();
    stream.push(makeEvent("dispatch", "main"));
    stream.push(makeEvent("dispatch", "child"));
    stream.push(makeEvent("session")); // session events are global

    const mainEvents = stream.recent({ threadId: "main" });
    // main dispatch + session event (session events pass through)
    expect(mainEvents.length).toBe(2);
  });

  test("recent respects limit", () => {
    const stream = new EventStream();
    for (let i = 0; i < 10; i++) {
      stream.push(makeEvent("dispatch"));
    }

    expect(stream.recent({ limit: 3 }).length).toBe(3);
  });

  test("history is bounded by maxHistory", () => {
    const stream = new EventStream(5);
    for (let i = 0; i < 10; i++) {
      stream.push(makeEvent("dispatch"));
    }

    expect(stream.recent({ limit: 100 }).length).toBe(5);
  });

  test("clear empties history", () => {
    const stream = new EventStream();
    stream.push(makeEvent("dispatch"));
    stream.push(makeEvent("signal"));
    stream.clear();
    expect(stream.recent().length).toBe(0);
  });
});
