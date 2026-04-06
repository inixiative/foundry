import { describe, test, expect } from "bun:test";
import { SignalBus, type Signal } from "../src/agents/signal";

function makeSignal(kind: string, id?: string): Signal {
  return {
    id: id ?? `sig-${Date.now()}`,
    kind,
    source: "test",
    content: { data: kind },
    confidence: 0.8,
    timestamp: Date.now(),
  };
}

describe("SignalBus", () => {
  test("emit notifies kind-specific handlers", async () => {
    const bus = new SignalBus();
    const received: Signal[] = [];
    bus.on("correction", (s) => {
      received.push(s);
    });

    await bus.emit(makeSignal("correction"));
    await bus.emit(makeSignal("convention")); // different kind

    expect(received.length).toBe(1);
    expect(received[0].kind).toBe("correction");
  });

  test("emit notifies global handlers for all kinds", async () => {
    const bus = new SignalBus();
    const received: Signal[] = [];
    bus.onAny((s) => {
      received.push(s);
    });

    await bus.emit(makeSignal("correction"));
    await bus.emit(makeSignal("convention"));

    expect(received.length).toBe(2);
  });

  test("unsubscribe from kind handler", async () => {
    const bus = new SignalBus();
    const received: Signal[] = [];
    const unsub = bus.on("correction", (s) => {
      received.push(s);
    });

    await bus.emit(makeSignal("correction"));
    unsub();
    await bus.emit(makeSignal("correction"));

    expect(received.length).toBe(1);
  });

  test("unsubscribe from global handler", async () => {
    const bus = new SignalBus();
    const received: Signal[] = [];
    const unsub = bus.onAny((s) => {
      received.push(s);
    });

    await bus.emit(makeSignal("correction"));
    unsub();
    await bus.emit(makeSignal("correction"));

    expect(received.length).toBe(1);
  });

  test("handler error does not kill other handlers", async () => {
    const bus = new SignalBus();
    const received: string[] = [];

    bus.on("test", async () => {
      throw new Error("bad handler");
    });
    bus.on("test", async (s) => {
      received.push("second");
    });
    bus.onAny(async (s) => {
      received.push("global");
    });

    await bus.emit(makeSignal("test"));
    expect(received).toEqual(["second", "global"]);
  });

  test("records history", async () => {
    const bus = new SignalBus();
    await bus.emit(makeSignal("correction", "s1"));
    await bus.emit(makeSignal("convention", "s2"));
    await bus.emit(makeSignal("correction", "s3"));

    expect(bus.recent().length).toBe(3);
    expect(bus.recent("correction").length).toBe(2);
    expect(bus.recent("convention").length).toBe(1);
  });

  test("history respects limit", async () => {
    const bus = new SignalBus();
    for (let i = 0; i < 10; i++) {
      await bus.emit(makeSignal("test", `s${i}`));
    }

    expect(bus.recent(undefined, 3).length).toBe(3);
  });

  test("history is bounded by maxHistory", async () => {
    const bus = new SignalBus(5);
    for (let i = 0; i < 10; i++) {
      await bus.emit(makeSignal("test", `s${i}`));
    }

    const history = bus.recent();
    expect(history.length).toBe(5);
    // Should keep the most recent
    expect(history[history.length - 1].id).toBe("s9");
  });

  test("clearHistory empties history", async () => {
    const bus = new SignalBus();
    await bus.emit(makeSignal("test"));
    bus.clearHistory();
    expect(bus.recent().length).toBe(0);
  });
});
