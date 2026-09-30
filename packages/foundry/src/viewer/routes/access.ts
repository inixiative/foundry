import { createHash } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import { accessCredentialSchema, KastleAccessClient, KastleAccessHttpError, kastleAccessSourceSchema } from "../../providers/kastle-access-client";
import { readPrivateJson } from "../../providers/kastle-credential-file";
import { ConfigRevisionError, type ConfigStore, type FoundryConfig } from "../config";

const revision = (config: FoundryConfig) => createHash("sha256").update(JSON.stringify({ sources: config.kastleAccess ?? [], projects: config.projects })).digest("hex");
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Operator configuration only. Saved changes are not installed into live native sessions. */
export function registerAccessRoutes(app: Hono, store: ConfigStore): void {
  // The store serializes writes; checking the scoped revision inside update makes check-and-write atomic.
  const expectRevision = (config: FoundryConfig, expected: string) => { if (revision(config) !== expected) throw new ConfigRevisionError(); };
  app.use("/api/access/*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.get("/api/access/sources", async c => {
    try {
      const config = await store.load();
      const sources = await Promise.all((config.kastleAccess ?? []).map(async source => {
        let credentialStatus: "available" | "unavailable" = "available";
        try { accessCredentialSchema.parse(await readPrivateJson(source.credentialFile)); }
        catch { credentialStatus = "unavailable"; }
        return { ...source, credentialStatus };
      }));
      return c.json({ sources, revision: revision(config), applyMode: "restart", projects: Object.entries(config.projects).map(([id, project]) => ({ id, name: project.label || id, enabled: project.enabled !== false })) });
    } catch { return c.json({ error: "Saved access settings could not be loaded. Check the configuration with doctor." }, 400); }
  });
  app.put("/api/access/sources/:id", async c => {
    const parsed = z.object({ revision: revisionSchema, source: kastleAccessSourceSchema }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || parsed.data.source.id !== c.req.param("id")) return c.json({ error: "Check the grant fields, UUIDs, project selection and absolute credential file path." }, 400);
    try {
      await store.load();
      const next = await store.update(draft => {
        expectRevision(draft, parsed.data.revision);
        const sources = draft.kastleAccess ?? [], index = sources.findIndex(source => source.id === parsed.data.source.id);
        if (index < 0) sources.push(parsed.data.source); else sources[index] = parsed.data.source;
        draft.kastleAccess = sources;
      });
      return c.json({ revision: revision(next), applyMode: "restart" });
    } catch (error) {
      if (error instanceof ConfigRevisionError) return c.json({ error: "Settings changed elsewhere. Reload before saving." }, 409);
      return c.json({ error: "Grant could not be saved. Select an enabled project and check the configuration." }, 400);
    }
  });
  app.delete("/api/access/sources/:id", async c => {
    const parsed = z.object({ revision: revisionSchema }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "A current settings revision is required." }, 400);
    const missing = Error("Grant not found.");
    try {
      await store.load();
      const next = await store.update(draft => {
        expectRevision(draft, parsed.data.revision);
        if (!draft.kastleAccess?.some(source => source.id === c.req.param("id"))) throw missing;
        draft.kastleAccess = draft.kastleAccess.filter(source => source.id !== c.req.param("id"));
      });
      return c.json({ revision: revision(next), applyMode: "restart" });
    } catch (error) {
      if (error instanceof ConfigRevisionError) return c.json({ error: "Settings changed elsewhere. Reload before removing." }, 409);
      if (error === missing) return c.json({ error: missing.message }, 404);
      return c.json({ error: "Grant could not be removed." }, 400);
    }
  });
  app.post("/api/access/sources/:id/check", async c => {
    try {
      const config = await store.load();
      const source = config.kastleAccess?.find(source => source.id === c.req.param("id"));
      if (!source) return c.json({ error: "Grant not found." }, 404);
      const description = await new KastleAccessClient(source).describe();
      return c.json({ status: "available", checkedAt: new Date().toISOString(), revision: revision(config), description });
    } catch (error) {
      const status = error instanceof KastleAccessHttpError && error.status === 401 ? "needs-authentication" : "unavailable";
      return c.json({ status, checkedAt: new Date().toISOString(), message: status === "needs-authentication"
        ? "Kastle rejected this access token. Issue a valid token for this Signet and replace the private file."
        : "Access could not be verified. Check the private file, connection, Signet permissions and Kastle availability." });
    }
  });
}
