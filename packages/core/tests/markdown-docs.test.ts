import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MarkdownDocs } from "../src/adapters/markdown-docs";

const TEST_DIR = "/tmp/foundry-markdown-docs-test";

function resetDir() {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  mkdirSync(TEST_DIR, { recursive: true });
}

afterAll(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

describe("MarkdownDocs.topologySource", () => {
  beforeEach(resetDir);

  test("emits path + H1 + H2 headings for each file", async () => {
    await Bun.write(join(TEST_DIR, "auth.md"), "# Authentication\n\n## Session model\n\ntext\n\n## Token storage\n\nmore\n");
    await Bun.write(join(TEST_DIR, "api.md"), "# API Routes\n\n## Naming\n\n## Validation\n\n## Errors\n");

    const docs = new MarkdownDocs(TEST_DIR);
    const src = docs.topologySource("docs-topo");
    const out = await src.load();

    expect(out).toContain("auth.md — Authentication");
    expect(out).toContain("H2: Session model, Token storage");
    expect(out).toContain("api.md — API Routes");
    expect(out).toContain("H2: Naming, Validation, Errors");
  });

  test("falls back to filename when no H1 is present", async () => {
    await Bun.write(join(TEST_DIR, "notes.md"), "Just a paragraph.\n\n## Orphan section\n");

    const docs = new MarkdownDocs(TEST_DIR);
    const src = docs.topologySource("t");
    const out = await src.load();

    expect(out).toContain("notes.md — notes");
    expect(out).toContain("H2: Orphan section");
  });

  test("omits H2 line for files with no H2 headings", async () => {
    await Bun.write(join(TEST_DIR, "brief.md"), "# Brief\n\nOne short paragraph.\n");

    const docs = new MarkdownDocs(TEST_DIR);
    const src = docs.topologySource("t");
    const out = await src.load();

    expect(out).toContain("brief.md — Brief");
    expect(out).not.toContain("H2:");
  });

  test("skips empty files", async () => {
    await Bun.write(join(TEST_DIR, "empty.md"), "");
    await Bun.write(join(TEST_DIR, "real.md"), "# Real\n");

    const docs = new MarkdownDocs(TEST_DIR);
    const out = await docs.topologySource("t").load();

    expect(out).not.toContain("empty.md");
    expect(out).toContain("real.md");
  });

  test("caps H2 headings at maxHeadings", async () => {
    const many = Array.from({ length: 30 }, (_, i) => `## Section ${i}`).join("\n\n");
    await Bun.write(join(TEST_DIR, "huge.md"), `# Huge\n\n${many}\n`);

    const docs = new MarkdownDocs(TEST_DIR);
    const out = await docs.topologySource("t", { maxHeadings: 5 }).load();

    expect(out).toContain("H2: Section 0, Section 1, Section 2, Section 3, Section 4");
    expect(out).not.toContain("Section 5");
  });

  test("topology stays compact — roughly 50 tokens per file", async () => {
    for (let i = 0; i < 10; i++) {
      const sections = ["## Overview", "## Usage", "## Errors"].join("\n\n");
      await Bun.write(join(TEST_DIR, `file${i}.md`), `# File ${i}\n\n${sections}\n`);
    }
    const docs = new MarkdownDocs(TEST_DIR);
    const out = await docs.topologySource("t").load();

    // Rough token estimate: chars / 4. Ten files with 3 H2s each should be < 600 tokens.
    expect(out.length).toBeLessThan(2400);
    expect(out.split("\n").length).toBeGreaterThanOrEqual(20);
  });
});
