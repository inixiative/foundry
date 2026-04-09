import { describe, test, expect } from "bun:test";
import { ToolRegistry } from "../src/tools";
import type { ScriptTool, MemoryTool, ApiTool, ToolResult } from "../src/tools";

// -- Fake tools for testing --

const fakeScript: ScriptTool = {
  id: "script",
  kind: "script",
  capability: "exec:process",
  async evaluate() {
    return { ok: true, data: { result: 42, logs: [], durationMs: 1 }, summary: "ok" };
  },
};

const fakeApi: ApiTool = {
  id: "github",
  kind: "api",
  capability: "net:api",
  async request() { return { ok: true, summary: "ok" } as any; },
  async get() { return { ok: true, summary: "ok" } as any; },
  async post() { return { ok: true, summary: "ok" } as any; },
  async put() { return { ok: true, summary: "ok" } as any; },
  async delete() { return { ok: true, summary: "ok" } as any; },
};

const fakeMemory: MemoryTool = {
  id: "memory-file",
  kind: "memory",
  system: "file",
  capabilities: {
    read: "data:read",
    write: "data:write",
    delete: "data:delete",
  },
  async search() { return { ok: true, data: [], summary: "ok" }; },
  async get() { return { ok: true, data: null, summary: "ok" }; },
  async recent() { return { ok: true, data: [], summary: "ok" }; },
  async write() { return { ok: true, data: { id: "x" }, summary: "ok" }; },
  async delete() { return { ok: true, data: { deleted: true }, summary: "ok" }; },
};

describe("ToolRegistry", () => {
  test("starts empty", () => {
    const reg = new ToolRegistry();
    expect(reg.size).toBe(0);
    expect(reg.list()).toEqual([]);
    expect(reg.summary()).toBe("No tools available.");
  });

  test("register and get", () => {
    const reg = new ToolRegistry();
    reg.register(fakeScript, "Run TypeScript");
    expect(reg.size).toBe(1);
    expect(reg.get("script")).toBe(fakeScript);
  });

  test("get with generic type", () => {
    const reg = new ToolRegistry();
    reg.register(fakeScript, "Run TypeScript");
    const tool = reg.get<ScriptTool>("script");
    expect(tool?.kind).toBe("script");
  });

  test("get returns undefined for missing", () => {
    const reg = new ToolRegistry();
    expect(reg.get("nope")).toBeUndefined();
  });

  test("unregister", () => {
    const reg = new ToolRegistry();
    reg.register(fakeScript, "Run TypeScript");
    reg.unregister("script");
    expect(reg.size).toBe(0);
    expect(reg.get("script")).toBeUndefined();
  });

  test("byKind returns first match", () => {
    const reg = new ToolRegistry();
    reg.register(fakeScript, "Run TypeScript");
    reg.register(fakeApi, "GitHub API");
    expect(reg.byKind("script")).toBe(fakeScript);
    expect(reg.byKind("api")).toBe(fakeApi);
    expect(reg.byKind("browser")).toBeUndefined();
  });

  test("allByKind returns all of that kind", () => {
    const reg = new ToolRegistry();
    const fakeScript2: ScriptTool = { ...fakeScript, id: "script-2" };
    reg.register(fakeScript, "Script 1");
    reg.register(fakeScript2, "Script 2");
    reg.register(fakeApi, "API");
    const scripts = reg.allByKind("script");
    expect(scripts.length).toBe(2);
  });

  test("list returns ToolInfo for all tools", () => {
    const reg = new ToolRegistry();
    reg.register(fakeScript, "Run TypeScript");
    reg.register(fakeApi, "GitHub API");
    const list = reg.list();
    expect(list.length).toBe(2);
    expect(list[0].id).toBe("script");
    expect(list[0].kind).toBe("script");
    expect(list[0].description).toBe("Run TypeScript");
    expect(list[0].capabilities).toContain("exec:process");
  });

  test("memory tool registers multiple capabilities", () => {
    const reg = new ToolRegistry();
    reg.register(fakeMemory, "Project memory");
    const info = reg.list()[0];
    expect(info.capabilities).toContain("data:read");
    expect(info.capabilities).toContain("data:write");
    expect(info.capabilities).toContain("data:delete");
  });

  test("listWithCapability filters correctly", () => {
    const reg = new ToolRegistry();
    reg.register(fakeScript, "Run TypeScript");
    reg.register(fakeApi, "GitHub API");
    reg.register(fakeMemory, "Memory");

    const execTools = reg.listWithCapability("exec:process");
    expect(execTools.length).toBe(1);
    expect(execTools[0].id).toBe("script");

    const dataTools = reg.listWithCapability("data:read");
    expect(dataTools.length).toBe(1);
    expect(dataTools[0].id).toBe("memory-file");
  });

  test("summary returns compact format", () => {
    const reg = new ToolRegistry();
    reg.register(fakeScript, "Run TypeScript");
    reg.register(fakeApi, "GitHub API");
    const summary = reg.summary();
    expect(summary).toContain("- script (script): Run TypeScript");
    expect(summary).toContain("- github (api): GitHub API");
  });

  test("register overwrites existing tool with same id", () => {
    const reg = new ToolRegistry();
    reg.register(fakeScript, "V1");
    reg.register(fakeScript, "V2");
    expect(reg.size).toBe(1);
    expect(reg.list()[0].description).toBe("V2");
  });
});
