import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, access, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { AssembledContext, PromptBlock } from "../src/agents/context-stack";
import {
  ClaudeCodeRuntime,
  CodexRuntime,
  CursorRuntime,
  type RuntimeEvent,
} from "../src/providers/runtime";

function makeAssembled(blocks: PromptBlock[]): AssembledContext {
  return {
    blocks,
    text: blocks.map((b) => b.text).join("\n\n"),
  };
}

const SAMPLE_BLOCKS: PromptBlock[] = [
  { role: "system", text: "You are a code reviewer." },
  { role: "layer", id: "conventions", text: "Follow project conventions." },
  { role: "content", id: "conventions", text: "Use TypeScript strict mode.\nPrefer const over let." },
  { role: "content", id: "memory", text: "User prefers functional style." },
];

// ---------------------------------------------------------------------------
// ClaudeCodeRuntime
// ---------------------------------------------------------------------------

describe("ClaudeCodeRuntime", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "foundry-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("prepareInjection formats as markdown", () => {
    const runtime = new ClaudeCodeRuntime({ projectRoot: tmpDir });
    const assembled = makeAssembled(SAMPLE_BLOCKS);
    const injection = runtime.prepareInjection(assembled);

    expect(injection.formatted).toContain("# Foundry Context");
    expect(injection.formatted).toContain("## System");
    expect(injection.formatted).toContain("You are a code reviewer.");
    expect(injection.formatted).toContain("## conventions");
    expect(injection.formatted).toContain("> Follow project conventions.");
    expect(injection.formatted).toContain("Use TypeScript strict mode.");
    expect(injection.formatted).toContain("User prefers functional style.");
    expect(injection.meta.layerIds).toEqual(["conventions", "memory"]);
    expect(injection.meta.tokenEstimate).toBeGreaterThan(0);
    expect(injection.meta.hash).toBeTruthy();
  });

  test("inject writes file and teardown removes it", async () => {
    const runtime = new ClaudeCodeRuntime({ projectRoot: tmpDir });
    const injection = runtime.prepareInjection(makeAssembled(SAMPLE_BLOCKS));

    const teardown = await runtime.inject(injection);

    // File should exist
    const filePath = join(tmpDir, ".foundry-context.md");
    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("# Foundry Context");

    // Teardown should remove it
    await teardown();
    await expect(access(filePath)).rejects.toThrow();
  });

  test("inject uses custom contextFile name", async () => {
    const runtime = new ClaudeCodeRuntime({
      projectRoot: tmpDir,
      contextFile: "custom-context.md",
    });
    const injection = runtime.prepareInjection(makeAssembled(SAMPLE_BLOCKS));

    const teardown = await runtime.inject(injection);

    const filePath = join(tmpDir, "custom-context.md");
    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("# Foundry Context");

    await teardown();
  });

  test("emits context_inject event on inject", async () => {
    const runtime = new ClaudeCodeRuntime({ projectRoot: tmpDir });
    const events: RuntimeEvent[] = [];
    runtime.onEvent((e) => events.push(e));

    const injection = runtime.prepareInjection(makeAssembled(SAMPLE_BLOCKS));
    const teardown = await runtime.inject(injection);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("context_inject");
    expect(events[0].data.layerIds).toEqual(["conventions", "memory"]);

    await teardown();
  });

  test("onEvent unsubscribe works", async () => {
    const runtime = new ClaudeCodeRuntime({ projectRoot: tmpDir });
    const events: RuntimeEvent[] = [];
    const unsub = runtime.onEvent((e) => events.push(e));

    const injection = runtime.prepareInjection(makeAssembled(SAMPLE_BLOCKS));
    unsub();

    await runtime.inject(injection);
    expect(events).toHaveLength(0);
  });

  test("generateHookScript produces valid script", () => {
    const runtime = new ClaudeCodeRuntime({ projectRoot: tmpDir });
    const script = runtime.generateHookScript("http://localhost:4400/hooks");

    expect(script).toContain("#!/usr/bin/env node");
    expect(script).toContain("http://localhost:4400/hooks");
    expect(script).toContain("CLAUDE_HOOK_INPUT");
    expect(script).toContain("tool_name");
  });
});

// ---------------------------------------------------------------------------
// CodexRuntime
// ---------------------------------------------------------------------------

