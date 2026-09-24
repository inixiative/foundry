import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { closeKingdomRuntimeForUpdate, KingdomRuntimeConnection, RUNTIME_UPDATE_CLOSE_CODE } from "../src/providers/kingdom-runtime-connection";
import { RuntimeJobRegistry } from "../src/providers/runtime-job-handler";
import { startViewer } from "../src/viewer/server";
import { ContextStack, EventStream, Harness, InterventionLog, Thread } from "@inixiative/foundry-core";
import { startFakeKingdom, waitFor } from "./helpers/fake-kingdom";

const fast = { pingIntervalMs: 40, pongTimeoutMs: 40, reconnectBaseMs: 10 };

const privateRuntime = async (token = `kastle_runtime_${"a".repeat(43)}`) => {
  const directory = await mkdtemp(join(tmpdir(), "kingdom-socket-"));
  const credentialFile = join(directory, "runtime.json");
  await writeFile(credentialFile, JSON.stringify({ secret: token }), { mode: 0o600 });
  return { directory, credentialFile, token, installationId: crypto.randomUUID() };
};

const pollCounter = () => {
  let polls = 0;
  const transport = (async (url: string | URL | Request) => {
    if (new URL(String(url)).pathname.endsWith("/pollRuntimeJob")) polls++;
    return Response.json({ data: null });
  }) as typeof fetch;
  return { transport, polls: () => polls };
};

