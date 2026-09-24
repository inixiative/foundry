import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { enrollLocalDevice, localInventory, readLocalDevice } from "../src/devices/local-inventory";
import { ConfigStore } from "../src/viewer/config";
import { registerDeviceRoutes } from "../src/viewer/routes/devices";

test("device identity survives duplicate enrollment and registered project identities stay separate", () => {
  const dir = mkdtempSync(join(tmpdir(), "foundry-device-")), path = join(dir, "device.json");
  try {
    expect(readLocalDevice(path)).toBeNull();
    const device = enrollLocalDevice("Local test device", path);
    expect(enrollLocalDevice("Another label", path)).toEqual(device);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const projects = { A: { id: "A", path: dir }, B: { id: "B", path: dir }, C: { id: "C", path: dir, enabled: false } };
    const inventory = localInventory(projects, path);
    expect(inventory.checkouts.map(c => c.projectId)).toEqual(["A", "B"]);
    expect(new Set(inventory.checkouts.map(c => c.id)).size).toBe(2);
    expect(localInventory(projects, path)).toEqual(inventory);
    expect(localInventory({ A: { id: "A", path: join(dir, "other") } }, path).checkouts[0]!.id).not.toBe(inventory.checkouts[0]!.id);
    writeFileSync(path, "corrupt synthetic identity");
    expect(() => enrollLocalDevice("New", path)).toThrow("preserved");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("device routes expose only enrolled local identity and explicitly registered projects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foundry-device-route-")), path = join(dir, "device.json");
  try {
    const store = new ConfigStore(dir);
    await store.patch("projects", { A: { id: "A", path: dir, label: "Project A" } });
    const app = new Hono(); registerDeviceRoutes(app, store, path);
    expect(await (await app.request("/api/devices")).json()).toEqual({ scope: "local", device: null, checkouts: [] });
    expect((await app.request("/api/devices/local", { method: "POST", body: "{}" })).status).toBe(400);
    const response = await app.request("/api/devices/local", { method: "POST", body: JSON.stringify({ name: "Test machine" }) });
    expect(response.status).toBe(200);
    const inventory = await (await app.request("/api/devices")).json();
    expect(inventory.device.name).toBe("Test machine");
    expect(inventory.checkouts[0].projectId).toBe("A");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
