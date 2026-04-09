import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { FileMemory, fileSource, inlineSource } from "../src/adapters/file-memory";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = "/tmp/foundry-test-memory-" + Date.now();

afterEach(() => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
});

describe("FileMemory", () => {
  test("creates directory if it doesn't exist", () => {
    const mem = new FileMemory(TEST_DIR);
    expect(existsSync(TEST_DIR)).toBe(true);
  });

  test("write and get", async () => {
    const mem = new FileMemory(TEST_DIR);
    await mem.write({
      id: "conv-1",
      kind: "convention",
      content: "Use Zod for validation",
      timestamp: Date.now(),
    });

    const entry = mem.get("conv-1");
    expect(entry).toBeDefined();
    expect(entry!.content).toBe("Use Zod for validation");
    expect(entry!.kind).toBe("convention");
  });

  test("write persists to disk", async () => {
    const mem = new FileMemory(TEST_DIR);
    await mem.write({
      id: "test",
      kind: "test",
      content: "hello",
      timestamp: Date.now(),
    });

    // File should exist
    const path = join(TEST_DIR, "test.json");
    expect(existsSync(path)).toBe(true);
  });

  test("load reads from disk", async () => {
    const mem1 = new FileMemory(TEST_DIR);
    await mem1.write({
      id: "test",
      kind: "test",
      content: "hello",
      timestamp: Date.now(),
    });

    // New instance, load from disk
    const mem2 = new FileMemory(TEST_DIR);
    await mem2.load();
    const entry = mem2.get("test");
    expect(entry).toBeDefined();
    expect(entry!.content).toBe("hello");
  });

  test("all returns entries, optionally filtered", async () => {
    const mem = new FileMemory(TEST_DIR);
    await mem.write({ id: "a", kind: "convention", content: "A", timestamp: 1 });
    await mem.write({ id: "b", kind: "correction", content: "B", timestamp: 2 });
    await mem.write({ id: "c", kind: "convention", content: "C", timestamp: 3 });

    expect(mem.all().length).toBe(3);
    expect(mem.all("convention").length).toBe(2);
    expect(mem.all("correction").length).toBe(1);
  });

  test("search by content substring", async () => {
    const mem = new FileMemory(TEST_DIR);
    await mem.write({ id: "a", kind: "test", content: "Use TypeScript", timestamp: 1 });
    await mem.write({ id: "b", kind: "test", content: "Use JavaScript", timestamp: 2 });

    const results = mem.search("typescript");
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("a");
  });

  test("delete removes from memory and disk", async () => {
    const mem = new FileMemory(TEST_DIR);
    await mem.write({ id: "del", kind: "test", content: "gone", timestamp: 1 });

    expect(await mem.delete("del")).toBe(true);
    expect(mem.get("del")).toBeUndefined();
    expect(existsSync(join(TEST_DIR, "del.json"))).toBe(false);
  });

  test("delete returns false for missing", async () => {
    const mem = new FileMemory(TEST_DIR);
    expect(await mem.delete("nonexistent")).toBe(false);
  });

  test("path traversal is prevented", async () => {
    const mem = new FileMemory(TEST_DIR);
    await mem.write({
      id: "../../etc/passwd",
      kind: "test",
      content: "harmless",
      timestamp: 1,
    });

    // Should be sanitized — file should be inside TEST_DIR
    const entries = mem.all();
    expect(entries.length).toBe(1);
    // The file should NOT exist at ../../etc/passwd.json relative to TEST_DIR
    expect(existsSync("/tmp/etc/passwd.json")).toBe(false);
  });

  test("asSource loads entries", async () => {
    const mem = new FileMemory(TEST_DIR);
    await mem.write({ id: "a", kind: "convention", content: "Conv A", timestamp: 1 });
    await mem.write({ id: "b", kind: "other", content: "Other B", timestamp: 2 });

    const src = mem.asSource("test-src", "convention");
    const content = await src.load();
    expect(content).toContain("Conv A");
    expect(content).not.toContain("Other B");
  });

  test("asAdapter hydrates by entry id", async () => {
    const mem = new FileMemory(TEST_DIR);
    await mem.write({ id: "entry-1", kind: "test", content: "hydrated content", timestamp: 1 });

    const adapter = mem.asAdapter();
    expect(adapter.system).toBe("file-memory");
    const content = await adapter.hydrate({ system: "file-memory", locator: "entry-1" });
    expect(content).toBe("hydrated content");
  });

  test("asAdapter returns empty for missing", async () => {
    const mem = new FileMemory(TEST_DIR);
    await mem.load();
    const adapter = mem.asAdapter();
    const content = await adapter.hydrate({ system: "file-memory", locator: "missing" });
    expect(content).toBe("");
  });

  test("signalWriter persists signals as entries", async () => {
    const mem = new FileMemory(TEST_DIR);
    const writer = mem.signalWriter();

    await writer({
      id: "sig-1",
      kind: "correction",
      source: "operator:test",
      content: { actual: "X", correction: "Y" },
      confidence: 1.0,
      timestamp: Date.now(),
    });

    const entry = mem.get("sig-1");
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("correction");
  });
});

describe("fileSource", () => {
  test("reads file content", async () => {
    const path = join(TEST_DIR, "test.txt");
    const mem = new FileMemory(TEST_DIR); // ensure dir exists
    await Bun.write(path, "file content here");

    const src = fileSource("test", path);
    const content = await src.load();
    expect(content).toBe("file content here");
  });

  test("returns empty for missing file", async () => {
    const src = fileSource("test", "/tmp/nonexistent-file-12345.txt");
    const content = await src.load();
    expect(content).toBe("");
  });
});

describe("inlineSource", () => {
  test("returns static content", async () => {
    const src = inlineSource("test", "static content");
    expect(await src.load()).toBe("static content");
  });
});
