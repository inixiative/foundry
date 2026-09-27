import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextLayer, ContextStack, Harness, Thread, buildInjectionArtifact } from "@inixiative/foundry-core";
import { ConfigStore, starterConfig, validateConfig, type LayerSettingsConfig } from "../src/viewer/config";
import { buildLayers } from "../src/agents/thread-factory";
import { resolveProjectView } from "../src/viewer/config-resolve";

// Configuration policy for the optional content segment: project resolution provenance,
// global AND project validation before publication, and harness synchronization.
// Checked-in regression coverage for the three G6 opposite-review findings.
const layer = (segment?: LayerSettingsConfig["segment"], id = "custom"): LayerSettingsConfig =>
  ({ id, prompt: "Use the fact", sourceIds: [], staleness: 0, enabled: true, ...(segment ? { segment } : {}) });
const project = (layers?: Record<string, unknown>) => ({ id: "p", path: "/controlled", label: "Controlled", enabled: true, ...(layers ? { layers } : {}) });
const kindOf = (built: ContextLayer) => { built.set("FACT"); return buildInjectionArtifact({ userMessage: "u", assembled: new ContextStack([built]).assemble() }).blocks.find(b => b.text === "FACT")?.kind; };

test("inherited: a global segment reaches the project view with global/inherit provenance", () => {
  const config = starterConfig("controlled", "controlled");
  config.layers = { custom: layer("thread-knowledge") }; config.projects = { p: project() as never };
  const view = resolveProjectView(config, "p")!;
  expect(view.layers[0].fields.segment).toMatchObject({ origin: "global", strategy: "inherit", globalValue: "thread-knowledge", resolvedValue: "thread-knowledge" });
  const built = buildLayers(view.config, { sourceResolver: () => null })[0];
  expect(built.segment).toBe("thread-knowledge"); expect(kindOf(built)).toBe("thread-knowledge");
});

test("override: a project segment replaces the global one with project/override provenance", () => {
  const config = starterConfig("controlled", "controlled");
  config.layers = { custom: layer("domain-knowledge") };
  config.projects = { p: project({ custom: { segment: "thread-knowledge" } }) as never };
  const view = resolveProjectView(config, "p")!;
  expect(view.layers[0].fields.segment).toMatchObject({ origin: "project", strategy: "override", globalValue: "domain-knowledge", projectValue: "thread-knowledge", resolvedValue: "thread-knowledge" });
  expect(view.config.layers.custom.segment).toBe("thread-knowledge");
  expect(view.config.layers.custom.prompt).toBe("Use the fact"); // provider text untouched
  expect(buildLayers(view.config, { sourceResolver: () => null })[0].segment).toBe("thread-knowledge");
});

test("project-only: a layer declared only in the project keeps its segment with project-only provenance", () => {
  const config = starterConfig("controlled", "controlled"); config.layers = {};
  config.projects = { p: project({ custom: { id: "custom", prompt: "Use the fact", segment: "thread-knowledge", sourceIds: { replace: [] }, staleness: 0, enabled: true } }) as never };
  const view = resolveProjectView(config, "p")!;
  expect(view.layers[0].scope).toBe("project-only");
  expect(view.layers[0].fields.segment).toMatchObject({ origin: "project", strategy: "project-only", resolvedValue: "thread-knowledge" });
  expect(buildLayers(view.config, { sourceResolver: () => null })[0].segment).toBe("thread-knowledge");
});

test("absent: legacy layers without metadata stay without a segment key and keep legacy classification", () => {
  const config = starterConfig("controlled", "controlled");
  config.layers = { custom: layer(), memory: layer(undefined, "memory") }; config.projects = { p: project({ custom: { prompt: "Use the fact" } }) as never };
  const view = resolveProjectView(config, "p")!;
  for (const resolved of view.layers) {
    expect("segment" in resolved.config).toBe(false);
    expect(resolved.fields.segment).toMatchObject({ resolvedValue: undefined });
  }
  const [custom, memory] = buildLayers(view.config, { sourceResolver: () => null });
  expect(custom.segment).toBeUndefined(); expect(kindOf(custom)).toBe("domain-knowledge");
  expect(memory.segment).toBeUndefined(); expect(kindOf(memory)).toBe("thread-knowledge"); // id heuristic, unchanged
});

