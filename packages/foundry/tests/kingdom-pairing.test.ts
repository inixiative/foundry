import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startViewer } from "../src/viewer/server";
import { ContextStack, EventStream, Harness, InterventionLog, Thread } from "@inixiative/foundry-core";

const organization = { ownerModel: "Organization", organizationId: "11111111-1111-4111-8111-111111111111" };

/** Kingdom's pairing + heartbeat surface; `approve` marks the latest pairing approved for an installation. */
function mockKingdom(owner: Record<string, string> = organization) {
  const requests: { deviceCode: string; hash: string; installationId?: string }[] = [];
  const identities = new Map<string, string>();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const action = new URL(request.url).pathname.split("/").at(-1);
    const body = await request.json().catch(() => ({})) as Record<string, string>;
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
    const id = identities.get(createHash("sha256").update(token).digest("hex"));
    if (!id) return new Response("revoked", { status: 401 });
    if (action === "pollRuntimeJob") return Response.json({ data: null });
    return Response.json({ data: { installationId: id, userId: null, owner, expiresAt: new Date(Date.now() + 60000).toISOString() } });
  } });
  return {
    server, url: `http://127.0.0.1:${server.port}`, requests, identities,
    approve(trusted = true) {
      const request = requests.at(-1)!, id = crypto.randomUUID();
      request.installationId = id;
      if (trusted) identities.set(request.hash, id);
      return { id, hash: request.hash };
    },
  };
}