test("two HTTP viewers bind separate Kingdom identities and deny use after revocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "kingdom-connect-"));
  const allowed = new Map<string, string>();
  const kingdom = startFakeKingdom({
    identify: token => { const installationId = allowed.get(token); return installationId ? { installationId } : undefined; },
    http: request => allowed.has((request.headers.get("authorization") ?? "").replace("Bearer ", ""))
      ? Response.json({ data: null }) : new Response("denied", { status: 401 }),
  });
  const viewers: Awaited<ReturnType<typeof startViewer>>[] = [];
  const ids: string[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const directory = await mkdtemp(join(root, "viewer-"));
      const id = crypto.randomUUID(), token = `kastle_runtime_${String(index).repeat(43)}`;
      const credentialFile = join(directory, "runtime.json");
      await writeFile(credentialFile, JSON.stringify({ secret: token }), { mode: 0o600 });
      allowed.set(token, id);
      ids.push(id);
      const thread = new Thread(`runtime-${index}`, new ContextStack());
      viewers.push(await startViewer({ port: 0, configDir: directory, analyticsDir: join(directory, "analytics"), localStore: null,
        harness: new Harness(thread), eventStream: new EventStream(), interventions: new InterventionLog(thread.signals),
        kingdomRuntime: { url: kingdom.url, installationId: id, credentialFile },
      }));
    }
    const get = (index: number) => fetch(`http://127.0.0.1:${viewers[index].server.port}/api/tunnel`);
    expect((await get(0)).status).toBe(200);
    expect((await get(1)).status).toBe(200);
    expect(ids.map(id => kingdom.statuses.find(status => status.installationId === id)?.frame.sessionCount)).toEqual([1, 1]);
    allowed.delete(`kastle_runtime_${"0".repeat(43)}`);
    kingdom.revoke(ids[0]);
    await waitFor(() => viewers[0].kingdomConnection?.connected === false);
    expect((await get(0)).status).toBe(503);
    expect((await get(1)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${viewers[1].server.port}/api/tunnel`, { headers: { origin: "https://evil.test" } })).status).toBe(403);
  } finally {
    for (const viewer of viewers) viewer.server.stop(true);
    kingdom.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("connection identity mismatch and non-private credentials fail without returning secrets", async () => {
  const runtime = await privateRuntime();
  const kingdom = startFakeKingdom({ identify: () => ({ installationId: crypto.randomUUID() }) });
  const connection = new KingdomRuntimeConnection({ url: kingdom.url, installationId: runtime.installationId, credentialFile: runtime.credentialFile }, () => 0);
  try {
    await expect(connection.check()).rejects.toThrow("Kingdom runtime unavailable");
    expect(connection.connected).toBe(false);
    await chmod(runtime.credentialFile, 0o644);
    const leaky = new KingdomRuntimeConnection({ url: kingdom.url, installationId: runtime.installationId, credentialFile: runtime.credentialFile }, () => 0);
    const error = await leaky.check().catch(caught => caught as Error);
    expect(String(error)).not.toContain(runtime.token);
    expect(leaky.connected).toBe(false);
    leaky.stop();
  } finally { connection.stop(); kingdom.stop(); await rm(runtime.directory, { recursive: true, force: true }); }
});

test("status frames, pushes and the reconnect sweep drive claims without interval polling", async () => {
  const runtime = await privateRuntime();
  const userId = crypto.randomUUID();
  const kingdom = startFakeKingdom({ identify: token => token === runtime.token ? { installationId: runtime.installationId, userId } : undefined });
  const { transport, polls } = pollCounter();
  const verified: string[] = [];
  const handlers = new RuntimeJobRegistry().register({
    kind: "probe", payload: z.unknown(), run: async () => {},
    heartbeatBody: () => ({ medicalProfiles: [] }),
    verifyIdentity: identity => { verified.push(identity.userId); },
  });
  let sessions = 2;
  const connection = new KingdomRuntimeConnection({ url: kingdom.url, installationId: runtime.installationId, credentialFile: runtime.credentialFile }, () => sessions, transport, handlers, fast);
  try {
    await connection.start();
    expect(connection.connected).toBe(true);
    expect(verified).toEqual([userId]);
    await waitFor(() => polls() === 1);
    expect(kingdom.statuses[0]!.frame).toEqual({ action: "runtimeStatus", sessionCount: 2, medicalProfiles: [] });
    await Bun.sleep(150);
    expect(polls()).toBe(1);
    expect(kingdom.pings).toBeGreaterThan(1);
    expect(kingdom.statuses).toHaveLength(1);

    sessions = 3;
    await waitFor(() => kingdom.statuses.length === 2);
    expect(kingdom.statuses[1]!.frame.sessionCount).toBe(3);

    kingdom.push(runtime.installationId);
    await waitFor(() => polls() === 2);

    kingdom.drop(runtime.installationId);
    await waitFor(() => !connection.connected);
    await waitFor(() => connection.connected && polls() === 3);
    expect(kingdom.connections(runtime.installationId)).toBe(1);
  } finally { connection.stop(); kingdom.stop(); await rm(runtime.directory, { recursive: true, force: true }); }
});

test("a Kingdom that stops answering pings is abandoned and reconnected", async () => {
  const runtime = await privateRuntime();
  const kingdom = startFakeKingdom({ identify: () => ({ installationId: runtime.installationId }) });
  const { transport, polls } = pollCounter();
  const connection = new KingdomRuntimeConnection({ url: kingdom.url, installationId: runtime.installationId, credentialFile: runtime.credentialFile }, () => 0, transport, undefined, fast);
  try {
    await connection.start();
    kingdom.answerPings = false;
    await waitFor(() => !connection.connected);
    kingdom.answerPings = true;
    await waitFor(() => connection.connected && polls() >= 2);
    await waitFor(() => kingdom.connections(runtime.installationId) === 1);
  } finally { connection.stop(); kingdom.stop(); await rm(runtime.directory, { recursive: true, force: true }); }
});

test("revocation closes the socket, blocks the viewer check and keeps backing off", async () => {
  const runtime = await privateRuntime();
  let allowed = true;
  const kingdom = startFakeKingdom({ identify: () => allowed ? { installationId: runtime.installationId } : undefined });
  const connection = new KingdomRuntimeConnection({ url: kingdom.url, installationId: runtime.installationId, credentialFile: runtime.credentialFile }, () => 0, pollCounter().transport, undefined, fast);
  try {
    await connection.start();
    allowed = false;
    kingdom.revoke(runtime.installationId);
    await waitFor(() => !connection.connected);
    const before = kingdom.closes.length;
    for (let index = 0; index < 5; index++) await expect(connection.check()).rejects.toThrow("Kingdom runtime unavailable");
    expect(kingdom.closes.length - before).toBeLessThanOrEqual(1);
    expect(kingdom.closes.some(close => close.code === 4401)).toBe(true);
    allowed = true;
    await waitFor(() => connection.connected, 5000);
  } finally { connection.stop(); kingdom.stop(); await rm(runtime.directory, { recursive: true, force: true }); }
});

test("closeKingdomRuntimeForUpdate closes every live socket with the update reason and stays closed", async () => {
  const runtime = await privateRuntime();
  const kingdom = startFakeKingdom({ identify: () => ({ installationId: runtime.installationId }) });
  const connection = new KingdomRuntimeConnection({ url: kingdom.url, installationId: runtime.installationId, credentialFile: runtime.credentialFile }, () => 0, pollCounter().transport, undefined, fast);
  try {
    await connection.start();
    await closeKingdomRuntimeForUpdate(60000);
    await waitFor(() => kingdom.closes.length === 1);
    expect(kingdom.closes[0]).toEqual({ installationId: runtime.installationId, code: RUNTIME_UPDATE_CLOSE_CODE, reason: JSON.stringify({ reason: "updating", expectedBackWithinMs: 60000 }) });
    expect(connection.connected).toBe(false);
    await Bun.sleep(100);
    expect(kingdom.connections(runtime.installationId)).toBe(0);
    await expect(connection.check()).rejects.toThrow("Kingdom runtime unavailable");
    await closeKingdomRuntimeForUpdate(60000);
    expect(kingdom.closes).toHaveLength(1);
  } finally { connection.stop(); kingdom.stop(); await rm(runtime.directory, { recursive: true, force: true }); }
});

test("stop closes cleanly and never reconnects", async () => {
  const runtime = await privateRuntime();
  const kingdom = startFakeKingdom({ identify: () => ({ installationId: runtime.installationId }) });
  const connection = new KingdomRuntimeConnection({ url: kingdom.url, installationId: runtime.installationId, credentialFile: runtime.credentialFile }, () => 0, pollCounter().transport, undefined, fast);
  try {
    await connection.start();
    connection.stop();
    await waitFor(() => kingdom.closes.length === 1);
    expect(kingdom.closes[0]).toMatchObject({ code: 1000, reason: "Foundry stopped" });
    await Bun.sleep(100);
    expect(kingdom.connections(runtime.installationId)).toBe(0);
  } finally { kingdom.stop(); await rm(runtime.directory, { recursive: true, force: true }); }
});
