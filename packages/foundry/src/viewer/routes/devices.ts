import type { Hono } from "hono";
import type { ConfigStore } from "../config";
import { enrollLocalDevice, localInventory } from "../../devices/local-inventory";

/** Mounted behind the viewer's existing operator authentication. */
export function registerDeviceRoutes(app: Hono, configStore: ConfigStore, identityPath?: string): void {
  app.get("/api/devices", async c => {
    try {
      await configStore.load();
      return c.json(localInventory(configStore.config.projects, identityPath));
    } catch { return c.json({ error: "Local device inventory unavailable" }, 503); }
  });
  app.post("/api/devices/local", async c => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "Invalid enrollment request" }, 400); }
    if (!body || typeof body !== "object" || !("name" in body) || typeof body.name !== "string" ||
      !body.name.trim() || body.name.length > 120) return c.json({ error: "Device name must contain 1–120 characters" }, 400);
    try { return c.json({ device: enrollLocalDevice(body.name, identityPath) }); }
    catch { return c.json({ error: "Local device enrollment unavailable; existing identity preserved" }, 503); }
  });
}
