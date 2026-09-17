import { Hono } from "hono";
import type { ConfigStore } from "../config";
import { GlossError, GlossService, type GlossAction } from "../gloss/service";

const actions = new Set(["install", "setup", "harvest", "fix", "check"]);
const displays = new Set(["margin", "hover", "inline"]);

export function registerGlossRoutes(parent: Hono, configStore: ConfigStore, service = new GlossService()) {
  const app = new Hono();
  const base = "";
  app.onError((error, c) => c.json({ error: error.message }, error instanceof GlossError ? error.status : 400));
  app.use(`${base}/*`, async (c, next) => {
    // These routes can change source files. Reject browser cross-origin writes
    // even when the local viewer has no tunnel authentication enabled.
    if (!["GET", "HEAD"].includes(c.req.method)) {
      const origin = c.req.header("Origin");
      if (c.req.header("Sec-Fetch-Site") === "cross-site" || (origin && origin !== new URL(c.req.url).origin)) {
        return c.json({ error: "Cross-origin Gloss writes are forbidden" }, 403);
      }
      if (!c.req.header("Content-Type")?.startsWith("application/json")) return c.json({ error: "Expected JSON" }, 415);
    }
    try { await next(); }
    catch (error) { return c.json({ error: (error as Error).message }, error instanceof GlossError ? error.status : 400); }
  });

  const project = async (id: string) => {
    const config = await configStore.load();
    const found = Object.hasOwn(config.projects, id) ? config.projects[id] : undefined;
    if (!found) throw new GlossError("Project not found", 404);
    return found;
  };

  app.get(`${base}/status`, async c => {
    const p = await project(c.req.param("id") ?? "");
    return c.json({ ...service.status(p.path), settings: p.gloss ?? { enabled: false, display: "margin" } });
  });
  app.put(`${base}/settings`, async c => {
    const id = c.req.param("id") ?? "";
    const p = await project(id);
    const body = await c.req.json();
    if (!body || typeof body.enabled !== "boolean" || !displays.has(body.display) ||
        Object.keys(body).some(k => k !== "enabled" && k !== "display")) throw new GlossError("Invalid Gloss settings");
    await configStore.patch("projects", { [id]: { ...p, gloss: body } });
    return c.json({ settings: body });
  });
  for (const action of ["list", "read", "detail", "history"] as const) {
    app.get(`${base}/${action}`, async c => {
      const p = await project(c.req.param("id") ?? "");
      return c.json(await service.run(p.path, action, c.req.query("file"), c.req.query("symbol"), c.req.query("snapshot")) as object);
    });
  }
  app.post(`${base}/actions`, async c => {
    const p = await project(c.req.param("id") ?? "");
    const body = await c.req.json();
    if (!body || !actions.has(body.action) || (body.file !== undefined && typeof body.file !== "string")) {
      throw new GlossError("Invalid Gloss operation");
    }
    if (body.action !== "check") {
      if (!p.gloss?.enabled) throw new GlossError("Enable Gloss maintenance first", 409);
      if (body.confirmed !== true) throw new GlossError("Explicit confirmation is required", 409);
    }
    return c.json(await service.run(p.path, body.action as GlossAction, body.file) as object);
  });
  parent.route("/api/projects/:id/gloss", app);
}
