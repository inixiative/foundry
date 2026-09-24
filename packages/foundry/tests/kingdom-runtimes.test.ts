import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStack, EventStream, Harness, InterventionLog, Thread } from "@inixiative/foundry-core";
import { closeKingdomRuntimeForUpdate, RUNTIME_UPDATE_CLOSE_CODE, selectKingdomRuntime } from "../src/providers/kingdom-runtime-connection";
import { ConfigStore, validateConfig } from "../src/viewer/config";
import { startViewer } from "../src/viewer/server";
import { startFakeKingdom, waitFor } from "./helpers/fake-kingdom";

test("a single-Kingdom settings file migrates once into the runtime list, keeping the pairing intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "kingdom-migrate-"));
  try {
    const kingdomRuntime = { url: "https://api.kingdom.inixiative.com", installationId: crypto.randomUUID(), credentialFile: join(root, "kingdom-runtime.json") };
    await writeFile(join(root, "settings.json"), JSON.stringify({ kingdomRuntime }));
    const config = await new ConfigStore(root).load();
    expect(config.kingdomRuntimes).toEqual([kingdomRuntime]);
    const persisted = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
    expect(persisted).not.toHaveProperty("kingdomRuntime");
    expect(persisted.kingdomRuntimes).toEqual([kingdomRuntime]);
    expect((await new ConfigStore(root).load()).kingdomRuntimes).toEqual([kingdomRuntime]);
    expect(() => validateConfig({ ...config, kingdomRuntimes: [kingdomRuntime, { ...kingdomRuntime, url: "https://api.kingdom.inixiative.com/" }] })).toThrow("may appear once");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("selectKingdomRuntime picks by Kingdom origin and refuses ambiguity", () => {
  const a = { url: "https://a.example", installationId: crypto.randomUUID() }, b = { url: "https://b.example", installationId: crypto.randomUUID() };
  expect(selectKingdomRuntime([a])).toBe(a);
  expect(selectKingdomRuntime([a, b], "https://b.example/")).toBe(b);
  expect(() => selectKingdomRuntime([a, b])).toThrow("several Kingdoms");
  expect(() => selectKingdomRuntime([], "https://a.example")).toThrow("not connected");
});

test("one Foundry holds a socket per Kingdom: pushes claim from their own Kingdom, and each disconnects independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "kingdom-many-"));
  const kingdoms = await Promise.all(["one", "two"].map(async name => {
    const installationId = crypto.randomUUID(), token = `kastle_runtime_${name.padEnd(43, "x")}`;
    const credentialFile = join(root, `kingdom-runtime-${installationId}.json`);
    await writeFile(credentialFile, JSON.stringify({ secret: token }), { mode: 0o600 });
    const state = { allowed: true, polls: 0 };
    const kingdom = startFakeKingdom({
      identify: presented => state.allowed && presented === token ? { installationId } : undefined,
      http: request => {
        if (!state.allowed || request.headers.get("authorization") !== `Bearer ${token}`) return new Response("denied", { status: 401 });
        if (new URL(request.url).pathname.endsWith("/pollRuntimeJob")) state.polls++;
        return Response.json({ data: null });
      },
    });
    return { kingdom, state, runtime: { url: kingdom.url, installationId, credentialFile } };
  }));
  const thread = new Thread("many", new ContextStack());
  const viewer = await startViewer({ port: 0, configDir: root, analyticsDir: join(root, "analytics"), localStore: null,
    harness: new Harness(thread), eventStream: new EventStream(), interventions: new InterventionLog(thread.signals),
    kingdomRuntimes: kingdoms.map(item => item.runtime) });
  const base = `http://127.0.0.1:${viewer.server.port}`;
  try {
    expect(viewer.kingdomRuntimes.connected).toBe(true);
    await waitFor(() => kingdoms.every(item => item.state.polls === 1));
    for (const item of kingdoms) expect(item.kingdom.statuses.map(status => status.installationId)).toEqual([item.runtime.installationId]);

    kingdoms[1]!.kingdom.push(kingdoms[1]!.runtime.installationId);
    await waitFor(() => kingdoms[1]!.state.polls === 2);
    expect(kingdoms[0]!.state.polls).toBe(1);

    kingdoms[0]!.state.allowed = false;
    kingdoms[0]!.kingdom.revoke(kingdoms[0]!.runtime.installationId);
    await waitFor(() => viewer.kingdomRuntimes.get(kingdoms[0]!.runtime)?.connected === false);
    expect(viewer.kingdomRuntimes.get(kingdoms[1]!.runtime)?.connected).toBe(true);
    expect((await fetch(`${base}/api/tunnel`)).status).toBe(503);
    const status = await (await fetch(`${base}/api/kingdom/status`)).json();
    expect(status.status).toBe("unavailable");
    expect(status.runtimes.map((runtime: { status: string }) => runtime.status)).toEqual(["unavailable", "connected"]);

    const disconnected = await fetch(`${base}/api/kingdom/disconnect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: kingdoms[0]!.runtime.url, installationId: kingdoms[0]!.runtime.installationId }) });
    expect((await disconnected.json()).runtimes).toEqual([{ url: kingdoms[1]!.runtime.url, installationId: kingdoms[1]!.runtime.installationId, status: "connected" }]);
    expect((await fetch(`${base}/api/tunnel`)).status).toBe(200);

    await closeKingdomRuntimeForUpdate(60000);
    await waitFor(() => kingdoms[1]!.kingdom.closes.some(close => close.code === RUNTIME_UPDATE_CLOSE_CODE));
  } finally {
    viewer.server.stop(true);
    for (const item of kingdoms) item.kingdom.stop();
    await rm(root, { recursive: true, force: true });
  }
});
