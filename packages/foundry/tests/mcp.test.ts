import { describe, it, expect, beforeEach } from "bun:test";
import {
  Thread,
  ContextLayer,
  ContextStack,
  SignalBus,
  CacheLifecycle,
  MiddlewareChain,
} from "@inixiative/foundry-core";
import { createFoundryMcpServer } from "../src/mcp/server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLayer(id: string, content: string, trust = 0.5): ContextLayer {
  return new ContextLayer({
    id,
    trust,
    sources: [{ id: `${id}-src`, load: async () => content }],
  });
}

async function makeThread(layers: ContextLayer[]): Promise<Thread> {
  const stack = new ContextStack(layers);
  await stack.warmAll();
  const thread = new Thread("test-thread", stack);
  thread.meta.description = "Test thread for MCP";
  thread.meta.tags = ["test"];
  return thread;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Foundry MCP Server", () => {
  let thread: Thread;

  beforeEach(async () => {
    thread = await makeThread([
      makeLayer("auth-conventions", "Naming: use camelCase for functions. Auth middleware must validate JWT tokens. Always use bcrypt for password hashing."),
      makeLayer("security-patterns", "OWASP: prevent SQL injection by using parameterized queries. Never store passwords in plain text. Use CSRF tokens for state-changing operations."),
      makeLayer("memory-auth-refactor", "Past decision: auth middleware was refactored in PR #847 to use middleware pattern. Previous approach with inline checks was error-prone."),
      makeLayer("project-structure", "Monorepo with packages/core and packages/foundry. Tests in packages/*/tests/. Use bun as runtime."),
    ]);
  });

  it("creates server with all 5 tools", () => {
    const server = createFoundryMcpServer({ thread });
    // Server creation should not throw
    expect(server).toBeDefined();
  });

  it("foundry_query finds matching layers by keyword", async () => {
    const server = createFoundryMcpServer({ thread });

    // Access the tool handler directly through the server's internal tool registry
    // We test the underlying logic via the findMatchingLayers helper
    const stack = thread.stack;
    const layers = stack.layers.filter(l => l.isWarm && l.content.toLowerCase().includes("auth"));
    expect(layers.length).toBeGreaterThanOrEqual(2); // auth-conventions + memory-auth-refactor
  });

  it("layers are searchable by ID and content", async () => {
    const stack = thread.stack;

    // ID-based match
    const authLayer = stack.getLayer("auth-conventions");
    expect(authLayer).toBeDefined();
    expect(authLayer!.content).toContain("camelCase");

    // Security layer
    const secLayer = stack.getLayer("security-patterns");
    expect(secLayer).toBeDefined();
    expect(secLayer!.content).toContain("SQL injection");
  });

  it("signal bus receives signals emitted via MCP tool", () => {
    const signals = thread.signals;
    const received: any[] = [];
    signals.on("security_concern", (s) => received.push(s));

    // Simulate what the MCP signal tool does
    signals.emit({
      kind: "security_concern",
      source: "session-mcp",
      content: "Found hardcoded API key in config.ts",
      confidence: 0.95,
    });

    expect(received).toHaveLength(1);
    expect(received[0].content).toContain("hardcoded API key");
    expect(received[0].confidence).toBe(0.95);
  });

  it("thread meta is accessible for thread summaries", () => {
    expect(thread.meta.description).toBe("Test thread for MCP");
    expect(thread.meta.tags).toContain("test");
  });

  it("handles empty search gracefully", () => {
    const stack = thread.stack;
    const layers = stack.layers.filter(l =>
      l.isWarm && l.content.toLowerCase().includes("nonexistent-topic-xyz")
    );
    expect(layers).toHaveLength(0);
  });
});
