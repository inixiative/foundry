import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepoDocs, formatPlan, DOCS_ADVISE_PROMPT } from "../src/setup/scan-docs";

function makeDoc(title: string, h2s: string[], filler = ""): string {
  const h2Block = h2s.map((h) => `## ${h}\n\nsome prose about ${h}.\n`).join("\n");
  return `# ${title}\n\n${h2Block}\n${filler}`;
}

describe("scanRepoDocs", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "scan-docs-"));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("returns none for a repo with no docs", async () => {
    const plan = await scanRepoDocs(repo);
    expect(plan.strategy).toBe("none");
    expect(plan.chosen).toBeNull();
    expect(plan.candidates).toEqual([]);
    expect(plan.settings).toBeUndefined();
  });

  test("returns none for a nonexistent repo path", async () => {
    const plan = await scanRepoDocs(join(repo, "does-not-exist"));
    expect(plan.strategy).toBe("none");
    expect(plan.rationale).toMatch(/does not exist/i);
  });

  test("picks docs/claude over docs when both exist", async () => {
    mkdirSync(join(repo, "docs"), { recursive: true });
    mkdirSync(join(repo, "docs/claude"), { recursive: true });

    // docs/ has one shallow readme
    writeFileSync(join(repo, "docs/README.md"), "# Docs\n\nsome text.\n");

    // docs/claude has rich structured content
    for (let i = 0; i < 8; i++) {
      writeFileSync(
        join(repo, `docs/claude/TOPIC_${i}.md`),
        makeDoc(`Topic ${i}`, ["Overview", "Usage", "Gotchas"], "lorem ".repeat(200)),
      );
    }

    const plan = await scanRepoDocs(repo);
    expect(plan.chosen).not.toBeNull();
    expect(plan.chosen!.relPath).toBe("docs/claude");
    expect(plan.candidates.length).toBe(2);
    expect(plan.candidates[0].relPath).toBe("docs/claude");
    expect(plan.candidates[1].relPath).toBe("docs");
  });

  test("scores titleCoverage and H2 density correctly", async () => {
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(
      join(repo, "docs/A.md"),
      makeDoc("Alpha", ["One", "Two", "Three"], "x".repeat(500)),
    );
    writeFileSync(join(repo, "docs/B.md"), "no title here\n\n## Section\ntext\n");
    writeFileSync(join(repo, "docs/C.md"), makeDoc("Gamma", [], "content"));

    const plan = await scanRepoDocs(repo);
    const c = plan.chosen!;
    expect(c.fileCount).toBe(3);
    expect(c.titleCoverage).toBeCloseTo(2 / 3, 5);
    expect(c.totalH2).toBe(4);
    expect(c.avgH2PerFile).toBeCloseTo(4 / 3, 5);
  });

  test("chooses inline strategy for small corpora", async () => {
    mkdirSync(join(repo, "docs"), { recursive: true });
    // Just above the 200-token floor, comfortably below the 3k topology threshold.
    const body = "word ".repeat(150); // ~750 bytes per file → ~190 tokens
    writeFileSync(join(repo, "docs/A.md"), makeDoc("A", ["Intro", "Details"], body));
    writeFileSync(join(repo, "docs/B.md"), makeDoc("B", ["Intro", "Details"], body));

    const plan = await scanRepoDocs(repo);
    expect(plan.chosen!.approxTokens).toBeLessThan(3_000);
    expect(plan.chosen!.approxTokens).toBeGreaterThanOrEqual(200);
    expect(plan.strategy).toBe("inline");
    expect(plan.settings).toBeDefined();
    expect(plan.settings!.layer.contentShape).toMatch(/full markdown content/i);
  });

  test("chooses topology strategy for large corpora", async () => {
    mkdirSync(join(repo, "docs/claude"), { recursive: true });
    const bigFiller = "word ".repeat(4000); // ~20KB each
    for (let i = 0; i < 5; i++) {
      writeFileSync(
        join(repo, `docs/claude/BIG_${i}.md`),
        makeDoc(`Big ${i}`, ["Intro", "Details", "Edge cases"], bigFiller),
      );
    }

    const plan = await scanRepoDocs(repo);
    expect(plan.strategy).toBe("topology");
    expect(plan.chosen!.approxTokens).toBeGreaterThan(3_000);
    expect(plan.settings!.layer.contentShape).toMatch(/topology|index/i);
  });

  test("reports none when corpus is below minTokens", async () => {
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "docs/tiny.md"), "# Tiny\nhi");

    const plan = await scanRepoDocs(repo);
    expect(plan.strategy).toBe("none");
    expect(plan.chosen).not.toBeNull();
    expect(plan.rationale).toMatch(/too small/i);
  });

  test("emitted config snippet has the probe-validated advise prompt", async () => {
    mkdirSync(join(repo, "docs"), { recursive: true });
    const filler = "word ".repeat(4000);
    for (let i = 0; i < 5; i++) {
      writeFileSync(
        join(repo, `docs/DOC_${i}.md`),
        makeDoc(`Doc ${i}`, ["A", "B"], filler),
      );
    }

    const plan = await scanRepoDocs(repo);
    expect(plan.settings).toBeDefined();

    const { source, layer, agent } = plan.settings!;

    expect(source.type).toBe("markdown");
    expect(source.enabled).toBe(true);
    expect(source.uri).toBe(plan.chosen!.absPath);

    expect(layer.id).toBe("docs");
    expect(layer.domain).toBe("docs");
    expect(layer.sourceIds).toEqual([source.id]);
    expect(layer.activation).toBe("conditional");
    expect(layer.writers).toEqual([agent.id]);

    expect(agent.kind).toBe("domain-librarian");
    expect(agent.domain).toBe("docs");
    expect(agent.prompt).toBe(DOCS_ADVISE_PROMPT);
    expect(agent.tools).toBe(false);
    expect(agent.visibleLayers).toContain(layer.id);
  });

  test("honours custom candidateDirs", async () => {
    mkdirSync(join(repo, "knowledge"), { recursive: true });
    writeFileSync(
      join(repo, "knowledge/ONE.md"),
      makeDoc("One", ["A", "B"], "word ".repeat(400)),
    );

    const plan = await scanRepoDocs(repo, { candidateDirs: ["knowledge"] });
    expect(plan.chosen).not.toBeNull();
    expect(plan.chosen!.relPath).toBe("knowledge");
  });

  test("formatPlan renders a readable summary", async () => {
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(
      join(repo, "docs/A.md"),
      makeDoc("A", ["One", "Two"], "word ".repeat(400)),
    );

    const plan = await scanRepoDocs(repo);
    const text = formatPlan(plan);
    expect(text).toMatch(/Docs-layer scan/);
    expect(text).toMatch(/Strategy:/);
    expect(text).toContain("docs");
  });
});
