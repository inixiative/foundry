import { describe, it, expect, beforeEach } from "bun:test";
import {
  ContextLayer,
  ContextStack,
  SignalBus,
  type LLMProvider,
  type CompletionResult,
} from "@inixiative/foundry-core";
import { Cartographer } from "../src/agents/cartographer";

// ---------------------------------------------------------------------------
// Mock LLM
// ---------------------------------------------------------------------------

function mockLLM(response: string): LLMProvider {
  return {
    id: "mock",
    async complete(): Promise<CompletionResult> {
      return { content: response, model: "mock" };
    },
  };
}

function failingLLM(): LLMProvider {
  return {
    id: "failing",
    async complete(): Promise<CompletionResult> {
      throw new Error("LLM unavailable");
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStack() {
  const authConventions = new ContextLayer({ id: "auth-conventions", trust: 0.8 });
  authConventions.set("Use JWT for API auth. Rotate keys every 30 days.");

  const authDocs = new ContextLayer({ id: "auth-api-docs", trust: 0.7 });
  authDocs.set("API endpoints: POST /login, POST /refresh, DELETE /logout");

  const securityPatterns = new ContextLayer({ id: "security-patterns", trust: 0.9 });
  securityPatterns.set("OWASP top 10. SQL injection prevention. XSS sanitization.");

  const testPatterns = new ContextLayer({ id: "testing-patterns", trust: 0.6 });
  testPatterns.set("Use bun:test. Fixtures in tests/fixtures/. Mock external APIs.");

  const archRules = new ContextLayer({ id: "architecture-boundaries", trust: 0.7 });
  archRules.set("Module boundaries: auth/ cannot import from payments/.");

  return new ContextStack([authConventions, authDocs, securityPatterns, testPatterns, archRules]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Cartographer", () => {
  let signals: SignalBus;
  let stack: ContextStack;

  beforeEach(() => {
    signals = new SignalBus();
    stack = makeStack();
  });

  describe("map building", () => {
    it("builds a map from stack layers", () => {
      const carto = new Cartographer({ stack, signals, llm: mockLLM("") });
      const map = carto.buildMap();

      expect(map.entries.length).toBeGreaterThan(0);
      expect(map.lastBuilt).toBeGreaterThan(0);
    });

    it("groups layers by inferred domain", () => {
      const carto = new Cartographer({ stack, signals, llm: mockLLM("") });
      const map = carto.buildMap();

      const authEntry = map.entries.find((e) => e.domain === "auth");
      expect(authEntry).toBeDefined();
      expect(authEntry!.layers).toContain("auth-conventions");
      expect(authEntry!.layers).toContain("auth-api-docs");
    });

    it("uses explicit domain map when provided", () => {
      const carto = new Cartographer({
        stack,
        signals,
        llm: mockLLM(""),
        domainMap: {
          "security": ["security-patterns", "auth-conventions"],
          "testing": ["testing-patterns"],
        },
      });
      const map = carto.buildMap();

      const secEntry = map.entries.find((e) => e.domain === "security");
      expect(secEntry).toBeDefined();
      expect(secEntry!.layers).toContain("security-patterns");
      expect(secEntry!.layers).toContain("auth-conventions");
    });

    it("skips internal layers (prefixed with __)", () => {
      // Add a thread-state layer (internal)
      const internal = new ContextLayer({ id: "__thread-state", trust: 1.0 });
      internal.set("internal state");
      stack.addLayer(internal, 0);

      const carto = new Cartographer({ stack, signals, llm: mockLLM("") });
      const map = carto.buildMap();

      const internalEntry = map.entries.find((e) =>
        e.layers.some((l) => l.startsWith("__"))
      );
      expect(internalEntry).toBeUndefined();
    });

    it("writes map to its map layer", () => {
      const carto = new Cartographer({ stack, signals, llm: mockLLM("") });
      carto.buildMap();

      const content = carto.mapLayer.content;
      expect(content).toBeTruthy();
      const parsed = JSON.parse(content);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
    });

    it("rebuilds on context_loaded signal", async () => {
      const carto = new Cartographer({ stack, signals, llm: mockLLM("") });
      carto.buildMap();
      const firstBuild = carto.map.lastBuilt;

      // Wait a tick so timestamp differs
      await new Promise((r) => setTimeout(r, 5));

      await signals.emit({
        id: "sig-1",
        kind: "context_loaded",
        source: "test",
        content: { layerId: "new-layer" },
        timestamp: Date.now(),
      });

      expect(carto.map.lastBuilt).toBeGreaterThan(firstBuild);
    });
  });

  describe("routing", () => {
    it("routes a message to matching layers via LLM", async () => {
      const llm = mockLLM(JSON.stringify({
        layers: ["auth-conventions", "security-patterns"],
        domains: ["auth", "security"],
        confidence: 0.85,
      }));
      const carto = new Cartographer({ stack, signals, llm });
      carto.buildMap();

      const result = await carto.route("Fix the JWT validation in the auth middleware");

      expect(result.layers).toContain("auth-conventions");
      expect(result.layers).toContain("security-patterns");
      expect(result.domains).toContain("auth");
      expect(result.confidence).toBe(0.85);
    });

    it("falls back to keyword matching when LLM fails", async () => {
      const carto = new Cartographer({ stack, signals, llm: failingLLM() });
      carto.buildMap();

      const result = await carto.route("Fix the auth middleware");

      expect(result.layers.length).toBeGreaterThan(0);
      expect(result.domains).toContain("auth");
      expect(result.confidence).toBe(0.3); // keyword fallback confidence
    });

    it("auto-builds map if not yet built", async () => {
      const llm = mockLLM(JSON.stringify({
        layers: ["testing-patterns"],
        domains: ["testing"],
        confidence: 0.7,
      }));
      const carto = new Cartographer({ stack, signals, llm });
      // Don't call buildMap() — route should do it

      const result = await carto.route("How should I write tests?");
      expect(result.layers).toContain("testing-patterns");
    });

    it("returns empty when map is empty (no layers)", async () => {
      const emptyStack = new ContextStack([]);
      const carto = new Cartographer({ stack: emptyStack, signals, llm: mockLLM("") });
      const result = await carto.route("anything");

      expect(result.layers).toHaveLength(0);
      expect(result.confidence).toBe(0);
    });

    it("includes thread state in routing prompt", async () => {
      let capturedContent = "";
      const llm: LLMProvider = {
        id: "capture",
        async complete(messages): Promise<CompletionResult> {
          capturedContent = messages.find((m) => m.role === "user")?.content ?? "";
          return { content: '{"layers":[],"domains":[],"confidence":0.5}', model: "mock" };
        },
      };
      const carto = new Cartographer({ stack, signals, llm });
      carto.buildMap();
      await carto.route("test", '{"domain":"auth","flags":["security-concern-active"]}');

      expect(capturedContent).toContain("thread state");
      expect(capturedContent).toContain("security-concern-active");
    });
  });

  describe("lifecycle", () => {
    it("dispose stops listening to signals", async () => {
      const carto = new Cartographer({ stack, signals, llm: mockLLM("") });
      carto.buildMap();
      const firstBuild = carto.map.lastBuilt;

      carto.dispose();
      await new Promise((r) => setTimeout(r, 5));

      await signals.emit({
        id: "sig-2",
        kind: "context_loaded",
        source: "test",
        content: { layerId: "new" },
        timestamp: Date.now(),
      });

      // Map should NOT have been rebuilt
      expect(carto.map.lastBuilt).toBe(firstBuild);
    });
  });
});
