import { describe, it, expect, beforeEach } from "bun:test";
import {
  ContextLayer,
  ContextStack,
  SignalBus,
  type LLMProvider,
  type CompletionResult,
} from "@inixiative/foundry-core";
import { Librarian } from "../src/agents/librarian";
import { DomainLibrarian, type GuardFinding, type ToolObservation } from "../src/agents/domain-librarian";
import { Cartographer } from "../src/agents/cartographer";
import { FlowOrchestrator } from "../src/agents/flow-orchestrator";

// ---------------------------------------------------------------------------
// Mock LLM — returns configurable responses per domain
// ---------------------------------------------------------------------------

function mockLLM(responses: Record<string, string>, fallback?: string): LLMProvider {
  return {
    id: "mock",
    async complete(messages): Promise<CompletionResult> {
      const content = messages.find((m) => m.role === "user")?.content ?? "";
      // Match the MOST specific (longest key) that appears in the content
      let bestMatch = "";
      let bestResponse = fallback ?? '{"layers":[],"snippets":[],"confidence":0.5,"findings":[],"domains":[]}';
      for (const [key, response] of Object.entries(responses)) {
        if (content.includes(key) && key.length > bestMatch.length) {
          bestMatch = key;
          bestResponse = response;
        }
      }
      return { content: bestResponse, model: "mock" };
    },
  };
}

// ---------------------------------------------------------------------------
// Test setup — builds a full pipeline with mock LLMs
// ---------------------------------------------------------------------------

