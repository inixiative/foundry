import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigRevisionError, ConfigStore, defaultConfig, type FoundryConfig } from "../src/viewer/config";

function buildConfig(): FoundryConfig {
  const config = defaultConfig();
  config.apiTokens = true; // API-provider agents

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
      staleness: 0,
      maxTokens: 1000,
      enabled: true,
    },
    docs: {
      id: "docs",
      prompt: "Global docs",
      sourceIds: ["global-docs"],
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

  test("load refreshes built-in provider models while preserving user settings", async () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      defaults: {
        provider: "claude-code",
        model: "sonnet",
      },
      providers: {
        "claude-code": {
          id: "claude-code",
          type: "claude-code",
          label: "Old Claude Code label",
          enabled: false,
          models: [{ id: "sonnet", label: "Sonnet 4.6", tier: "standard" }],
        },
        openai: {
          id: "openai",
          type: "openai",
          label: "OpenAI",
          enabled: true,
          baseUrl: "https://example.test/v1",
          models: [{ id: "gpt-5.4", label: "GPT-5.4", tier: "powerful" }],
        },
      },
    }));

    const loaded = await store.load();

    expect(loaded.providers["claude-code"].enabled).toBe(false);
    expect(loaded.providers["claude-code"].models.some((model) => model.id === "fable")).toBe(true);
    expect(loaded.providers.openai.baseUrl).toBe("https://example.test/v1");
    expect(loaded.providers.openai.models.map((model) => model.id)).toContain("gpt-6-astra");
    expect(loaded.providers.codex.models.map((model) => model.id)).toContain("gpt-6-astra");
  });
});

describe("ConfigStore persistence", () => {
  let dir: string;
  let store: ConfigStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-config-store-"));
    store = new ConfigStore(dir);
    await store.save(buildConfig());
  });

  afterEach(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a failed write leaves live and persisted config unchanged", async () => {
    const live = store.config, disk = readFileSync(join(dir, "settings.json"), "utf8"), revision = store.revision;
    chmodSync(dir, 0o500);
    await expect(store.patch("defaults", { model: "unwritten" })).rejects.toThrow();
    await expect(store.update((draft) => { draft.layers.system.prompt = "unwritten"; })).rejects.toThrow();
    chmodSync(dir, 0o700);
    expect(store.config).toBe(live);
    expect(store.config.defaults.model).not.toBe("unwritten");
    expect(store.config.layers.system.prompt).toBe("System layer");
    expect(store.revision).toBe(revision);
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(disk);
    expect(readdirSync(dir)).toEqual(["settings.json"]);
  });

  test("concurrent mutations apply in order against the latest committed config", async () => {
    const revision = store.revision;
    await Promise.all([
      store.patch("layers", { a: { ...store.config.layers.system, id: "a" } }),
      store.update((draft) => { draft.layers.b = { ...draft.layers.system, id: "b" }; }),
      store.patch("defaults", { model: "concurrent" }),
    ]);
    expect(Object.keys(store.config.layers)).toEqual(["system", "docs", "a", "b"]);
    expect(store.config.defaults.model).toBe("concurrent");
    expect(store.revision).toBe(revision + 3);
    const reloaded = await new ConfigStore(dir).load();
    expect(Object.keys(reloaded.layers)).toEqual(["system", "docs", "a", "b"]);
    expect(reloaded.defaults.model).toBe("concurrent");
  });

  test("update works on a copy: callers' references never see uncommitted or later changes", async () => {
    const before = store.config;
    await store.update((draft) => { draft.layers.system.prompt = "changed"; });
    expect(before.layers.system.prompt).toBe("System layer");
    expect(store.config.layers.system.prompt).toBe("changed");
    const config = buildConfig();
    await store.save(config);
    config.layers.system.prompt = "caller edit";
    expect(store.config.layers.system.prompt).toBe("System layer");
  });

  test("deleteItem validates the result and does not mutate prior references", async () => {
    const before = store.config;
    await store.deleteItem("layers", "docs");
    expect(before.layers.docs).toBeDefined();
    expect(store.config.layers.docs).toBeUndefined();
    expect((await new ConfigStore(dir).load()).layers.docs).toBeUndefined();

    const projectId = crypto.randomUUID();
    await store.update((draft) => {
      draft.projects[projectId] = { id: projectId, label: "Team", path: dir };
      draft.kingdomAccess = [{ id: crypto.randomUUID(), name: "Team issues", url: "http://127.0.0.1:1", credentialFile: join(dir, "access.json"),
        integrationId: crypto.randomUUID(), signetId: crypto.randomUUID(), projectIds: [projectId] }];
    });
    const referenced = store.config;
    await expect(store.deleteItem("projects", projectId)).rejects.toThrow("Kingdom access references an unavailable project");
    expect(store.config).toBe(referenced);
    expect(store.config.projects[projectId]).toBeDefined();
    expect((await new ConfigStore(dir).load()).projects[projectId]).toBeDefined();
  });

  test("a stale expected revision is rejected without writing", async () => {
    const stale = store.revision;
    await store.patch("defaults", { model: "first" }, stale);
    await expect(store.patch("defaults", { model: "second" }, stale)).rejects.toBeInstanceOf(ConfigRevisionError);
    await expect(store.deleteItem("layers", "docs", stale)).rejects.toBeInstanceOf(ConfigRevisionError);
    expect(store.config.defaults.model).toBe("first");
    expect(store.config.layers.docs).toBeDefined();
    await store.patch("defaults", { model: "second" }, store.revision);
    expect(store.config.defaults.model).toBe("second");
  });

  test("load advances the revision only when settings changed on disk", async () => {
    const revision = store.revision;
    await store.load();
    expect(store.revision).toBe(revision);
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ ...store.config, defaults: { ...store.config.defaults, model: "external" } }));
    await store.load();
    expect(store.config.defaults.model).toBe("external");
    expect(store.revision).toBe(revision + 1);
  });
});