describe("CodexRuntime", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "foundry-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("prepareInjection formats for Codex", () => {
    const runtime = new CodexRuntime({ projectRoot: tmpDir });
    const injection = runtime.prepareInjection(makeAssembled(SAMPLE_BLOCKS));

    expect(injection.formatted).toContain("# Foundry Context for Codex");
    expect(injection.formatted).toContain("### conventions");
    expect(injection.formatted).toContain("Follow project conventions.");
    expect(injection.formatted).toContain("Use TypeScript strict mode.");
  });

  test("inject writes instructions file and teardown removes", async () => {
    const runtime = new CodexRuntime({ projectRoot: tmpDir });
    const injection = runtime.prepareInjection(makeAssembled(SAMPLE_BLOCKS));

    const teardown = await runtime.inject(injection);

    const filePath = join(tmpDir, ".foundry-instructions.md");
    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("Foundry Context for Codex");

    await teardown();
    await expect(access(filePath)).rejects.toThrow();
  });

  test("uses custom instructions file name", async () => {
    const runtime = new CodexRuntime({
      projectRoot: tmpDir,
      instructionsFile: "AGENTS.md",
    });
    const injection = runtime.prepareInjection(makeAssembled(SAMPLE_BLOCKS));

    const teardown = await runtime.inject(injection);

    const content = await readFile(join(tmpDir, "AGENTS.md"), "utf-8");
    expect(content).toBeTruthy();

    await teardown();
  });
});

// ---------------------------------------------------------------------------
// CursorRuntime
// ---------------------------------------------------------------------------

describe("CursorRuntime", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "foundry-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("prepareInjection formats as cursor rules", () => {
    const runtime = new CursorRuntime({ projectRoot: tmpDir });
    const injection = runtime.prepareInjection(makeAssembled(SAMPLE_BLOCKS));

    // Cursor uses brackets for layer labels, no markdown headers
    expect(injection.formatted).toContain("[conventions]");
    expect(injection.formatted).toContain("Follow project conventions.");
    expect(injection.formatted).toContain("Use TypeScript strict mode.");
    expect(injection.formatted).not.toContain("# Foundry Context");
  });

  test("inject writes rules file and teardown removes", async () => {
    const runtime = new CursorRuntime({ projectRoot: tmpDir });
    const injection = runtime.prepareInjection(makeAssembled(SAMPLE_BLOCKS));

    const teardown = await runtime.inject(injection);

    const filePath = join(tmpDir, ".foundry-cursorrules");
    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("[conventions]");

    await teardown();
    await expect(access(filePath)).rejects.toThrow();
  });

  test("emits events and supports unsubscribe", async () => {
    const runtime = new CursorRuntime({ projectRoot: tmpDir });
    const events: RuntimeEvent[] = [];
    const unsub = runtime.onEvent((e) => events.push(e));

    const injection = runtime.prepareInjection(makeAssembled(SAMPLE_BLOCKS));
    await runtime.inject(injection);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("context_inject");

    unsub();
    await runtime.inject(injection);
    // Still 1 — unsubscribed
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Cross-runtime: injection meta consistency
// ---------------------------------------------------------------------------

describe("Cross-runtime consistency", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "foundry-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("all runtimes produce consistent meta from same assembled context", () => {
    const assembled = makeAssembled(SAMPLE_BLOCKS);

    const claude = new ClaudeCodeRuntime({ projectRoot: tmpDir });
    const codex = new CodexRuntime({ projectRoot: tmpDir });
    const cursor = new CursorRuntime({ projectRoot: tmpDir });

    const c1 = claude.prepareInjection(assembled);
    const c2 = codex.prepareInjection(assembled);
    const c3 = cursor.prepareInjection(assembled);

    // Same layer IDs extracted
    expect(c1.meta.layerIds).toEqual(c2.meta.layerIds);
    expect(c2.meta.layerIds).toEqual(c3.meta.layerIds);

    // All have non-zero token estimates
    expect(c1.meta.tokenEstimate).toBeGreaterThan(0);
    expect(c2.meta.tokenEstimate).toBeGreaterThan(0);
    expect(c3.meta.tokenEstimate).toBeGreaterThan(0);

    // All have hashes
    expect(c1.meta.hash).toBeTruthy();
    expect(c2.meta.hash).toBeTruthy();
    expect(c3.meta.hash).toBeTruthy();
  });

  test("all runtimes include all content from assembled context", () => {
    const assembled = makeAssembled(SAMPLE_BLOCKS);

    const claude = new ClaudeCodeRuntime({ projectRoot: tmpDir });
    const codex = new CodexRuntime({ projectRoot: tmpDir });
    const cursor = new CursorRuntime({ projectRoot: tmpDir });

    const c1 = claude.prepareInjection(assembled);
    const c2 = codex.prepareInjection(assembled);
    const c3 = cursor.prepareInjection(assembled);

    // All formatted outputs contain the core content
    for (const injection of [c1, c2, c3]) {
      expect(injection.formatted).toContain("You are a code reviewer.");
      expect(injection.formatted).toContain("Follow project conventions.");
      expect(injection.formatted).toContain("Use TypeScript strict mode.");
      expect(injection.formatted).toContain("User prefers functional style.");
    }
  });
});