async function viewerFixture() {
  const root = await mkdtemp(join(tmpdir(), "foundry-pairing-"));
  const thread = new Thread("pairing", new ContextStack());
  const viewer = await startViewer({ port: 0, configDir: root, localStore: null, harness: new Harness(thread), eventStream: new EventStream(), interventions: new InterventionLog(thread.signals) });
  const base = `http://127.0.0.1:${viewer.server.port}`;
  const post = (action: string, body: unknown = {}) => fetch(`${base}/api/kingdom/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const status = async () => (await fetch(`${base}/api/kingdom/status`)).json();
  const settings = async () => JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
  return { root, viewer, base, post, status, settings };
}

test("Foundry pairs without exposing secrets, activates immediately, re-pairs revoked enrollment without unlocking work, and disconnects locally", async () => {
  const kingdom = mockKingdom(), f = await viewerFixture();
  const { root, viewer, base, post } = f;
  let credentialPath = "", runtimeId = "";
  try {
    for (let index = 0; index < 2; index++) {
      const staleSettings = await (await fetch(`${base}/api/settings`)).json();
      const start = await post("pair", { url: kingdom.url, name: "Test Foundry", ...(runtimeId ? { replace: runtimeId } : {}) });
      expect(start.status).toBe(200);
      const pairing = await start.json();
      expect(pairing.pending).toMatchObject({ url: kingdom.url, userCode: "ABCDEF012345" });
      expect(JSON.stringify(pairing)).not.toContain("secret"); expect(JSON.stringify(pairing)).not.toContain("deviceCode");
      expect((await post("pair", { url: kingdom.url, name: "Duplicate" })).status).toBe(409);
      const { id, hash } = kingdom.approve();
      const done = await post("poll");
      expect(done.status).toBe(200);
      const connected = await done.json();
      expect(connected.status).toBe("connected");
      expect(connected.runtimes).toHaveLength(1);
      expect(connected.runtimes[0]).toMatchObject({ url: kingdom.url, owner: "Organization::11111111-1111-4111-8111-111111111111:", installationId: id, status: "connected" });
      if (runtimeId) expect(connected.runtimes[0].id).toBe(runtimeId);
      runtimeId = connected.runtimes[0].id;
      expect(viewer.kingdomRuntimes.get(runtimeId)?.connected).toBe(true);
      expect((await fetch(`${base}/api/tunnel`)).status).toBe(200);
      const path = join(root, `kingdom-runtime-${id}.json`);
      if (credentialPath) await expect(lstat(credentialPath)).rejects.toThrow();
      credentialPath = path;
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      expect((await lstat(root)).mode & 0o777).toBe(0o700);
      const { secret } = JSON.parse(await readFile(path, "utf8"));
      expect(createHash("sha256").update(secret).digest("hex")).toBe(hash);
      expect(await readFile(join(root, "settings.json"), "utf8")).not.toContain(secret);
      if (index === 0) {
        const saved = await fetch(`${base}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(staleSettings) });
        expect(saved.status).toBe(200);
        expect((await f.settings()).kingdomRuntimes.map((runtime: { installationId: string }) => runtime.installationId)).toEqual([id]);
        const oldCredential = await readFile(path, "utf8");
        expect((await post("pair", { url: kingdom.url, name: "Failed replacement", replace: runtimeId })).status).toBe(200);
        kingdom.approve(false);
        expect((await post("poll")).status).toBe(503);
        expect(await readFile(path, "utf8")).toBe(oldCredential);
        expect((await f.settings()).kingdomRuntimes.map((runtime: { installationId: string }) => runtime.installationId)).toEqual([id]);
        expect((await fetch(`${base}/api/tunnel`)).status).toBe(200);
        expect((await (await post("cancel")).json()).status).toBe("connected");
      }
      kingdom.identities.delete(hash);
      expect((await fetch(`${base}/api/tunnel`)).status).toBe(503);
      expect((await fetch(`${base}/kingdom`)).status).toBe(200);
      expect((await f.status()).status).toBe("unavailable");
      expect((await fetch(`${base}/api/kingdom/status`, { headers: { origin: "https://evil.test" } })).status).toBe(403);
    }
    expect((await post("disconnect")).status).toBe(400);
    expect((await post("disconnect", { id: "000000000000" })).status).toBe(404);
    expect((await (await post("disconnect", { id: runtimeId })).json()).status).toBe("disconnected");
    expect(viewer.kingdomRuntimes.size).toBe(0);
    expect((await fetch(`${base}/api/tunnel`)).status).toBe(200);
    expect(await f.settings()).not.toHaveProperty("kingdomRuntimes");
    await expect(lstat(credentialPath)).rejects.toThrow();
  } finally { viewer.server.stop(true); kingdom.server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("the viewer pairs a second Kingdom beside the first, keeps working while either authorizes, and disconnects one without touching the other", async () => {
  const a = mockKingdom(), b = mockKingdom({ ownerModel: "User", userId: "22222222-2222-4222-8222-222222222222" }), f = await viewerFixture();
  const { viewer, base, post } = f;
  try {
    const pair = async (kingdom: ReturnType<typeof mockKingdom>) => {
      expect((await post("pair", { url: kingdom.url, name: "Two Kingdoms" })).status).toBe(200);
      const approved = kingdom.approve();
      expect((await post("poll")).status).toBe(200);
      return approved;
    };
    const first = await pair(a);
    const second = await pair(b);
    const state = await f.status();
    expect(state.status).toBe("connected");
    expect(state.runtimes.map((runtime: { url: string; installationId: string }) => [runtime.url, runtime.installationId])).toEqual([[a.url, first.id], [b.url, second.id]]);
    const [idA, idB] = state.runtimes.map((runtime: { id: string }) => runtime.id);
    expect(viewer.kingdomRuntimes.size).toBe(2);

    // A revoked Kingdom leaves the other one authorizing this Foundry.
    a.identities.delete(first.hash);
    expect((await fetch(`${base}/api/tunnel`)).status).toBe(200);
    const degraded = await f.status();
    expect(degraded.status).toBe("unavailable");
    expect(degraded.runtimes.map((runtime: { status: string }) => runtime.status)).toEqual(["unavailable", "connected"]);
    b.identities.delete(second.hash);
    expect((await fetch(`${base}/api/tunnel`)).status).toBe(503);
    b.identities.set(second.hash, second.id);
    expect((await fetch(`${base}/api/tunnel`)).status).toBe(200);

    expect((await post("disconnect", { id: idA })).status).toBe(200);
    const remaining = await f.status();
    expect(remaining.runtimes.map((runtime: { id: string }) => runtime.id)).toEqual([idB]);
    expect(viewer.kingdomRuntimes.get(idA)).toBeUndefined();
    expect(viewer.kingdomRuntimes.get(idB)?.connected).toBe(true);
    expect((await f.settings()).kingdomRuntimes.map((runtime: { url: string }) => runtime.url)).toEqual([b.url]);
    await expect(lstat(join(f.root, `kingdom-runtime-${first.id}.json`))).rejects.toThrow();
    expect((await lstat(join(f.root, `kingdom-runtime-${second.id}.json`))).isFile()).toBe(true);
  } finally { viewer.server.stop(true); a.server.stop(true); b.server.stop(true); await rm(f.root, { recursive: true, force: true }); }
});
