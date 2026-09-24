import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KingdomRuntimeConnection } from "../src/providers/kingdom-runtime-connection";
import { startViewer } from "../src/viewer/server";
import { ContextStack, EventStream, Harness, InterventionLog, Thread } from "@inixiative/foundry-core";

test("two HTTP viewers bind separate Kingdom identities and deny use after revocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "kingdom-connect-"));
  const allowed = new Map<string, string>();
  const bodies: { sessionCount: number }[] = [];
  const kingdom = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const identity = allowed.get(request.headers.get("authorization") ?? "");
    if (!identity) return new Response("denied", { status: 401 });
    if (new URL(request.url).pathname === "/api/v1/access/pollRuntimeJob") return Response.json({ data: null });
    bodies.push(await request.json() as { sessionCount: number });
    return Response.json({ data: { installationId: identity, kastleId: "11111111-1111-4111-8111-111111111111", expiresAt: new Date(Date.now() + 60000).toISOString() } });
  } });
  const viewers: Awaited<ReturnType<typeof startViewer>>[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const directory = await mkdtemp(join(root, "viewer-"));
      const id = crypto.randomUUID(), token = `kastle_runtime_${String(index).repeat(43)}`;
      const credentialFile = join(directory, "runtime.json");
      await writeFile(credentialFile, JSON.stringify({ secret: token }), { mode: 0o600 });
      allowed.set(`Bearer ${token}`, id);
      const thread = new Thread(`runtime-${index}`, new ContextStack());
      viewers.push(await startViewer({ port: 0, configDir: directory, analyticsDir: join(directory, "analytics"), localStore: null,
        harness: new Harness(thread), eventStream: new EventStream(), interventions: new InterventionLog(thread.signals),
        kingdomRuntime: { url: `http://127.0.0.1:${kingdom.port}`, installationId: id, credentialFile },
      }));
    }
    const get = (index: number) => fetch(`http://127.0.0.1:${viewers[index].server.port}/api/tunnel`);
    expect((await get(0)).status).toBe(200);
    expect((await get(1)).status).toBe(200);
    expect(bodies.every(body => body.sessionCount === 1)).toBe(true);
    allowed.delete(`Bearer kastle_runtime_${"0".repeat(43)}`);
    expect((await get(0)).status).toBe(503);
    expect(viewers[0].kingdomConnection?.connected).toBe(false);
    expect((await get(1)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${viewers[1].server.port}/api/tunnel`, { headers: { origin: "https://evil.test" } })).status).toBe(403);
  } finally {
    for (const viewer of viewers) viewer.server.stop(true);
    kingdom.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("connection identity mismatch and non-private credentials fail without returning secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kingdom-credential-"));
  const credentialFile = join(directory, "runtime.json"), secret = `kastle_runtime_${"a".repeat(43)}`;
  await writeFile(credentialFile, JSON.stringify({ secret }), { mode: 0o600 });
  const transport = (async () => Response.json({ data: { installationId: crypto.randomUUID(), kastleId: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60000).toISOString() } })) as typeof fetch;
  const connection = new KingdomRuntimeConnection({ url: "https://kingdom.test", installationId: crypto.randomUUID(), credentialFile }, () => 0, transport);
  try {
    await expect(connection.check()).rejects.toThrow("Kingdom runtime unavailable");
    expect(connection.connected).toBe(false);
  } finally { connection.stop(); await rm(directory, { recursive: true, force: true }); }
});