function setup() {
  const signals = new SignalBus();

  // Build layers
  const authConventions = new ContextLayer({ id: "auth-conventions", trust: 0.8 });
  authConventions.set("Use JWT for API auth. Rotate keys every 30 days. Validate tokens on every request.");

  const securityPatterns = new ContextLayer({ id: "security-patterns", trust: 0.9 });
  securityPatterns.set("OWASP top 10. SQL injection prevention. XSS sanitization. No eval().");

  const testingPatterns = new ContextLayer({ id: "testing-patterns", trust: 0.6 });
  testingPatterns.set("Use bun:test. Fixtures in tests/fixtures/. Mock external APIs.");

  const archRules = new ContextLayer({ id: "architecture-boundaries", trust: 0.7 });
  archRules.set("Module boundaries: auth/ cannot import from payments/. One direction dependency.");

  const stack = new ContextStack([authConventions, securityPatterns, testingPatterns, archRules]);

  // Librarian (signal reconciliation)
  const librarian = new Librarian({ signals, stack });

  // Cartographer (context routing) — mock LLM routes messages to layers by keyword
  const cartographerLLM = mockLLM({
    "Fix the JWT validation": JSON.stringify({ layers: ["auth-conventions", "security-patterns"], domains: ["auth", "security"], confidence: 0.9 }),
    "Fix auth middleware": JSON.stringify({ layers: ["auth-conventions", "security-patterns"], domains: ["auth", "security"], confidence: 0.9 }),
    "write a test": JSON.stringify({ layers: ["testing-patterns"], domains: ["testing"], confidence: 0.8 }),
  });
  const cartographer = new Cartographer({ stack, signals, llm: cartographerLLM });

  // Domain librarians
  const conventionLib = new DomainLibrarian({
    domain: "convention",
    cache: authConventions,
    signals,
    llm: mockLLM({
      "convention": JSON.stringify({
        layers: ["auth-conventions"],
        snippets: ["Always use camelCase for function names"],
        confidence: 0.85,
      }),
      // Guard response
      "observation": JSON.stringify({
        findings: [{ severity: "advisory", description: "Function uses snake_case", location: "src/auth/service.ts:42" }],
      }),
    }),
    guardTriggers: ["file_write", "file_create"],
    advisePrompt: "You are the convention advisor.",
    guardPrompt: "You are the convention guard.",
  });

  const securityLib = new DomainLibrarian({
    domain: "security",
    cache: securityPatterns,
    signals,
    llm: mockLLM({
      "What docs": JSON.stringify({ layers: ["security-patterns"], snippets: [], confidence: 0.9 }),
      "what context": JSON.stringify({ layers: ["security-patterns"], snippets: [], confidence: 0.9 }),
    }, JSON.stringify({
      findings: [{ severity: "critical", description: "eval() is banned — code injection risk", location: "src/utils.ts:10" }],
    })),
    guardTriggers: ["file_write", "file_create", "bash"],
  });

  const memoryLib = new DomainLibrarian({
    domain: "memory",
    cache: new ContextLayer({ id: "memory-cache", trust: 0.7 }),
    signals,
    llm: mockLLM({}),
    programmaticGuard: true,
    guardFn: (obs: ToolObservation): GuardFinding[] => {
      const output = obs.output ?? "";
      if (output.includes("setTimeout") && output.includes("0)")) {
        return [{ severity: "advisory", description: "setTimeout(0) is unreliable — known failure pattern" }];
      }
      return [];
    },
  });
  // Set memory cache content
  memoryLib.cache.set(JSON.stringify([{ pattern: "setTimeout.*0)", failure: "Race condition" }]));

  const domainLibrarians = new Map<string, DomainLibrarian>([
    ["convention", conventionLib],
    ["security", securityLib],
    ["memory", memoryLib],
  ]);

  // Wire it all together
  const orchestrator = new FlowOrchestrator({
    cartographer,
    domainLibrarians,
    librarian,
    stack,
    signals,
  });

  return { orchestrator, signals, stack, librarian, cartographer };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FlowOrchestrator", () => {
  describe("preMessage flow", () => {
    it("routes an auth message to auth + security layers", async () => {
      const { orchestrator } = setup();
      const plan = await orchestrator.preMessage("Fix the JWT validation in auth middleware");

      expect(plan.layers).toContain("auth-conventions");
      expect(plan.layers).toContain("security-patterns");
      expect(plan.domainsConsulted).toContain("auth");
      expect(plan.confidence).toBeGreaterThan(0.5);
    });

    it("does NOT include testing layers for auth message", async () => {
      const { orchestrator } = setup();
      const plan = await orchestrator.preMessage("Fix the JWT validation in auth middleware");

      expect(plan.layers).not.toContain("testing-patterns");
      expect(plan.layers).not.toContain("architecture-boundaries");
    });

    it("routes a testing message to testing layers", async () => {
      const { orchestrator } = setup();
      const plan = await orchestrator.preMessage("How should I write a test for the login flow?");

      expect(plan.layers).toContain("testing-patterns");
    });

    it("emits context_loaded signals for injected layers", async () => {
      const { orchestrator, signals } = setup();
      const emitted: any[] = [];
      signals.on("context_loaded", (s) => emitted.push(s));

      await orchestrator.preMessage("Fix auth middleware");

      expect(emitted.length).toBeGreaterThan(0);
      expect(emitted.some((s) => s.content.layerId === "auth-conventions")).toBe(true);
    });

    it("includes elapsed time", async () => {
      const { orchestrator } = setup();
      const plan = await orchestrator.preMessage("anything");

      expect(plan.elapsed).toBeGreaterThanOrEqual(0);
    });

    it("updates Librarian thread-state via signals", async () => {
      const { orchestrator, librarian } = setup();
      await orchestrator.preMessage("Fix auth middleware");

      // The context_loaded signals should have updated the Librarian's inContext
      expect(librarian.state.inContext.length).toBeGreaterThan(0);
    });
  });

  describe("hydrate", () => {
    it("assembles content from the injection plan", async () => {
      const { orchestrator } = setup();
      const plan = await orchestrator.preMessage("Fix auth middleware");
      const context = await orchestrator.hydrate(plan);

      expect(context).toContain("JWT");
      expect(context).toContain("auth");
    });

    it("only hydrates layers in the plan", async () => {
      const { orchestrator } = setup();
      const plan = await orchestrator.preMessage("Fix auth middleware");
      const context = await orchestrator.hydrate(plan);

      // Testing patterns should NOT be in the hydrated context
      expect(context).not.toContain("bun:test");
    });
  });

  describe("postAction flow", () => {
    it("runs convention guard on file_write", async () => {
      const { orchestrator } = setup();
      const report = await orchestrator.postAction({
        tool: "file_write",
        input: { file_path: "src/auth/service.ts" },
        output: "function get_user() { ... }",
      });

      expect(report.domainsChecked).toContain("convention");
      expect(report.domainsChecked).toContain("security");
      expect(report.domainsChecked).toContain("memory"); // programmatic, always runs
    });

    it("skips convention guard on file_read", async () => {
      const { orchestrator } = setup();
      const report = await orchestrator.postAction({
        tool: "file_read",
        input: { file_path: "src/auth/service.ts" },
      });

      // Only memory should run (programmatic, always fires)
      expect(report.domainsChecked).toContain("memory");
      expect(report.domainsChecked).not.toContain("convention");
      expect(report.domainsChecked).not.toContain("security");
    });

    it("separates critical and advisory findings", async () => {
      const { orchestrator } = setup();
      const report = await orchestrator.postAction({
        tool: "file_write",
        input: { file_path: "src/utils.ts" },
        output: "const result = eval(userInput);",
      });

      // Security guard should catch eval() as critical
      const allFindings = [...report.critical, ...report.advisory];
      expect(allFindings.length).toBeGreaterThan(0);
    });

    it("memory guard catches known failure patterns", async () => {
      const { orchestrator } = setup();
      const report = await orchestrator.postAction({
        tool: "file_write",
        input: { file_path: "src/timer.ts" },
        output: "setTimeout(() => resolve(), 0)",
      });

      expect(report.findings.some((f) => f.description.includes("setTimeout"))).toBe(true);
    });

    it("emits tool_observation signal", async () => {
      const { orchestrator, signals } = setup();
      const emitted: any[] = [];
      signals.on("tool_observation", (s) => emitted.push(s));

      await orchestrator.postAction({
        tool: "file_write",
        input: { file_path: "src/x.ts" },
      });

      expect(emitted).toHaveLength(1);
      expect(emitted[0].content.tool).toBe("file_write");
      expect(emitted[0].content.guardsRan).toBeDefined();
    });

    it("reports elapsed time", async () => {
      const { orchestrator } = setup();
      const report = await orchestrator.postAction({
        tool: "file_write",
        input: { file_path: "src/x.ts" },
      });

      expect(report.elapsed).toBeGreaterThanOrEqual(0);
    });
  });

  describe("full lifecycle", () => {
    it("pre-message → execution (simulated) → post-action", async () => {
      const { orchestrator, librarian } = setup();

      // 1. Pre-message: auth task arrives
      const plan = await orchestrator.preMessage("Fix the JWT validation bug in auth middleware");
      expect(plan.layers.length).toBeGreaterThan(0);

      // 2. Hydrate context for the executor
      const context = await orchestrator.hydrate(plan);
      expect(context).toContain("JWT");

      // 3. Post-action: executor wrote a file
      const report = await orchestrator.postAction({
        tool: "file_write",
        input: { file_path: "src/auth/middleware.ts" },
        output: "function validate_jwt(token: string) { ... }",
        filesAffected: ["src/auth/middleware.ts"],
      });

      // Convention guard should have flagged snake_case
      expect(report.domainsChecked).toContain("convention");

      // 4. Librarian should have updated thread state throughout
      expect(librarian.state.inContext.length).toBeGreaterThan(0);
      expect(librarian.state.recentActivity.length).toBeGreaterThan(0);
    });
  });

  describe("compaction + rehydration invalidation", () => {
    it("marks plan as invalidated when a loaded layer gets evicted", async () => {
      const { orchestrator, signals } = setup();
      await orchestrator.preMessage("Fix the JWT validation in auth middleware");
      expect(orchestrator.isInvalidated).toBe(false);

      // Simulate eviction of a layer the plan depends on
      await signals.emit({
        id: "evict-1",
        kind: "context_evicted",
        source: "compaction",
        content: { layerId: "auth-conventions" },
        timestamp: Date.now(),
      });

      expect(orchestrator.isInvalidated).toBe(true);
      expect(orchestrator.pendingInvalidations).toHaveLength(1);
      expect(orchestrator.pendingInvalidations[0].reason).toBe("eviction");
      expect(orchestrator.pendingInvalidations[0].affectedLayers).toContain("auth-conventions");
    });

    it("marks plan as invalidated on compaction_done", async () => {
      const { orchestrator, signals } = setup();
      await orchestrator.preMessage("Fix the JWT validation in auth middleware");

      await signals.emit({
        id: "compact-1",
        kind: "compaction_done",
        source: "compaction-strategy",
        content: null,
        timestamp: Date.now(),
      });

      expect(orchestrator.isInvalidated).toBe(true);
      expect(orchestrator.pendingInvalidations[0].reason).toBe("compaction");
    });

    it("fires invalidation listener", async () => {
      const { orchestrator, signals } = setup();
      await orchestrator.preMessage("Fix the JWT validation in auth middleware");

      const events: any[] = [];
      orchestrator.onInvalidation((e) => events.push(e));

      await signals.emit({
        id: "evict-2",
        kind: "context_evicted",
        source: "compaction",
        content: { layerId: "security-patterns" },
        timestamp: Date.now(),
      });

      expect(events).toHaveLength(1);
      expect(events[0].reason).toBe("eviction");
    });

    it("refire() re-runs preMessage with the last message", async () => {
      const { orchestrator, signals } = setup();
      const original = await orchestrator.preMessage("Fix the JWT validation in auth middleware");
      expect(original.fresh).toBe(true);

      // Invalidate via compaction
      await signals.emit({
        id: "compact-2",
        kind: "compaction_done",
        source: "compaction-strategy",
        content: null,
        timestamp: Date.now(),
      });
      expect(orchestrator.isInvalidated).toBe(true);

      // Re-fire
      const refired = await orchestrator.refire();
      expect(refired).not.toBeNull();
      expect(refired!.fresh).toBe(false);
      expect(orchestrator.isInvalidated).toBe(false);
      expect(orchestrator.pendingInvalidations).toHaveLength(0);
    });

    it("refire() returns null if no previous message", async () => {
      const { orchestrator } = setup();
      const result = await orchestrator.refire();
      expect(result).toBeNull();
    });

    it("does NOT invalidate on its own context_loaded emissions", async () => {
      const { orchestrator } = setup();
      // preMessage emits context_loaded signals from "flow-orchestrator" source
      await orchestrator.preMessage("Fix the JWT validation in auth middleware");

      // Those self-emitted signals should not have invalidated the plan
      expect(orchestrator.isInvalidated).toBe(false);
    });

    it("preMessage clears invalidation state", async () => {
      const { orchestrator, signals } = setup();
      await orchestrator.preMessage("Fix the JWT validation in auth middleware");

      // Invalidate
      await signals.emit({
        id: "evict-3",
        kind: "context_evicted",
        source: "compaction",
        content: { layerId: "auth-conventions" },
        timestamp: Date.now(),
      });
      expect(orchestrator.isInvalidated).toBe(true);

      // New preMessage should clear the invalidation
      await orchestrator.preMessage("Fix auth middleware");
      expect(orchestrator.isInvalidated).toBe(false);
      expect(orchestrator.pendingInvalidations).toHaveLength(0);
    });

    it("dispose stops listening to invalidation signals", async () => {
      const { orchestrator, signals } = setup();
      await orchestrator.preMessage("Fix the JWT validation in auth middleware");

      orchestrator.dispose();

      await signals.emit({
        id: "evict-4",
        kind: "context_evicted",
        source: "compaction",
        content: { layerId: "auth-conventions" },
        timestamp: Date.now(),
      });

      // Should NOT be invalidated since we disposed
      expect(orchestrator.isInvalidated).toBe(false);
    });
  });
});
