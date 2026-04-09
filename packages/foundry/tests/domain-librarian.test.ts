import { describe, it, expect, beforeEach } from "bun:test";
import {
  ContextLayer,
  SignalBus,
  type LLMProvider,
  type LLMMessage,
  type CompletionResult,
} from "@inixiative/foundry-core";
import {
  DomainLibrarian,
  type ToolObservation,
  type GuardFinding,
} from "../src/agents/domain-librarian";

// ---------------------------------------------------------------------------
// Mock LLM provider
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

function makeConventionLibrarian(llm: LLMProvider, signals: SignalBus) {
  const cache = new ContextLayer({ id: "convention-cache", trust: 0.8 });
  cache.set("Functions use camelCase. Files use kebab-case. No default exports.");
  return new DomainLibrarian({
    domain: "convention",
    cache,
    signals,
    llm,
    guardTriggers: ["file_write", "file_create"],
  });
}

function makeMemoryLibrarian(signals: SignalBus) {
  const cache = new ContextLayer({ id: "memory-cache", trust: 0.7 });
  cache.set(JSON.stringify([
    { pattern: "setTimeout.*0\\)", failure: "Race condition — setTimeout(0) is unreliable" },
    { pattern: "eval\\(", failure: "eval() is banned — use Function() if needed" },
  ]));
  return new DomainLibrarian({
    domain: "memory",
    cache,
    signals,
    llm: mockLLM("unused"),
    programmaticGuard: true,
    guardFn: (obs: ToolObservation, cacheContent: string): GuardFinding[] => {
      const patterns = JSON.parse(cacheContent) as Array<{ pattern: string; failure: string }>;
      const output = obs.output ?? "";
      const findings: GuardFinding[] = [];
      for (const p of patterns) {
        if (new RegExp(p.pattern).test(output)) {
          findings.push({
            severity: "advisory",
            description: p.failure,
            location: obs.input?.file_path as string,
          });
        }
      }
      return findings;
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DomainLibrarian", () => {
  let signals: SignalBus;

  beforeEach(() => {
    signals = new SignalBus();
  });

  describe("advise mode", () => {
    it("returns layers and snippets from LLM response", async () => {
      const llm = mockLLM(JSON.stringify({
        layers: ["auth-conventions", "auth-api-docs"],
        snippets: ["Use JWT for all API endpoints"],
        confidence: 0.9,
      }));
      const lib = makeConventionLibrarian(llm, signals);
      const result = await lib.advise("How should I handle auth tokens?");

      expect(result.layers).toEqual(["auth-conventions", "auth-api-docs"]);
      expect(result.snippets).toHaveLength(1);
      expect(result.confidence).toBe(0.9);
    });

    it("handles LLM response wrapped in code fence", async () => {
      const llm = mockLLM('```json\n{"layers": ["test-layer"], "snippets": [], "confidence": 0.8}\n```');
      const lib = makeConventionLibrarian(llm, signals);
      const result = await lib.advise("test message");

      expect(result.layers).toEqual(["test-layer"]);
      expect(result.confidence).toBe(0.8);
    });

    it("returns empty on LLM failure", async () => {
      const lib = makeConventionLibrarian(failingLLM(), signals);
      const result = await lib.advise("test message");

      expect(result.layers).toHaveLength(0);
      expect(result.confidence).toBe(0);
    });

    it("returns empty when cache is empty", async () => {
      const cache = new ContextLayer({ id: "empty-cache", trust: 0.5 });
      const lib = new DomainLibrarian({
        domain: "empty",
        cache,
        signals,
        llm: mockLLM("should not be called"),
      });
      const result = await lib.advise("test message");

      expect(result.layers).toHaveLength(0);
      expect(result.confidence).toBe(0);
    });

    it("includes thread state when provided", async () => {
      let capturedMessages: LLMMessage[] = [];
      const llm: LLMProvider = {
        id: "capture",
        async complete(messages): Promise<CompletionResult> {
          capturedMessages = messages;
          return { content: '{"layers":[],"snippets":[],"confidence":0.5}', model: "mock" };
        },
      };
      const lib = makeConventionLibrarian(llm, signals);
      await lib.advise("test", '{"domain":"auth"}');

      const userMsg = capturedMessages.find((m) => m.role === "user")!;
      expect(userMsg.content).toContain("Thread state");
      expect(userMsg.content).toContain("auth");
    });
  });

  describe("guard mode", () => {
    it("guards file_write observations", async () => {
      const llm = mockLLM(JSON.stringify({
        findings: [{
          severity: "advisory",
          description: "Function name uses snake_case, should be camelCase",
          location: "src/auth/service.ts:42",
          suggestion: "Rename get_user to getUser",
        }],
      }));
      const lib = makeConventionLibrarian(llm, signals);
      const result = await lib.guard({
        tool: "file_write",
        input: { file_path: "src/auth/service.ts" },
        output: "function get_user() { ... }",
      });

      expect(result.ran).toBe(true);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe("advisory");
      expect(result.findings[0].description).toContain("snake_case");
    });

    it("skips guard for non-matching tool types", async () => {
      const lib = makeConventionLibrarian(mockLLM("unused"), signals);
      const result = await lib.guard({
        tool: "file_read",
        input: { file_path: "src/auth/service.ts" },
      });

      expect(result.ran).toBe(false);
      expect(result.findings).toHaveLength(0);
    });

    it("emits signals for findings", async () => {
      const llm = mockLLM(JSON.stringify({
        findings: [{
          severity: "critical",
          description: "SQL injection risk",
          location: "src/db/query.ts:10",
        }],
      }));
      const lib = makeConventionLibrarian(llm, signals);

      const emitted: any[] = [];
      signals.onAny((s) => emitted.push(s));

      await lib.guard({
        tool: "file_write",
        input: { file_path: "src/db/query.ts" },
        output: "db.query(`SELECT * FROM users WHERE id = ${userId}`)",
      });

      expect(emitted).toHaveLength(1);
      expect(emitted[0].kind).toBe("security_concern");
      expect(emitted[0].source).toBe("convention-librarian");
    });

    it("emits correction signal for advisory findings", async () => {
      const llm = mockLLM(JSON.stringify({
        findings: [{
          severity: "advisory",
          description: "Missing JSDoc",
        }],
      }));
      const lib = makeConventionLibrarian(llm, signals);

      const emitted: any[] = [];
      signals.onAny((s) => emitted.push(s));

      await lib.guard({
        tool: "file_write",
        input: { file_path: "src/utils.ts" },
      });

      expect(emitted).toHaveLength(1);
      expect(emitted[0].kind).toBe("correction");
    });
  });

  describe("programmatic guard (Memory domain)", () => {
    it("runs pattern matching on every tool type", () => {
      const lib = makeMemoryLibrarian(signals);
      expect(lib.shouldGuard("file_write")).toBe(true);
      expect(lib.shouldGuard("file_read")).toBe(true);
      expect(lib.shouldGuard("bash")).toBe(true);
    });

    it("detects known failure patterns", async () => {
      const lib = makeMemoryLibrarian(signals);
      const result = await lib.guard({
        tool: "file_write",
        input: { file_path: "src/timer.ts" },
        output: "setTimeout(() => resolve(), 0)",
      });

      expect(result.ran).toBe(true);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].description).toContain("Race condition");
    });

    it("returns all-clear when no patterns match", async () => {
      const lib = makeMemoryLibrarian(signals);
      const result = await lib.guard({
        tool: "file_write",
        input: { file_path: "src/clean.ts" },
        output: "const x = 42;",
      });

      expect(result.ran).toBe(true);
      expect(result.findings).toHaveLength(0);
    });

    it("detects multiple patterns in same output", async () => {
      const lib = makeMemoryLibrarian(signals);
      const result = await lib.guard({
        tool: "file_write",
        input: { file_path: "src/bad.ts" },
        output: "eval(input); setTimeout(() => {}, 0)",
      });

      expect(result.ran).toBe(true);
      expect(result.findings).toHaveLength(2);
    });
  });
});