for (const [label, value] of [["null", null], ["string", "instructions"], ["object", { kind: "thread-knowledge" }], ["number", 1]] as const)
test(`invalid project layer segment (${label}) is refused before live config or the persisted file changes`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "g6-config-segment-"));
  try {
    const store = new ConfigStore(dir), config = starterConfig("controlled", "controlled");
    config.layers = { custom: layer("thread-knowledge") }; await store.save(config);
    const before = await readFile(join(dir, "settings.json"), "utf8");
    await expect(store.patch("projects", { p: project({ custom: { segment: value } }) })).rejects.toThrow('project "p" layers: segment must be');
    expect(await readFile(join(dir, "settings.json"), "utf8")).toBe(before);
    expect(store.config.projects).toEqual({});
    await expect(store.patch("layers", { custom: { ...layer(), segment: value } })).rejects.toThrow("global layers: segment must be");
    expect(await readFile(join(dir, "settings.json"), "utf8")).toBe(before);
    expect(store.config.layers.custom.segment).toBe("thread-knowledge");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("valid and absent project segments are accepted, persisted and resolved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "g6-config-segment-ok-"));
  try {
    const store = new ConfigStore(dir), config = starterConfig("controlled", "controlled");
    config.layers = { custom: layer("domain-knowledge"), plain: layer(undefined, "plain") }; await store.save(config);
    await store.patch("projects", { p: project({ custom: { segment: "thread-knowledge" }, plain: { prompt: "Use the fact" } }) });
    const reloaded = await new ConfigStore(dir).load();
    const view = resolveProjectView(reloaded, "p")!;
    expect(view.config.layers.custom.segment).toBe("thread-knowledge");
    expect("segment" in view.config.layers.plain).toBe(false);
    expect(() => validateConfig(reloaded)).not.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an invalid persisted project segment fails load loudly and leaves the file for repair", async () => {
  const dir = await mkdtemp(join(tmpdir(), "g6-config-segment-load-"));
  try {
    const store = new ConfigStore(dir), config = starterConfig("controlled", "controlled");
    config.layers = { custom: layer("thread-knowledge") }; await store.save(config);
    const path = join(dir, "settings.json");
    const tampered = JSON.parse(await readFile(path, "utf8"));
    tampered.projects = { p: project({ custom: { segment: "instructions" } }) };
    await Bun.write(path, JSON.stringify(tampered, null, 2));
    const written = await readFile(path, "utf8");
    await expect(new ConfigStore(dir).load()).rejects.toThrow('project "p" layers: segment must be');
    expect(await readFile(path, "utf8")).toBe(written);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("withRuntime shows runtime-only layers with their construction segment, never overwrites a definition, and never changes settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "g6-config-segment-sync-"));
  try {
    const store = new ConfigStore(dir);
    const existing = starterConfig("controlled", "controlled"); existing.layers = { configured: layer("domain-knowledge", "configured") }; await store.save(existing);
    const declared = new ContextLayer({ id: "custom", prompt: "Use the fact", segment: "thread-knowledge" });
    const plain = new ContextLayer({ id: "plain", prompt: "Plain" });
    const conflicting = new ContextLayer({ id: "configured", prompt: "Runtime prompt", segment: "thread-knowledge" }); // must not overwrite
    const view = store.withRuntime(new Harness(new Thread("owned", new ContextStack([declared, plain, conflicting]))));
    expect(view.layers.custom).toMatchObject({ id: "custom", prompt: "Use the fact", segment: "thread-knowledge" });
    expect("segment" in view.layers.plain!).toBe(false);
    expect(view.layers.configured).toMatchObject({ prompt: "Use the fact", segment: "domain-knowledge" });
    expect(Object.keys(store.config.layers)).toEqual(["configured"]);
    await store.patch("defaults", { model: "controlled" });
    expect(Object.keys((await new ConfigStore(dir).load()).layers)).toEqual(["configured"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("settings reject a configured thread-knowledge layer, which would collide with generated ones at boot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "g6-config-reserved-"));
  try {
    const store = new ConfigStore(dir);
    await store.save(starterConfig("controlled", "controlled"));
    await expect(store.patch("layers", { "thread-knowledge:docs": layer("thread-knowledge", "generated") }))
      .rejects.toThrow("thread-knowledge layers are generated per thread");
    expect(Object.keys((await new ConfigStore(dir).load()).layers)).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
