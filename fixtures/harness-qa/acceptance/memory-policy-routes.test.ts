import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStack, EventStream, Harness, InterventionLog, Thread } from "../../../packages/core/src";
import { ConfigStore, starterConfig } from "../../../packages/foundry/src/viewer/config";
import { createViewer } from "../../../packages/foundry/src/viewer/server";

for (const mode of ["global-patch", "project-patch", "full-save"] as const) {
  test(`${mode}: invalid memory policy is a client error and leaves live/disk settings unchanged`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "foundry-policy-route-"));
    const store = new ConfigStore(dir);
    const config = starterConfig("mock", "controlled");
    const source = { id: "memory", type: "file" as const, label: "Memory", uri: "memory", enabled: true,
      selection: { budgetChars: 6000 } };
    config.sources.memory = source;
    config.projects.project = { id: "project", label: "Project", path: dir, sources: { memory: structuredClone(source) } };
    const thread = new Thread("main", new ContextStack());
    let viewer: ReturnType<typeof createViewer> | undefined;
    try {
      await store.save(config);
      await store.load();
      viewer = createViewer({ harness: new Harness(thread), configStore: store, configDir: dir,
        eventStream: new EventStream(), interventions: new InterventionLog(thread.signals) });
      const beforeSources = structuredClone(store.config.sources);
      const beforeProjects = structuredClone(store.config.projects);
      const beforeFile = await Bun.file(join(dir, "settings.json")).text();
      const invalid = { ...source, selection: { budgetChars: "invalid" } };
      const path = mode === "project-patch" ? "/api/projects/project/settings/sources"
        : mode === "global-patch" ? "/api/settings/sources" : "/api/settings";
      const body = mode === "full-save" ? { ...structuredClone(config), sources: { memory: invalid } }
        : { memory: invalid };
      const response = await viewer.app.request(path, { method: mode === "full-save" ? "PUT" : "PATCH",
        headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      // Check state before status: a superficially correct error response must
      // not hide mutation of the shared object or the persisted configuration.
      expect(store.config.sources).toEqual(beforeSources);
      expect(store.config.projects).toEqual(beforeProjects);
      expect(await Bun.file(join(dir, "settings.json")).text()).toBe(beforeFile);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(await response.text()).toMatch(/selection|policy|budgetChars/i);
    } finally {
      viewer?.localStore?.close();
      if (viewer) for (const owned of viewer.directory.all()) owned.dispose();
      thread.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
