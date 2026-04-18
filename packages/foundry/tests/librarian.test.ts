import { describe, it, expect, beforeEach } from "bun:test";
import {
  ContextLayer,
  ContextStack,
  SignalBus,
  type Signal,
} from "@inixiative/foundry-core";
import { Librarian, type ThreadState } from "../src/agents/librarian";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignal(kind: string, content: any, source = "test"): Signal {
  return {
    id: `sig-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    kind,
    source,
    content,
    timestamp: Date.now(),
  };
}

function setup() {
  const signals = new SignalBus();
  const stack = new ContextStack([
    new ContextLayer({ id: "auth-conventions", trust: 0.5 }),
    new ContextLayer({ id: "security-patterns", trust: 0.5 }),
  ]);
  const librarian = new Librarian({ signals, stack });
  return { signals, stack, librarian };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Librarian", () => {
  let signals: SignalBus;
  let stack: ContextStack;
  let librarian: Librarian;

  beforeEach(() => {
    signals = new SignalBus();
    stack = new ContextStack([
      new ContextLayer({ id: "auth-conventions", trust: 0.5 }),
      new ContextLayer({ id: "security-patterns", trust: 0.5 }),
    ]);
    librarian = new Librarian({ signals, stack });
  });

  it("creates thread-state layer at position 0 in stack", () => {
    expect(stack.layers[0].id).toBe("thread-state");
    expect(stack.layers[0].trust).toBe(1.0);
    expect(stack.layers[0].isWarm).toBe(true);
  });

  it("initial state has empty domain and zero messages", () => {
    const state = librarian.state;
    expect(state.domain).toBe("");
    expect(state.messageCount).toBe(0);
    expect(state.recentActivity).toHaveLength(0);
    expect(state.flags).toHaveLength(0);
  });

  it("updates domain on classification signal", async () => {
    await signals.emit(makeSignal("classification", {
      category: "auth",
      tags: ["security", "api"],
    }));

    expect(librarian.state.domain).toBe("auth");
    expect(librarian.state.lastClassification?.category).toBe("auth");
    expect(librarian.state.lastClassification?.tags).toContain("security");
    expect(librarian.state.messageCount).toBe(1);
  });

  it("detects domain shift", async () => {
    await signals.emit(makeSignal("classification", { category: "auth", tags: [] }));
    expect(librarian.domainShifted("auth")).toBe(false);
    expect(librarian.domainShifted("payments")).toBe(true);

    await signals.emit(makeSignal("classification", { category: "payments", tags: [] }));
    expect(librarian.state.domain).toBe("payments");
    expect(librarian.domainShifted("payments")).toBe(false);
  });

  it("tracks recent activity from dispatch signals", async () => {
    await signals.emit(makeSignal("dispatch", {
      agentId: "executor-fix",
      payload: "auth/middleware.ts",
    }));

    expect(librarian.state.recentActivity).toHaveLength(1);
    expect(librarian.state.recentActivity[0]).toContain("executor-fix");
    expect(librarian.state.recentActivity[0]).toContain("auth/middleware.ts");
  });

  it("tracks tool observations", async () => {
    await signals.emit(makeSignal("tool_observation", {
      tool: "file_write",
      input: { file_path: "src/auth/service.ts" },
    }));

    expect(librarian.state.recentActivity).toHaveLength(1);
    expect(librarian.state.recentActivity[0]).toContain("file_write");
    expect(librarian.state.recentActivity[0]).toContain("src/auth/service.ts");
  });

  it("caps recent activity at 10 entries", async () => {
    for (let i = 0; i < 15; i++) {
      await signals.emit(makeSignal("dispatch", {
        agentId: `agent-${i}`,
      }));
    }

    expect(librarian.state.recentActivity).toHaveLength(10);
    // Oldest entries should have been evicted
    expect(librarian.state.recentActivity[0]).toContain("agent-5");
    expect(librarian.state.recentActivity[9]).toContain("agent-14");
  });

  it("adds flags from security signals", async () => {
    await signals.emit(makeSignal("security_concern", "SQL injection risk in auth/service.ts"));

    expect(librarian.state.flags).toContain("security-concern-active");
    expect(librarian.state.recentActivity[0]).toContain("Security:");
  });

  it("adds cross-module flag from architecture observations", async () => {
    await signals.emit(makeSignal("architecture_observation", "cross-module edit detected: auth imports from payments"));

    expect(librarian.state.flags).toContain("cross-module");
  });

  it("tracks loaded context layer IDs", async () => {
    await signals.emit(makeSignal("context_loaded", { layerId: "auth-conventions" }));
    await signals.emit(makeSignal("context_loaded", { layerId: "security-patterns" }));

    expect(librarian.state.inContext).toContain("auth-conventions");
    expect(librarian.state.inContext).toContain("security-patterns");
  });

  it("removes evicted context from inContext", async () => {
    await signals.emit(makeSignal("context_loaded", { layerId: "auth-conventions" }));
    await signals.emit(makeSignal("context_loaded", { layerId: "security-patterns" }));
    await signals.emit(makeSignal("context_evicted", { layerId: "auth-conventions" }));

    expect(librarian.state.inContext).not.toContain("auth-conventions");
    expect(librarian.state.inContext).toContain("security-patterns");
  });

  it("deduplicates context_loaded signals", async () => {
    await signals.emit(makeSignal("context_loaded", { layerId: "auth-conventions" }));
    await signals.emit(makeSignal("context_loaded", { layerId: "auth-conventions" }));

    expect(librarian.state.inContext.filter((id) => id === "auth-conventions")).toHaveLength(1);
  });

  it("writes serialized state to the layer", async () => {
    await signals.emit(makeSignal("classification", { category: "auth", tags: ["api"] }));

    const layerContent = librarian.layer.content;
    const parsed = JSON.parse(layerContent) as ThreadState;
    expect(parsed.domain).toBe("auth");
    expect(parsed.messageCount).toBe(1);
  });

  it("layer stays warm after updates", async () => {
    await signals.emit(makeSignal("classification", { category: "auth", tags: [] }));
    await signals.emit(makeSignal("dispatch", { agentId: "executor" }));

    expect(librarian.layer.isWarm).toBe(true);
    expect(librarian.layer.content).toBeTruthy();
  });

  it("dispose stops listening to signals", async () => {
    await signals.emit(makeSignal("classification", { category: "auth", tags: [] }));
    expect(librarian.state.messageCount).toBe(1);

    librarian.dispose();

    await signals.emit(makeSignal("classification", { category: "payments", tags: [] }));
    // Should NOT have updated since we disposed
    expect(librarian.state.messageCount).toBe(1);
    expect(librarian.state.domain).toBe("auth");
  });

  it("handles unknown signal kinds gracefully", async () => {
    await signals.emit(makeSignal("some_custom_signal", "custom data"));

    expect(librarian.state.recentActivity).toHaveLength(1);
    expect(librarian.state.recentActivity[0]).toContain("some_custom_signal");
  });

  it("full lifecycle: classify → dispatch → tool → guard → writeback", async () => {
    // 1. Message classified
    await signals.emit(makeSignal("classification", { category: "auth", tags: ["security"] }));

    // 2. Context loaded
    await signals.emit(makeSignal("context_loaded", { layerId: "auth-conventions" }));
    await signals.emit(makeSignal("context_loaded", { layerId: "security-patterns" }));

    // 3. Executor dispatched
    await signals.emit(makeSignal("dispatch", {
      agentId: "executor-fix",
      payload: "Fix auth middleware JWT validation",
    }));

    // 4. Tool calls observed
    await signals.emit(makeSignal("tool_observation", {
      tool: "file_read",
      input: { file_path: "src/auth/middleware.ts" },
    }));
    await signals.emit(makeSignal("tool_observation", {
      tool: "file_write",
      input: { file_path: "src/auth/middleware.ts" },
    }));

    // 5. Guard result
    await signals.emit(makeSignal("correction", "Convention guard: use camelCase for function names"));

    // Verify final state
    const state = librarian.state;
    expect(state.domain).toBe("auth");
    expect(state.messageCount).toBe(1);
    expect(state.inContext).toContain("auth-conventions");
    expect(state.inContext).toContain("security-patterns");
    expect(state.recentActivity.length).toBeGreaterThanOrEqual(4);
    expect(state.lastClassification?.tags).toContain("security");

    // Verify layer is readable JSON
    const parsed = JSON.parse(librarian.layer.content);
    expect(parsed.domain).toBe("auth");
  });
});
