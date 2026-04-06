import { describe, test, expect } from "bun:test";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import { join } from "path";
import { ContextStack } from "../src/agents/context-stack";
import { SignalBus } from "../src/agents/signal";
import {
  CorpusCompiler,
  type FluidEntry,
  type CorpusCompilerConfig,
} from "../src/agents/corpus-compiler";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function makeEntry(
  overrides?: Partial<FluidEntry>
): FluidEntry {
  _seq++;
  return {
    id: `entry-${_seq}`,
    kind: "convention",
    source: "test-agent",
    content: `Convention ${_seq}: use arrow functions`,
    timestamp: Date.now(),
    confidence: 0.8,
    ...overrides,
  };
}

function setupCompiler(config?: CorpusCompilerConfig) {
  return new CorpusCompiler(config);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CorpusCompiler", () => {
  test("ingest() stores fluid entries", () => {
    const compiler = setupCompiler();
    const entry = makeEntry();

    compiler.ingest(entry);

    expect(compiler.fluidEntries.length).toBe(1);
    expect(compiler.fluidEntries[0].id).toBe(entry.id);
  });

  test("ingest() deduplicates identical content from same source", () => {
    const compiler = setupCompiler();
    const entry = makeEntry({ content: "same content" });

    compiler.ingest(entry);
    compiler.ingest({ ...entry, id: "different-id" }); // same content+source

    expect(compiler.fluidEntries.length).toBe(1);
  });

  test("promote() creates formal doc from entries", () => {
    const compiler = setupCompiler();
    const e1 = makeEntry();
    const e2 = makeEntry();
    compiler.ingest(e1);
    compiler.ingest(e2);

    const doc = compiler.promote([e1.id, e2.id], {
      title: "Arrow Functions",
      kind: "convention",
      content: "Always use arrow functions.",
      state: "draft",
      trust: 60,
    });

    expect(doc.id).toBeTruthy();
    expect(doc.title).toBe("Arrow Functions");
    expect(doc.kind).toBe("convention");
    expect(doc.sources).toEqual([e1.id, e2.id]);
    expect(doc.version).toBe(1);
    expect(doc.state).toBe("draft");
    expect(doc.trust).toBe(60);
    expect(doc.createdAt).toBeGreaterThan(0);
  });

  test("autoPromote() groups entries by kind and creates docs", () => {
    const compiler = setupCompiler();

    // Add 3 convention entries (meets default threshold)
    for (let i = 0; i < 3; i++) {
      compiler.ingest(
        makeEntry({
          kind: "convention",
          content: `Convention rule ${i}: prefer const`,
        })
      );
    }

    // Add 2 taste entries (below threshold)
    for (let i = 0; i < 2; i++) {
      compiler.ingest(
        makeEntry({
          kind: "taste",
          content: `Taste preference ${i}: no semicolons`,
        })
      );
    }

    const docs = compiler.autoPromote();

    expect(docs.length).toBe(1); // only conventions hit threshold
    expect(docs[0].kind).toBe("convention");
    expect(docs[0].state).toBe("draft");
    expect(docs[0].sources.length).toBe(3);
  });

  test("transition() changes doc state", () => {
    const compiler = setupCompiler();
    const entry = makeEntry();
    compiler.ingest(entry);

    const doc = compiler.promote([entry.id], {
      title: "Test Doc",
      kind: "convention",
      content: "test content",
      state: "draft",
      trust: 50,
    });

    const updated = compiler.transition(doc.id, "active");

    expect(updated).toBeDefined();
    expect(updated!.state).toBe("active");
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(doc.createdAt);
  });

  test("transition() returns undefined for unknown doc", () => {
    const compiler = setupCompiler();
    expect(compiler.transition("nonexistent", "active")).toBeUndefined();
  });

  test("compile() produces immutable corpus with content hash", () => {
    const compiler = setupCompiler();
    const entry = makeEntry();
    compiler.ingest(entry);

    const doc = compiler.promote([entry.id], {
      title: "Active Convention",
      kind: "convention",
      content: "Use TypeScript strict mode.",
      state: "active",
      trust: 50,
    });
    compiler.transition(doc.id, "active");

    const corpus = compiler.compile();

    expect(corpus.id).toBeTruthy();
    expect(corpus.version).toBeTruthy();
    expect(corpus.contentHash).toBeTruthy();
    expect(corpus.layers.length).toBe(1);
    expect(corpus.layers[0].content).toBe("Use TypeScript strict mode.");
    expect(corpus.totalTokens).toBeGreaterThan(0);
    expect(corpus.compiledAt).toBeGreaterThan(0);
  });

  test("compile() respects maxTokens budget", () => {
    const compiler = setupCompiler({ maxTokens: 10 }); // very small budget

    // Create multiple active docs with enough content to exceed budget
    for (let i = 0; i < 5; i++) {
      const entry = makeEntry({
        content: `Long convention content number ${i} with lots of words to consume tokens`,
      });
      compiler.ingest(entry);
      const doc = compiler.promote([entry.id], {
        title: `Doc ${i}`,
        kind: "convention",
        content: "x".repeat(100), // 25 tokens each
        state: "active",
        trust: 50 + i,
      });
      compiler.transition(doc.id, "active");
    }

    const corpus = compiler.compile();

    // Should not exceed maxTokens
    expect(corpus.totalTokens).toBeLessThanOrEqual(10);
  });

  test("compile() builds attribution trace", () => {
    const compiler = setupCompiler();

    const e1 = makeEntry({ id: "e1" });
    const e2 = makeEntry({ id: "e2" });
    compiler.ingest(e1);
    compiler.ingest(e2);

    const doc = compiler.promote([e1.id, e2.id], {
      title: "Traced Convention",
      kind: "convention",
      content: "Use consistent naming.",
      state: "active",
      trust: 60,
    });
    compiler.transition(doc.id, "active");

    const corpus = compiler.compile();

    expect(corpus.attribution.length).toBe(1);
    expect(corpus.attribution[0].docs).toContain(doc.id);
    expect(corpus.attribution[0].entries).toContain("e1");
    expect(corpus.attribution[0].entries).toContain("e2");
  });

  test("loadIntoStack() creates layers in stack", () => {
    const compiler = setupCompiler();
    const entry = makeEntry();
    compiler.ingest(entry);

    const doc = compiler.promote([entry.id], {
      title: "Stack Test",
      kind: "convention",
      content: "Layer content for stack.",
      state: "active",
      trust: 70,
    });
    compiler.transition(doc.id, "active");

    const corpus = compiler.compile();
    const stack = new ContextStack();
    compiler.loadIntoStack(corpus, stack);

    expect(stack.layers.length).toBe(1);
    expect(stack.layers[0].content).toBe("Layer content for stack.");
    expect(stack.layers[0].trust).toBe(70);
    expect(stack.layers[0].isWarm).toBe(true);
  });

  test("canPromoteTier() checks trust thresholds", () => {
    const compiler = setupCompiler();

    // Create a doc with trust 40 and 3 sources
    const entries = Array.from({ length: 3 }, () => makeEntry());
    entries.forEach((e) => compiler.ingest(e));

    const doc = compiler.promote(
      entries.map((e) => e.id),
      {
        title: "Tier Test",
        kind: "convention",
        content: "Tiered content.",
        state: "active",
        trust: 40,
      }
    );
    compiler.transition(doc.id, "active");

    // personal_private: always true
    expect(compiler.canPromoteTier(doc.id, "personal_private")).toBe(true);

    // personal_public: trust >= 30 → true (trust is 40)
    expect(compiler.canPromoteTier(doc.id, "personal_public")).toBe(true);

    // team: trust >= 50 AND 5+ sources → false (trust 40 < 50)
    expect(compiler.canPromoteTier(doc.id, "team")).toBe(false);

    // org: trust >= 70 AND 10+ sources → false
    expect(compiler.canPromoteTier(doc.id, "org")).toBe(false);
  });

  test("canPromoteTier() requires active state", () => {
    const compiler = setupCompiler();
    const entry = makeEntry();
    compiler.ingest(entry);

    const doc = compiler.promote([entry.id], {
      title: "Draft Doc",
      kind: "convention",
      content: "Not active yet.",
      state: "draft",
      trust: 90,
    });

    // Even with high trust, draft state blocks promotion
    expect(compiler.canPromoteTier(doc.id, "personal_public")).toBe(false);
  });

  test("save()/load() persistence round-trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "corpus-test-"));

    const compiler = setupCompiler();
    const e1 = makeEntry({ id: "persist-1", content: "persist me" });
    compiler.ingest(e1);

    const doc = compiler.promote([e1.id], {
      title: "Persisted Doc",
      kind: "convention",
      content: "Persistent content.",
      state: "active",
      trust: 55,
    });
    compiler.transition(doc.id, "active");

    await compiler.save(dir);

    // Load into a fresh compiler
    const loaded = setupCompiler();
    await loaded.load(dir);

    expect(loaded.fluidEntries.length).toBe(1);
    expect(loaded.fluidEntries[0].id).toBe("persist-1");
    expect(loaded.formalDocs.length).toBe(1);
    expect(loaded.formalDocs[0].title).toBe("Persisted Doc");
    expect(loaded.formalDocs[0].state).toBe("active");

    // Compile should still work after load
    const corpus = loaded.compile();
    expect(corpus.layers.length).toBe(1);
  });

  test("docsByState() and docsByKind() filter correctly", () => {
    const compiler = setupCompiler();

    const e1 = makeEntry();
    const e2 = makeEntry();
    const e3 = makeEntry();
    compiler.ingest(e1);
    compiler.ingest(e2);
    compiler.ingest(e3);

    compiler.promote([e1.id], {
      title: "Draft Conv",
      kind: "convention",
      content: "draft content",
      state: "draft",
      trust: 30,
    });
    const activeDoc = compiler.promote([e2.id], {
      title: "Active ADR",
      kind: "adr",
      content: "adr content",
      state: "active",
      trust: 50,
    });
    compiler.transition(activeDoc.id, "active");
    compiler.promote([e3.id], {
      title: "Draft Skill",
      kind: "skill",
      content: "skill content",
      state: "draft",
      trust: 40,
    });

    expect(compiler.docsByState("draft").length).toBe(2);
    expect(compiler.docsByState("active").length).toBe(1);
    expect(compiler.docsByKind("convention").length).toBe(1);
    expect(compiler.docsByKind("adr").length).toBe(1);
    expect(compiler.docsByKind("skill").length).toBe(1);
  });

  test("ingestFromSignalBus() auto-captures signals", async () => {
    const compiler = setupCompiler();
    const bus = new SignalBus();

    const unsub = compiler.ingestFromSignalBus(bus);

    await bus.emit({
      id: "sig-1",
      kind: "convention",
      source: "agent-a",
      content: "Use strict TypeScript",
      timestamp: Date.now(),
    });

    await bus.emit({
      id: "sig-2",
      kind: "taste",
      source: "agent-b",
      content: "Prefer single quotes",
      timestamp: Date.now(),
    });

    expect(compiler.fluidEntries.length).toBe(2);
    expect(compiler.fluidEntries[0].kind).toBe("convention");
    expect(compiler.fluidEntries[1].kind).toBe("taste");

    unsub();
  });

  test("compile() excludes docs below minTrust", () => {
    const compiler = setupCompiler({ minTrust: 50 });

    const e1 = makeEntry();
    const e2 = makeEntry();
    compiler.ingest(e1);
    compiler.ingest(e2);

    const lowTrust = compiler.promote([e1.id], {
      title: "Low Trust",
      kind: "convention",
      content: "low trust content",
      state: "active",
      trust: 30,
    });
    compiler.transition(lowTrust.id, "active");

    const highTrust = compiler.promote([e2.id], {
      title: "High Trust",
      kind: "convention",
      content: "high trust content",
      state: "active",
      trust: 70,
    });
    compiler.transition(highTrust.id, "active");

    const corpus = compiler.compile();

    expect(corpus.layers.length).toBe(1);
    expect(corpus.layers[0].trust).toBe(70);
  });
});
