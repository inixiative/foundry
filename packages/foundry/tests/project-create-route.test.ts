import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { ContextStack, EventStream, Harness, InterventionLog, Thread } from "@inixiative/foundry-core";
import { ActionHandler } from "../src/viewer/actions";
import { registerControlRoutes } from "../src/viewer/routes/control";
import { ConfigStore, starterConfig } from "../src/viewer/config";
import { resolveProjectView } from "../src/viewer/config-resolve";

test("adding a project seeds its default agents and layers as list-patch overrides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "foundry-project-create-"));
  try {
    const store = new ConfigStore(dir);
    await store.save(starterConfig());
    const main = new Thread("main", new ContextStack());
    const actions = new ActionHandler({ harness: new Harness(main), eventStream: new EventStream(),
      interventions: new InterventionLog(main.signals), resolveThread: () => main });
    const app = new Hono();
    registerControlRoutes(app, { harness: new Harness(main), actions, configStore: store, aiAssist: null,
      analyticsStore: null, actionQueue: null, tunnelHolder: { tunnel: null }, port: 0, threadsChanged: () => {} });

    const response = await app.request("/api/projects", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir, label: "added" }) });
    expect(response.status).toBe(201);
    const { id } = await response.json();

    const view = resolveProjectView(await new ConfigStore(dir).load(), id)!;
    expect(view.config.agents.classifier!.visibleLayers).toEqual(["system"]);
    expect(view.config.agents.artificer!.visibleLayers).toEqual([]);
    expect(view.layers.find((layer) => layer.id === "conventions")?.config.sourceIds).toEqual(["conventions-src"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
