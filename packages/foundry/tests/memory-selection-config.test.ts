import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, starterConfig, validateConfig, type FoundryConfig } from "../src/viewer/config";
import { createViewer } from "../src/viewer/server";
import { ContextStack, EventStream, Harness, InterventionLog } from "@inixiative/foundry-core";
import { buildAgents, ThreadFactory } from "../src/agents/thread-factory";

// Operator and persisted configuration reach the memory selector as raw JSON.
// Every write boundary must refuse an invalid policy without touching the live
// or persisted settings: store save, store patch, and the project route that
// used to mutate the live project object before the store validated it.

function withStore() {
  const dir = mkdtempSync(join(tmpdir(), "foundry-selection-config-"));
  const config = starterConfig("mock", "controlled");
  config.sources.memory = { id: "memory", type: "file", label: "Memory", uri: "memory", enabled: true, selection: { budgetChars: 6000 } };
  return { dir, config, store: new ConfigStore(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("validateConfig names the offending source in global and project scopes", () => {
  const { config, cleanup } = withStore();
  try {
    expect(() => validateConfig(config)).not.toThrow();
    const bad = structuredClone(config) as FoundryConfig;
    (bad.sources.memory as any).selection = { recentLimit: -1 };
    expect(() => validateConfig(bad)).toThrow(/source "memory" in global sources.*recentLimit/);
    const badProject = structuredClone(config) as FoundryConfig;
    badProject.projects.p1 = { id: "p1", name: "P1", path: "/tmp/p1", sources: { extra: { id: "extra", type: "file", label: "x", uri: "x", enabled: true, selection: { pinnedKinds: "rule" } as any } } } as any;
    expect(() => validateConfig(badProject)).toThrow(/project "p1" sources.*pinnedKinds/);
    // Explicit opt-out and absent policy are both valid.
    const opted = structuredClone(config) as FoundryConfig;
    (opted.sources.memory as any).selection = false;
    expect(() => validateConfig(opted)).not.toThrow();
  } finally { cleanup(); }
});

test("save rejects an invalid policy without replacing live settings or writing the file", async () => {
  const { dir, config, store, cleanup } = withStore();
  try {
    await store.save(config);
    const liveBefore = structuredClone(store.config);
    const fileBefore = await Bun.file(join(dir, "settings.json")).text();
    const bad = structuredClone(config) as FoundryConfig;
    (bad.sources.memory as any).selection = { maxEntryChars: 0 };
    await expect(store.save(bad)).rejects.toThrow(/maxEntryChars/);
    expect(store.config).toEqual(liveBefore);
    expect(await Bun.file(join(dir, "settings.json")).text()).toBe(fileBefore);
    // A later valid write still works: the store is not wedged by the rejection.
    await store.patch("sources", { memory: { ...config.sources.memory, selection: { budgetChars: 7000 } } });
    expect((store.config.sources.memory as any).selection).toEqual({ budgetChars: 7000 });
  } finally { cleanup(); }
});

test("the project settings route rejects an invalid policy with 400 and leaves the live project untouched", async () => {
  const { dir, config, store, cleanup } = withStore();
  config.setupComplete = true;
  config.projects.p1 = { id: "p1", name: "P1", path: "/tmp/p1", sources: {} } as any;
  await store.save(config);
  const stack = new ContextStack();
  const factory = new ThreadFactory({ stack, agents: buildAgents(config, stack, { provider: { id: "mock", complete: async () => ({ model: "mock", content: "" }) } }) });
  const thread = factory.create("main");
  const harness = new Harness(thread);
  const viewer = createViewer({ harness, eventStream: new EventStream(), interventions: new InterventionLog(thread.signals), configStore: store, configDir: dir, threadFactory: factory });
  try {
    const liveBefore = structuredClone(store.config);
    const fileBefore = await Bun.file(join(dir, "settings.json")).text();
    const res = await viewer.app.fetch(new Request("http://localhost/api/projects/p1/settings/sources", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mem: { id: "mem", type: "file", label: "M", uri: "m", enabled: true, selection: { budgetChars: "invalid" } } }),
    }));
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/budgetChars/);
    expect(store.config).toEqual(liveBefore);
    expect(store.config.projects.p1.sources).toEqual({});
    expect(await Bun.file(join(dir, "settings.json")).text()).toBe(fileBefore);
    const ok = await viewer.app.fetch(new Request("http://localhost/api/projects/p1/settings/sources", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mem: { id: "mem", type: "file", label: "M", uri: "m", enabled: true, selection: { budgetChars: 4000 } } }),
    }));
    expect(ok.status).toBe(200);
    expect((store.config.projects.p1.sources as any).mem.selection).toEqual({ budgetChars: 4000 });
  } finally {
    viewer.localStore?.close();
    for (const t of viewer.directory.all()) t.dispose();
    cleanup();
  }
});

test("load validates the merged candidate before it becomes live and never rewrites the invalid file", async () => {
  const { dir, config, store, cleanup } = withStore();
  try {
    await store.save(config);
    const liveBefore = structuredClone(store.config);
    const file = join(dir, "settings.json");
    const persisted = JSON.stringify({ ...JSON.parse(await Bun.file(file).text()),
      sources: { memory: { ...config.sources.memory, selection: { budgetChars: "invalid" } } } }, null, 2);
    await Bun.write(file, persisted);
    await expect(store.load()).rejects.toThrow(/was not loaded.*budgetChars/);
    expect(store.config).toEqual(liveBefore);
    expect(await Bun.file(file).text()).toBe(persisted);
    // A fresh store over the same invalid file also refuses, keeping in-memory defaults and the file intact.
    const fresh = new ConfigStore(dir);
    const defaultsBefore = structuredClone(fresh.config);
    await expect(fresh.load()).rejects.toThrow(/budgetChars/);
    expect(fresh.config).toEqual(defaultsBefore);
    expect(await Bun.file(file).text()).toBe(persisted);
    // Repairing the file makes load succeed again with the normal default/provider merge.
    await Bun.write(file, JSON.stringify({ ...JSON.parse(persisted), sources: { memory: { ...config.sources.memory, selection: { budgetChars: 5000 } } } }));
    const loaded = await fresh.load();
    expect((loaded.sources.memory as any).selection).toEqual({ budgetChars: 5000 });
    expect(Object.keys(loaded.providers).length).toBeGreaterThan(0);
  } finally { cleanup(); }
});

test("load preserves a legacy file with no selection fields and a file that opts out with selection: false", async () => {
  const { dir, config, store, cleanup } = withStore();
  try {
    delete (config.sources.memory as any).selection;
    await store.save(config);
    const legacy = new ConfigStore(dir);
    expect((await legacy.load()).sources.memory.selection).toBeUndefined();
    (config.sources.memory as any).selection = false;
    await store.save(config);
    const opted = new ConfigStore(dir);
    expect((await opted.load()).sources.memory.selection).toBe(false);
  } finally { cleanup(); }
});
