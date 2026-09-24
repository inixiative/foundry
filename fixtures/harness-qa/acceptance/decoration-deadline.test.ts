import { expect, test } from "bun:test";
import { ContextLayer, ContextStack, SignalBus } from "../../../packages/core/src";
import { Cartographer } from "../../../packages/foundry/src/agents/cartographer";
import { DomainLibrarian } from "../../../packages/foundry/src/agents/domain-librarian";
import { FlowOrchestrator } from "../../../packages/foundry/src/agents/flow-orchestrator";
import { Librarian } from "../../../packages/foundry/src/agents/librarian";

test("G3: a stalled router cannot block completed domain decoration indefinitely", async () => {
  const signals = new SignalBus();
  const layer = new ContextLayer({ id: "security" });
  layer.set("Security knowledge");
  const stack = new ContextStack([layer]);
  const librarian = new Librarian({ stack, signals });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const cartographer = new Cartographer({ stack, signals, llm: { id: "router", complete: async () => {
    await held;
    return { model: "mock", content: '{"domains":["late-router"],"layers":[],"confidence":1}' };
  } } });
  const domain = new DomainLibrarian({ domain: "security", cache: layer, signals,
    llm: { id: "adviser", complete: async () => ({ model: "mock",
      content: '{"layers":["security"],"snippets":["Preserve security boundary"],"confidence":1}' }) } });
  const flow = new FlowOrchestrator({ stack, signals, librarian, cartographer,
    domainLibrarians: new Map([["security", domain]]), routingTimeoutMs: 15, adviseTimeoutMs: 15 });
  const pending = flow.preMessage("Original intent");
  try {
    const result = await Promise.race([pending, Bun.sleep(150).then(() => "blocked" as const)]);
    expect(result).not.toBe("blocked");
    if (result === "blocked") return;
    expect(result.snippets).toContain("Preserve security boundary");
    expect(JSON.stringify(result)).toContain("timeout");
    const sealed = JSON.stringify(result);
    release();
    await Bun.sleep(5);
    expect(JSON.stringify(result)).toBe(sealed);
    expect(JSON.stringify(result.routing)).not.toContain("late-router");
  } finally {
    release();
    await pending;
    flow.dispose(); cartographer.dispose(); librarian.dispose();
  }
});
