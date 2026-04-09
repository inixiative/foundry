import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, defaultConfig, type FoundryConfig } from "../src/viewer/config";

function buildConfig(): FoundryConfig {
  const config = defaultConfig();

  config.sources = {
    "system-prompt": {
      id: "system-prompt",
      type: "inline",
      label: "System prompt",
      uri: "Global system instructions",
      enabled: true,
    },
    "global-docs": {
      id: "global-docs",
      type: "inline",
      label: "Global docs",
      uri: "Architecture notes",
      enabled: true,
    },
    "project-docs": {
      id: "project-docs",
      type: "inline",
      label: "Project docs",
      uri: "Project-specific notes",
      enabled: true,
    },
  };

  config.layers = {
    system: {
      id: "system",
      prompt: "System layer",
      sourceIds: ["system-prompt"],
      trust: 1,
      staleness: 0,
      maxTokens: 1000,
      enabled: true,
    },
    docs: {
      id: "docs",
      prompt: "Global docs",
      sourceIds: ["global-docs"],
      trust: 0.7,
      staleness: 60_000,
      maxTokens: 2000,
      writers: ["librarian"],
      enabled: true,
      activation: "conditional",
      condition: {
        categories: ["question"],
        tags: ["architecture"],
      },
    },
  };

  config.agents = {
    executor: {
      id: "executor",
      kind: "executor",
      prompt: "Execute tasks",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      temperature: 0,
      maxTokens: 4096,
      visibleLayers: ["system", "docs"],
      peers: ["reviewer", "planner"],
      maxDepth: 3,
      browser: {
        mode: "hybrid",
        allowedUrls: ["https://global.example/**"],
        blockedUrls: ["https://blocked.example/**"],
        shareSession: true,
      },
      condition: {
        tags: ["global-agent"],
      },
      enabled: true,
    },
  };

  config.projects = {
    proj: {
      id: "proj",
      path: "/tmp/proj",
      label: "Project",
      agents: {
        executor: {
          visibleLayers: { append: ["project-layer"] },
          peers: { replace: ["answerer"] },
          browser: {
            allowedUrls: { append: ["https://project.example/**"] },
            blockedUrls: { remove: ["https://blocked.example/**"] },
          },
          condition: null,
        },
      },
      layers: {
        docs: {
          prompt: "Project docs",
          sourceIds: { append: ["project-docs"] },
          writers: { remove: ["librarian"], append: ["project-librarian"] },
          condition: {
            tags: { append: ["project"] },
          },
        },
        "project-layer": {
          id: "project-layer",
          prompt: "Project-only layer",
          sourceIds: { append: ["project-docs"] },
          trust: 0.4,
          staleness: 5_000,
          maxTokens: 500,
          enabled: true,
        },
      },
    },
  };

  return config;
}

describe("ConfigStore project resolution", () => {
  let dir: string;
  let store: ConfigStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foundry-config-"));
    store = new ConfigStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolveProject uses explicit list patches to merge project overrides", async () => {
    await store.save(buildConfig());

    const resolved = store.resolveProject("proj");
    expect(resolved).not.toBeNull();

    expect(resolved!.layers.docs.prompt).toBe("Project docs");
    expect(resolved!.layers.docs.sourceIds).toEqual(["global-docs", "project-docs"]);
    expect(resolved!.layers.docs.writers).toEqual(["project-librarian"]);
    expect(resolved!.layers.docs.condition).toEqual({
      categories: ["question"],
      tags: ["architecture", "project"],
    });

    expect(resolved!.layers["project-layer"].sourceIds).toEqual(["project-docs"]);

    expect(resolved!.agents.executor.visibleLayers).toEqual(["system", "docs", "project-layer"]);
    expect(resolved!.agents.executor.peers).toEqual(["answerer"]);
    expect(resolved!.agents.executor.browser).toEqual({
      mode: "hybrid",
      allowedUrls: ["https://global.example/**", "https://project.example/**"],
      blockedUrls: [],
      shareSession: true,
    });
    expect(resolved!.agents.executor.condition).toBeUndefined();
  });

  test("resolveProject preserves explicit empty replacements on project-only lists", async () => {
    const config = buildConfig();
    config.projects.proj.layers!["project-layer"].sourceIds = { replace: [] };
    await store.save(config);

    const resolved = store.resolveProject("proj");
    expect(resolved).not.toBeNull();
    expect(resolved!.layers["project-layer"].sourceIds).toEqual([]);
  });

  test("resolveProject rejects legacy plain-array list overrides", async () => {
    const config = buildConfig();
    (config.projects.proj.layers!.docs as { sourceIds: unknown }).sourceIds = ["project-docs"];
    await store.save(config);

    expect(() => store.resolveProject("proj")).toThrow(
      "[config] project.layers.docs.sourceIds must use explicit list patch syntax: { replace: [...] } or { append/remove: [...] }",
    );
  });

  test("resolveProjectView exposes resolved layer provenance", async () => {
    await store.save(buildConfig());

    const view = store.resolveProjectView("proj");
    expect(view).not.toBeNull();

    const docs = view!.layers.find((layer) => layer.id === "docs");
    expect(docs).toBeDefined();
    expect(docs!.scope).toBe("project-override");
    expect(docs!.fields.prompt.origin).toBe("project");
    expect(docs!.fields.prompt.strategy).toBe("override");
    expect(docs!.fields.sourceIds.origin).toBe("merged");
    expect(docs!.fields.sourceIds.strategy).toBe("merge");
    expect(docs!.fields.sourceIds.resolvedValue).toEqual(["global-docs", "project-docs"]);

    const projectOnly = view!.layers.find((layer) => layer.id === "project-layer");
    expect(projectOnly).toBeDefined();
    expect(projectOnly!.scope).toBe("project-only");
    expect(projectOnly!.fields.sourceIds.origin).toBe("project");
    expect(projectOnly!.fields.sourceIds.strategy).toBe("project-only");

    const system = view!.layers.find((layer) => layer.id === "system");
    expect(system).toBeDefined();
    expect(system!.scope).toBe("global");
    expect(system!.fields.prompt.origin).toBe("global");
    expect(system!.fields.prompt.strategy).toBe("inherit");
  });
});
