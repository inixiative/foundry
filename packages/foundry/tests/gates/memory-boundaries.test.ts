import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMemory, ToolRegistry } from "@inixiative/foundry-core";
import { MemoryToolAdapter } from "../../src/tools/memory-adapter";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "foundry-memory-gate-"));
  dirs.push(dir);
  const memory = new FileMemory(dir);
  await memory.load();
  const tools = new ToolRegistry();
  tools.register(MemoryToolAdapter.fromFileMemory(memory), "Memory");
  const a = { threadId: "a", projectId: "P" };
  const b = { threadId: "b", projectId: "P" };
  await memory.view(a).write({ id: "private-a", kind: "convention", content: "ONLY-A", timestamp: 1 });
  return { dir, memory, tools, a, b };
}

test("G1: persisted private records remain isolated through source and tool reads", async () => {
  const { dir, a, b } = await setup();
  const memory = new FileMemory(dir);
  await memory.load();
  const source = memory.asSource("memory");
  expect(await source.bind!(a).load()).toContain("ONLY-A");
  expect(await source.bind!(b).load()).not.toContain("ONLY-A");
  const other = MemoryToolAdapter.fromFileMemory(memory).scoped(b);
  expect((await other.get("private-a")).data).toBeNull();
  expect((await other.search("ONLY-A")).data).toEqual([]);
});

test("G1: a tool cannot overwrite another thread's invisible record", async () => {
  const { memory, tools, a, b } = await setup();
  const result = await tools.dispatch("memory-file_write", {
    id: "private-a", kind: "convention", content: "REPLACED-B", visibility: "global",
  }, { scope: b });
  expect(result.ok).toBe(false);
  expect(memory.get("private-a")).toMatchObject({ content: "ONLY-A", owner: a, visibility: "thread" });
});

test("G1: publication grants reading, not cross-owner deletion", async () => {
  const { memory, a, b } = await setup();
  await memory.publish("private-a", "global");
  const other = MemoryToolAdapter.fromFileMemory(memory).scoped(b);
  expect((await other.get("private-a")).data?.content).toBe("ONLY-A");
  await other.delete("private-a");
  expect(memory.get("private-a")).toMatchObject({ owner: a, content: "ONLY-A" });
});

test("G1: matching thread IDs do not override a different project owner", async () => {
  const { memory } = await setup();
  const moved = { threadId: "a", projectId: "Q" };
  expect(await memory.asSource("memory").bind!(moved).load()).not.toContain("ONLY-A");
  expect(memory.view(moved).get("private-a")).toBeUndefined();
});

test("G1: scoped tool results cannot mutate another owner's published record by reference", async () => {
  const { memory, b } = await setup();
  await memory.publish("private-a", "global");
  const result = await MemoryToolAdapter.fromFileMemory(memory).scoped(b).get("private-a");
  expect(result.data).not.toBeNull();
  result.data!.content = "MUTATED-B";
  expect(memory.get("private-a")?.content).toBe("ONLY-A");
});
