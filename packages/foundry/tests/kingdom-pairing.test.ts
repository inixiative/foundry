import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startViewer } from "../src/viewer/server";
import { startFakeKingdom, waitFor } from "./helpers/fake-kingdom";
import { ContextStack, EventStream, Harness, InterventionLog, Thread } from "@inixiative/foundry-core";

test("Foundry pairs without exposing secrets, activates immediately, and repairs revoked enrollment without unlocking work, and disconnects locally", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundry-pairing-"));
  const requests: { deviceCode: string; hash: string; installationId?: string }[] = [];
  const identities = new Map<string, string>();
  const kingdom = startFakeKingdom({ identify: token => {
    const installationId = identities.get(createHash("sha256").update(token).digest("hex"));
    return installationId ? { installationId } : undefined;
  }, async http(request) {
    const action = new URL(request.url).pathname.split("/").at(-1);
    const body = await request.json() as Record<string, string>;
    if (action === "pairRuntime") {
      expect(body).not.toHaveProperty("secret");
      const deviceCode = "d".repeat(42) + requests.length;
      requests.push({ deviceCode, hash: body.keyHash });
      return Response.json({ data: { deviceCode, userCode: "ABCDEF012345", expiresAt: new Date(Date.now() + 60000).toISOString(), verificationUrl: `http://127.0.0.1:3000/dashboard?connectFoundry=ABCDEF012345` } });
    }
    if (action === "pollRuntime") {
      const pairing = requests.find(item => item.deviceCode === body.deviceCode);
      return Response.json({ data: pairing?.installationId ? { status: "approved", installationId: pairing.installationId } : { status: "pending" } });
    }
    const token = request.headers.get("authorization")?.replace("Bearer ", "") ?? "";
    if (!identities.get(createHash("sha256").update(token).digest("hex"))) return new Response("revoked", { status: 401 });
    return Response.json({ data: null });
  } });
  const thread = new Thread("pairing", new ContextStack()), viewer = await startViewer({ port: 0, configDir: root, localStore: null, harness: new Harness(thread), eventStream: new EventStream(), interventions: new InterventionLog(thread.signals) });
  const base = `http://127.0.0.1:${viewer.server.port}`;
  const credentialPaths: string[] = [];
  const settingsRuntimes = async () => (JSON.parse(await readFile(join(root, "settings.json"), "utf8")).kingdomRuntimes ?? []).map((runtime: { installationId: string }) => runtime.installationId);
  const post = (action: string, body: unknown = {}) => fetch(`${base}/api/kingdom/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let previous: string | undefined;
  try {
    for (let index = 0; index < 2; index++) {
      const staleSettings = await (await fetch(`${base}/api/settings`)).json();
      const start = await post("pair", { url: kingdom.url, name: "Test Foundry", ...(previous ? { replaces: previous } : {}) });
      expect(start.status).toBe(200);
      const pairing = await start.json();
      expect(pairing.status).toBe("pending"); expect(pairing).not.toHaveProperty("secret"); expect(pairing).not.toHaveProperty("deviceCode");
      expect((await post("pair", { url: kingdom.url, name: "Duplicate" })).status).toBe(409);
      const request = requests.at(-1)!, id = crypto.randomUUID();
      request.installationId = id; identities.set(request.hash, id);
      const done = await post("poll");
      expect(done.status).toBe(200);
      expect(await done.json()).toEqual({ status: "connected", runtimes: [{ url: kingdom.url, installationId: id, status: "connected" }] });
      expect(viewer.kingdomRuntimes.connected).toBe(true);
      expect(await settingsRuntimes()).toEqual([id]);
      if (previous) await expect(lstat(join(root, `kingdom-runtime-${previous}.json`))).rejects.toThrow();
      expect((await fetch(`${base}/api/tunnel`)).status).toBe(200);
      const path = join(root, `kingdom-runtime-${id}.json`);
      credentialPaths.push(path);
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      expect((await lstat(root)).mode & 0o777).toBe(0o700);
      const { secret } = JSON.parse(await readFile(path, "utf8"));
      expect(createHash("sha256").update(secret).digest("hex")).toBe(request.hash);
      expect(await readFile(join(root, "settings.json"), "utf8")).not.toContain(secret);
      if (index === 0) {
        const saved = await fetch(`${base}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(staleSettings) });
        expect(saved.status).toBe(200);
        expect(await settingsRuntimes()).toEqual([id]);
        const oldCredential = await readFile(path, "utf8");
        expect((await post("pair", { url: kingdom.url, name: "Failed replacement" })).status).toBe(200);
        requests.at(-1)!.installationId = crypto.randomUUID();
        expect((await post("poll")).status).toBe(503);
        expect(await readFile(path, "utf8")).toBe(oldCredential);
        expect(await settingsRuntimes()).toEqual([id]);
        expect((await fetch(`${base}/api/tunnel`)).status).toBe(200);
        expect((await (await post("cancel")).json()).status).toBe("connected");
      }
      identities.delete(request.hash);
      kingdom.revoke(id);
      await waitFor(() => viewer.kingdomRuntimes.connected === false);
      expect((await fetch(`${base}/api/tunnel`)).status).toBe(503);
      expect((await fetch(`${base}/kingdom`)).status).toBe(200);
      expect((await (await fetch(`${base}/api/kingdom/status`)).json()).status).toBe("unavailable");
      expect((await fetch(`${base}/api/kingdom/status`, { headers: { origin: "https://evil.test" } })).status).toBe(403);
      previous = id;
    }
    expect((await post("disconnect")).status).toBe(400);
    expect((await (await post("disconnect", { url: kingdom.url, installationId: previous })).json())).toEqual({ status: "disconnected", runtimes: [] });
    expect(viewer.kingdomRuntimes.size).toBe(0);
    expect((await fetch(`${base}/api/tunnel`)).status).toBe(200);
    expect(await settingsRuntimes()).toEqual([]);
    for (const path of credentialPaths) await expect(lstat(path)).rejects.toThrow();
  } finally { viewer.server.stop(true); kingdom.stop(); await rm(root, { recursive: true, force: true }); }
});
