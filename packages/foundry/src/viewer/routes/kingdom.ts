import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Hono } from "hono";
import { ConfigStore } from "../config";
import { kastleUrl } from "../../providers/kastle-client";
import { writePrivateJson } from "../../providers/kastle-credential-file";
import { KingdomRuntimeConnection } from "../../providers/kingdom-runtime-connection";
import type { RuntimeJobRegistry } from "../../providers/runtime-job-handler";

const beginSchema = z.object({ url: z.string().transform(kastleUrl), name: z.string().trim().min(1).max(120) }).strict();
const pairSchema = z.object({ data: z.object({ deviceCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/), userCode: z.string().regex(/^[A-F0-9]{12}$/), verificationUrl: z.string().url(), expiresAt: z.string().datetime() }) });
const pollSchema = z.object({ data: z.discriminatedUnion("status", [z.object({ status: z.literal("pending") }), z.object({ status: z.literal("approved"), installationId: z.string().uuid() })]) });

export function registerKingdomRoutes(app: Hono, store: ConfigStore, configDir: string, sessionCount: () => number, activate: (connection: KingdomRuntimeConnection | null) => void, connected: () => boolean, handlers?: RuntimeJobRegistry) {
  let pending: { url: string; secret: string; deviceCode: string; userCode: string; verificationUrl: string; expiresAt: string } | undefined;
  let busy = false, lastPoll = 0;
  const request = async (url: string, action: string, body: unknown) => {
    const response = await fetch(`${url}/api/v1/access/${action}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000), headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) { await response.body?.cancel(); throw Error("Kingdom refused the request. Check the address or start pairing again."); }
    return response.json();
  };
  const status = async () => {
    const config = await store.load();
    if (pending && Date.parse(pending.expiresAt) <= Date.now()) pending = undefined;
    if (!pending && config.kingdomRuntime) return { status: connected() ? "connected" : "unavailable", url: config.kingdomRuntime.url, installationId: config.kingdomRuntime.installationId };
    return pending ? { status: "pending", url: pending.url, userCode: pending.userCode, verificationUrl: pending.verificationUrl, expiresAt: pending.expiresAt } : { status: "disconnected" };
  };
  app.use("/api/kingdom/*", async (c, next) => { c.header("Cache-Control", "no-store"); return next(); });
  app.get("/api/kingdom/status", async c => c.json(await status()));
  app.post("/api/kingdom/pair", async c => {
    if (busy) return c.json({ error: "Connection operation in progress" }, 409);
    busy = true;
    try {
      const parsed = beginSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "Enter an HTTPS Kingdom API address (HTTP is allowed only on localhost) and a runtime name." }, 400);
      if ((await status()).status === "pending") return c.json({ error: "Already connected or pairing; cancel pending pairing first." }, 409);
      const directory = resolve(configDir);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw Error("Configuration directory must be owned by this user.");
      await chmod(directory, 0o700);
      const secret = `kastle_runtime_${randomBytes(32).toString("base64url")}`;
      const { data } = pairSchema.parse(await request(parsed.data.url, "pairRuntime", { name: parsed.data.name, keyHash: createHash("sha256").update(secret).digest("hex") }));
      const verification = new URL(data.verificationUrl);
      kastleUrl(verification.origin);
      if (verification.username || verification.password || (new URL(parsed.data.url).protocol === "https:" && verification.protocol !== "https:"))
        throw Error("Kingdom returned an unsafe login address.");
      pending = { ...data, url: parsed.data.url, secret };
      lastPoll = 0;
      return c.json(await status());
    } catch { return c.json({ error: "Could not start pairing. Check your Kingdom API address and private configuration directory." }, 400); }
    finally { busy = false; }
  });
  app.post("/api/kingdom/poll", async c => {
    if (busy) return c.json({ error: "Connection operation in progress" }, 409);
    busy = true;
    try {
      const current = await status();
      if (!pending || current.status !== "pending" || Date.now() - lastPoll < 5000) return c.json(current);
      lastPoll = Date.now();
      const { data } = pollSchema.parse(await request(pending.url, "pollRuntime", { deviceCode: pending.deviceCode }));
      if (data.status === "pending") return c.json(current);
      const credentialFile = join(resolve(configDir), `kingdom-runtime-${data.installationId}.json`);
      await writePrivateJson(credentialFile, { secret: pending.secret });
      const settings = { url: pending.url, installationId: data.installationId, credentialFile };
      const connection = new KingdomRuntimeConnection(settings, sessionCount, fetch, handlers);
      try {
        await connection.start();
        const config = await store.load();
        
        await store.save({ ...config, kingdomRuntime: settings });
        activate(connection);
      } catch (error) { connection.stop(); await unlink(credentialFile).catch(() => {}); throw error; }
      pending = undefined;
      return c.json(await status());
    } catch { return c.json({ error: "Connection not completed. Retry, or check the runtime in Kingdom before starting again." }, 503); }
    finally { busy = false; }
  });
  app.post("/api/kingdom/cancel", async c => {
    if (busy) return c.json({ error: "Connection operation in progress" }, 409);
    pending = undefined;
    return c.json(await status());
  });
  app.post("/api/kingdom/disconnect", async c => {
    if (busy) return c.json({ error: "Connection operation in progress" }, 409);
    busy = true;
    try {
      pending = undefined;
      const { kingdomRuntime, ...config } = await store.load();
      if (kingdomRuntime) {
        await store.save(config);
        activate(null);
        await unlink(kingdomRuntime.credentialFile).catch(() => {});
      }
      return c.json(await status());
    } finally { busy = false; }
  });
}
