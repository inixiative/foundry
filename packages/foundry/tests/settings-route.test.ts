import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { ContextLayer, ContextStack, EventStream, Harness, InterventionLog, Thread } from "@inixiative/foundry-core";
import { ActionHandler } from "../src/viewer/actions";
import { registerControlRoutes } from "../src/viewer/routes/control";
import { ConfigStore, starterConfig } from "../src/viewer/config";

test("reading settings and writing them back never persists runtime-generated layers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "foundry-settings-route-"));
  try {
    const store = new ConfigStore(dir);
    await store.save(starterConfig());
    const generated = new ContextLayer({ id: "thread-knowledge:docs", prompt: "Generated", segment: "thread-knowledge" });
    const main = new Thread("main", new ContextStack([generated]));
    const harness = new Harness(main);
    const actions = new ActionHandler({ harness, eventStream: new EventStream(),
      interventions: new InterventionLog(main.signals), resolveThread: () => main });
    const app = new Hono();
    registerControlRoutes(app, { harness, actions, configStore: store, aiAssist: null, analyticsStore: null,
      actionQueue: null, tunnelHolder: { tunnel: null }, port: 0, threadsChanged: () => {} });

    const definitions = await (await app.request("/api/definitions")).json();
    expect(definitions.layers.map((l: { id: string }) => l.id)).toContain("thread-knowledge:docs");

    const settings = await (await app.request("/api/settings")).json();
    expect(Object.keys(settings.layers)).toEqual([]);
    const put = await app.request("/api/settings", { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify(settings) });
    expect(put.status).toBe(200);
    await app.request("/api/settings/defaults", { method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: settings.defaults.model }) });

    expect(Object.keys((await new ConfigStore(dir).load()).layers)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
