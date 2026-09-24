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

  test("asSource loads entries visible to the bound scope, filtered by kind", async () => {
    const mem = new FileMemory(TEST_DIR);
    const view = mem.view({ threadId: "t1", projectId: "p1" });
    await view.write({ id: "a", kind: "convention", content: "Conv A", timestamp: 1 });
    await view.write({ id: "b", kind: "other", content: "Other B", timestamp: 2 });

    const src = mem.asSource("test-src", "convention");
    expect(await src.load()).toBe("");
    const content = await src.bind!({ threadId: "t1", projectId: "p1" }).load();
    expect(content).toContain("Conv A");
    expect(content).not.toContain("Other B");
    expect(await src.bind!({ threadId: "t2", projectId: "p1" }).load()).toBe("");
  });

  test("unbound and global sources expose only globally published entries", async () => {
    const mem = new FileMemory(TEST_DIR);
    const view = mem.view({ threadId: "t1", projectId: "p1" });
    await view.write({ id: "private", kind: "note", content: "PRIVATE", timestamp: 1 });
    await view.write({ id: "project", kind: "note", content: "PROJECT", visibility: "project", timestamp: 2 });
    await view.write({ id: "global", kind: "note", content: "GLOBAL", visibility: "global", timestamp: 3 });

    expect(await mem.asSource("s").load()).toBe("[note] global: GLOBAL");
    const global = mem.asSource("s", { scope: "global" }).bind!({ threadId: "t1", projectId: "p1" });
    expect(await global.load()).toBe("[note] global: GLOBAL");
    const project = mem.asSource("s", { scope: "project" }).bind!({ threadId: "t1", projectId: "p1" });
    expect(await project.load()).toBe("[note] global: GLOBAL\n[note] project: PROJECT");
    const other = mem.asSource("s").bind!({ threadId: "t9", projectId: "p2" });
    expect(await other.load()).toBe("[note] global: GLOBAL");
  });

  test("view scopes reads, owns writes and refuses invisible deletes", async () => {
    const mem = new FileMemory(TEST_DIR);
    const a = mem.view({ threadId: "a", projectId: "p" });
    const b = mem.view({ threadId: "b", projectId: "p" });
    await a.write({ id: "x", kind: "note", content: "from a", timestamp: 1 });

    expect(mem.get("x")).toMatchObject({ owner: { threadId: "a", projectId: "p" }, visibility: "thread" });
    expect(a.get("x")?.content).toBe("from a");
    expect(b.get("x")).toBeUndefined();
    expect(b.search("from")).toEqual([]);
    expect(b.recent()).toEqual([]);
    expect(await b.delete("x")).toBe(false);
    expect(mem.get("x")).toBeDefined();
    expect(await a.delete("x")).toBe(true);
    expect(mem.get("x")).toBeUndefined();

    await expect(mem.view({}).write({ id: "y", kind: "note", content: "no owner", timestamp: 1 })).rejects.toThrow();
    await expect(mem.view({ threadId: "a" }).write({ id: "y", kind: "note", content: "no project", visibility: "project", timestamp: 1 })).rejects.toThrow();
  });

  test("publish widens visibility without changing the owner", async () => {
    const mem = new FileMemory(TEST_DIR);
    await mem.view({ threadId: "a", projectId: "p" }).write({ id: "x", kind: "note", content: "shared later", timestamp: 1 });
    const published = await mem.publish("x", "project");
    expect(published).toMatchObject({ owner: { threadId: "a", projectId: "p" }, visibility: "project" });
    expect(mem.view({ threadId: "b", projectId: "p" }).get("x")).toBeDefined();
    expect(mem.view({ threadId: "c", projectId: "q" }).get("x")).toBeUndefined();

    const reloaded = new FileMemory(TEST_DIR);
    await reloaded.load();
    expect(reloaded.get("x")?.visibility).toBe("project");
    await expect(mem.publish("missing", "global")).rejects.toThrow();
  });

  test("legacy entries without ownership are hidden unless a reader opts in", async () => {
    const mem = new FileMemory(TEST_DIR);
    await mem.write({ id: "legacy", kind: "note", content: "old", timestamp: 1 });
    expect(mem.view({ threadId: "a", projectId: "p" }).all()).toEqual([]);
    expect(mem.view({ threadId: "a", projectId: "p", includeUnowned: true }).all()).toHaveLength(1);
    expect(await mem.asSource("s", { includeUnowned: true }).load()).toContain("old");
    expect(await mem.asSource("s").load()).toBe("");
  });

  test("signalWriter records the owner it is given and hides unowned signals", async () => {
    const mem = new FileMemory(TEST_DIR);
    const write = mem.signalWriter();
    const signal = { id: "sig", kind: "correction", source: "user", content: { note: "x" }, timestamp: 5 };
    await write(signal, { threadId: "a", projectId: "p" });
    expect(mem.get("sig")).toMatchObject({ owner: { threadId: "a", projectId: "p" }, visibility: "thread", content: '{"note":"x"}' });
    await write({ ...signal, id: "orphan" });
    expect(mem.get("orphan")?.owner).toBeUndefined();
    expect(mem.view({ threadId: "a", projectId: "p" }).get("orphan")).toBeUndefined();
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

describe("FileMemory ownership", () => {
  test("bound source adds the thread's captures and project publications only", async () => {
    const mem = new FileMemory(TEST_DIR);
    const writer = mem.signalWriter();
    const sig = (id: string, content: string) => ({ id, kind: "note", source: "test", content, timestamp: 1 });
    await writer(sig("mine", "MINE"), { threadId: "a", projectId: "P" });
    await writer(sig("theirs", "THEIRS"), { threadId: "b", projectId: "P" });
    await writer(sig("other-project", "OTHER-PROJECT"), { threadId: "q", projectId: "Q" });
    await mem.view({ threadId: "b", projectId: "P" }).write({ id: "pub", kind: "note", content: "PUBLISHED-P", visibility: "project", timestamp: 1 });
    await mem.write({ id: "global", kind: "note", content: "GLOBAL", timestamp: 1, visibility: "global" });

    const bound = mem.asSource("mem").bind!({ threadId: "a", projectId: "P" });
    const content = await bound.load();
    expect(content).toContain("MINE");
    expect(content).toContain("PUBLISHED-P");
    expect(content).toContain("GLOBAL");
    expect(content).not.toContain("THEIRS");
    expect(content).not.toContain("OTHER-PROJECT");

    const projectOnly = mem.asSource("mem", { scope: "project" }).bind!({ threadId: "a", projectId: "P" });
    expect(await projectOnly.load()).not.toContain("MINE");
    expect(await projectOnly.load()).toContain("PUBLISHED-P");

    const globalOnly = mem.asSource("mem", { scope: "global" }).bind!({ threadId: "a", projectId: "P" });
    expect(await globalOnly.load()).toBe("[note] global: GLOBAL");
  });

  test("legacy unowned entries are preserved and only visible with includeUnowned", async () => {
    const mem = new FileMemory(TEST_DIR);
    await mem.write({ id: "legacy", kind: "note", content: "LEGACY", timestamp: 1 });
    expect(mem.get("legacy")?.owner).toBeUndefined();
    expect(mem.view({ threadId: "a", projectId: "P" }).all()).toHaveLength(0);
    expect(mem.view({ threadId: "a", projectId: "P", includeUnowned: true }).all().map((e) => e.id)).toEqual(["legacy"]);

    const hidden = mem.asSource("mem").bind!({ threadId: "a" });
    expect(await hidden.load()).toBe("");
    const optedIn = mem.asSource("mem", { includeUnowned: true }).bind!({ threadId: "a" });
    expect(await optedIn.load()).toContain("LEGACY");
  });

  test("publishing widens visibility explicitly and never changes the owner", async () => {
    const mem = new FileMemory(TEST_DIR);
    await mem.signalWriter()({ id: "s", kind: "note", source: "t", content: "S", timestamp: 1 }, { threadId: "a", projectId: "P" });
    expect(mem.view({ threadId: "b", projectId: "P" }).get("s")).toBeUndefined();

    await mem.publish("s", "project");
    expect(mem.view({ threadId: "b", projectId: "P" }).get("s")?.content).toBe("S");
    expect(mem.view({ threadId: "q", projectId: "Q" }).get("s")).toBeUndefined();
    expect(mem.get("s")?.owner).toEqual({ threadId: "a", projectId: "P" });

    await mem.publish("s", "global");
    expect(mem.view({ threadId: "q", projectId: "Q" }).get("s")?.content).toBe("S");

    await mem.signalWriter()({ id: "unowned", kind: "note", source: "t", content: "U", timestamp: 1 });
    await expect(mem.publish("unowned", "project")).rejects.toThrow(/no project owner/);
  });

  test("scoped views cannot write private entries without an owner or delete what they cannot see", async () => {
    const mem = new FileMemory(TEST_DIR);
    await expect(mem.view({}).write({ id: "x", kind: "note", content: "X", timestamp: 1 })).rejects.toThrow(/without a thread scope/);
    await expect(mem.view({ threadId: "a" }).write({ id: "x", kind: "note", content: "X", timestamp: 1, visibility: "project" })).rejects.toThrow(/without a project scope/);

    await mem.view({ threadId: "a", projectId: "P" }).write({ id: "a-private", kind: "note", content: "A", timestamp: 1 });
    expect(await mem.view({ threadId: "b", projectId: "P" }).delete("a-private")).toBe(false);
    expect(mem.get("a-private")).toBeDefined();
    expect(await mem.view({ threadId: "a", projectId: "P" }).delete("a-private")).toBe(true);
    expect(mem.get("a-private")).toBeUndefined();
  });

  test("a scoped write cannot overwrite a record it does not own", async () => {
    const mem = new FileMemory(TEST_DIR);
    const a = mem.view({ threadId: "a", projectId: "P" });
    const b = mem.view({ threadId: "b", projectId: "P" });
    await a.write({ id: "rec", kind: "note", content: "A", timestamp: 1 });

    await expect(b.write({ id: "rec", kind: "note", content: "B", timestamp: 2, visibility: "global" })).rejects.toThrow(/Cannot overwrite/);
    await mem.publish("rec", "global");
    await expect(b.write({ id: "rec", kind: "note", content: "B", timestamp: 2, visibility: "global" })).rejects.toThrow(/Cannot overwrite/);
    expect(mem.get("rec")).toMatchObject({ content: "A", owner: { threadId: "a", projectId: "P" } });

    await mem.write({ id: "legacy", kind: "note", content: "L", timestamp: 1 });
    await expect(b.write({ id: "legacy", kind: "note", content: "B", timestamp: 2 })).rejects.toThrow(/Cannot overwrite/);
    expect(mem.get("legacy")?.content).toBe("L");

    await a.write({ id: "rec", kind: "note", content: "A2", timestamp: 3 });
    expect(mem.get("rec")?.content).toBe("A2");
  });

  test("publication grants reading but deletion still requires ownership", async () => {
    const mem = new FileMemory(TEST_DIR);
    await mem.view({ threadId: "a", projectId: "P" }).write({ id: "rec", kind: "note", content: "A", timestamp: 1 });
    await mem.publish("rec", "global");
    const b = mem.view({ threadId: "b", projectId: "P" });
    expect(b.get("rec")?.content).toBe("A");
    expect(await b.delete("rec")).toBe(false);
    expect(mem.get("rec")).toBeDefined();
  });

  test("thread visibility requires the owner's project to match", async () => {
    const mem = new FileMemory(TEST_DIR);
    await mem.view({ threadId: "a", projectId: "P" }).write({ id: "rec", kind: "note", content: "A", timestamp: 1 });
    expect(mem.view({ threadId: "a", projectId: "Q" }).get("rec")).toBeUndefined();
    expect(await mem.asSource("mem").bind!({ threadId: "a", projectId: "Q" }).load()).toBe("");
    expect(mem.view({ threadId: "a", projectId: "P" }).get("rec")?.content).toBe("A");
  });

  test("scoped reads return copies, never the stored record", async () => {
    const mem = new FileMemory(TEST_DIR);
    await mem.view({ threadId: "a", projectId: "P" }).write({ id: "rec", kind: "note", content: "A", timestamp: 1, meta: { n: 1 } });
    await mem.publish("rec", "global");
    const b = mem.view({ threadId: "b", projectId: "P" });
    b.get("rec")!.content = "MUTATED";
    b.search("A")[0].meta!.n = 99;
    b.all()[0].content = "MUTATED-ALL";
    expect(mem.get("rec")).toMatchObject({ content: "A", meta: { n: 1 } });
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
