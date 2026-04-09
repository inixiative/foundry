import { describe, test, expect } from "bun:test";
import { ToolRegistry } from "@inixiative/foundry-core";
import { BashShell } from "../src/tools/bash-shell";
import { BunScript } from "../src/tools/bun-script";
import { MemoryToolAdapter } from "../src/tools/memory-adapter";

describe("ToolRegistry dispatch + definitions", () => {
  const registry = new ToolRegistry();

  const shell = new BashShell({ id: "bash", cwd: "/tmp" });
  const script = new BunScript({ id: "script" });
  const mockBackend = {
    store: new Map<string, any>(),
    async write(entry: any) { this.store.set(entry.id, entry); },
    get(id: string) { return this.store.get(id); },
    search(q: string) { return [...this.store.values()].filter((e: any) => e.content.includes(q)); },
    all() { return [...this.store.values()]; },
    async delete(id: string) { return this.store.delete(id); },
  };
  const memory = new MemoryToolAdapter({ system: "test", backend: mockBackend });

  registry.register(shell, "Real shell");
  registry.register(script, "TypeScript runner");
  registry.register(memory, "Test memory");

  // -- toToolDefinitions --

  test("generates definitions for all tools", () => {
    const defs = registry.toToolDefinitions();
    expect(defs.length).toBeGreaterThan(0);

    const names = defs.map((d) => d.name);
    expect(names).toContain("bash_exec");
    expect(names).toContain("script_evaluate");
    expect(names).toContain("memory-test_search");
    expect(names).toContain("memory-test_get");
    expect(names).toContain("memory-test_write");
  });

  test("definitions have schemas", () => {
    const defs = registry.toToolDefinitions();
    const shellDef = defs.find((d) => d.name === "bash_exec")!;
    expect(shellDef.description).toContain("shell");
    expect(shellDef.inputSchema).toBeDefined();
    expect((shellDef.inputSchema as any).properties.command).toBeDefined();
  });

  // -- dispatch: shell --

  test("dispatches shell_exec", async () => {
    const result = await registry.dispatch("bash_exec", { command: "echo dispatched" });
    expect(result.ok).toBe(true);
    expect((result.data as any)?.stdout).toContain("dispatched");
  });

  // -- dispatch: memory --

  test("dispatches memory write + search", async () => {
    const writeResult = await registry.dispatch("memory-test_write", {
      id: "conv-1",
      kind: "convention",
      content: "Use snake_case",
    });
    expect(writeResult.ok).toBe(true);

    const searchResult = await registry.dispatch("memory-test_search", {
      query: "snake",
    });
    expect(searchResult.ok).toBe(true);
    expect((searchResult.data as any[])?.length).toBeGreaterThan(0);
  });

  test("dispatches memory get", async () => {
    const result = await registry.dispatch("memory-test_get", { id: "conv-1" });
    expect(result.ok).toBe(true);
    expect((result.data as any)?.content).toBe("Use snake_case");
  });

  // -- dispatch: script --

  test("dispatches script_evaluate", async () => {
    const result = await registry.dispatch("script_evaluate", {
      code: "return 2 + 2",
    });
    expect(result.ok).toBe(true);
    expect((result.data as any)?.result).toBe(4);
  });

  // -- dispatch: unknown --

  test("returns error for unknown tool", async () => {
    const result = await registry.dispatch("nonexistent_exec", { command: "ls" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No registered tool");
  });

  test("returns error for unknown method", async () => {
    const result = await registry.dispatch("bash_fly", { destination: "moon" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Method not found");
  });
});
