import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startArchiveServer } from "@inixiative/session-archive/server";
import { beginKingdomPairing, completeKingdomPairing, disconnectKingdom, pollKingdomPairing } from "../src/providers/kingdom-pairing";
import { KingdomRuntimeConnection } from "../src/providers/kingdom-runtime-connection";
import { kingdomStatus, pairKingdom } from "../src/providers/kingdom-cli";
import { runArchiveSetup } from "../src/archives/setup";
import { inspectReadiness } from "../src/readiness";
import { ConfigStore } from "../src/viewer/config";

const P1 = "d8deab98-d4a6-43d9-9e65-ae783e58ae42", P2 = "22222222-2222-4222-8222-222222222222", P3 = "33333333-3333-4333-8333-333333333333";
const viewerPort = process.env.VIEWER_PORT;
beforeAll(() => {
  // Never probe a real local viewer: point the running-viewer check at a closed port.
  const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  process.env.VIEWER_PORT = String(closed.port);
  closed.stop(true);
});
afterAll(() => { if (viewerPort === undefined) delete process.env.VIEWER_PORT; else process.env.VIEWER_PORT = viewerPort; });

/** Kingdom's access + archive surface: pairing approves on first poll unless held; heartbeat trusts approved hashes. */
function mockKingdom(options: { expiresInMs?: number; hold?: boolean; connections?: unknown[] } = {}) {
  const hashes = new Map<string, string>(), pairings = new Map<string, { hash: string; installationId: string }>();
  const calls: { action: string; body: any }[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const path = new URL(request.url).pathname, body = await request.json().catch(() => ({})) as any;
    const action = path.replace(/^\/api\/v1\//, "");
    calls.push({ action, body });
    if (action === "access/pairRuntime") {
      const deviceCode = "d".repeat(40) + String(pairings.size).padStart(3, "0");
      pairings.set(deviceCode, { hash: body.keyHash, installationId: crypto.randomUUID() });
      return Response.json({ data: { deviceCode, userCode: "ABCDEF012345", interval: 1, expiresAt: new Date(Date.now() + (options.expiresInMs ?? 60000)).toISOString(), verificationUrl: `http://127.0.0.1:${server.port}/dashboard?connectFoundry=ABCDEF012345` } });
    }
    if (action === "access/pollRuntime") {
      const pairing = pairings.get(body.deviceCode);
      if (!pairing) return new Response("expired", { status: 404 });
      if (options.hold) return Response.json({ data: { status: "pending" } });
      hashes.set(pairing.hash, pairing.installationId);
      return Response.json({ data: { status: "approved", installationId: pairing.installationId } });
    }
    const token = request.headers.get("authorization")?.replace("Bearer ", "") ?? "";
    const installationId = hashes.get(createHash("sha256").update(token).digest("hex"));
    if (!installationId) return new Response("revoked", { status: 401 });
    if (action === "access/runtimeHeartbeat")
      return Response.json({ data: { installationId, userId: null, owner: { ownerModel: "User", userId: crypto.randomUUID() }, expiresAt: new Date(Date.now() + 60000).toISOString() } });
    if (action === "archive/remote/connections")
      return Response.json({ data: options.connections ?? [{ id: "conn-a", name: "Team archive", groups: [], projectId: P1 }, { id: "conn-b", name: "Other", groups: [], projectId: "elsewhere" }] });
    if (action === "archive/remote/search" || action === "archive/search") return Response.json({ data: { archives: [] } });
    return new Response("unknown", { status: 404 });
  } });
  return { server, url: `http://127.0.0.1:${server.port}`, calls, revokeAll: () => hashes.clear() };
}

async function configDirectory(projects: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "foundry-kingdom-setup-"));
  const store = new ConfigStore(dir);
  await store.load();
  await store.update(draft => { for (const id of projects) draft.projects[id] = { id, path: `/tmp/${id}`, label: `Project ${id.slice(0, 4)}` }; });
  return dir;
}

test("shared pairing sends only the key hash, persists privately on approval and leaves nothing when verification fails", async () => {
  const kingdom = mockKingdom(), dir = await configDirectory();
  try {
    await expect(beginKingdomPairing({ url: kingdom.url, name: "Test" }, dir, (async () => Response.json({ data: { deviceCode: "d".repeat(43), userCode: "ABCDEF012345", expiresAt: new Date(Date.now() + 60000).toISOString(), verificationUrl: "http://evil.example/approve" } })) as unknown as typeof fetch)).rejects.toThrow();
    const pairing = await beginKingdomPairing({ url: kingdom.url, name: "Test" }, dir);
    const sent = kingdom.calls.find(call => call.action === "access/pairRuntime")!.body;
    expect(sent).toEqual({ name: "Test", keyHash: createHash("sha256").update(pairing.secret).digest("hex") });
    expect(pairing.secret).toStartWith("kastle_runtime_");
    expect(pairing.interval).toBe(1);
    expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    const approved = await pollKingdomPairing(pairing);
    if (approved.status !== "approved") throw Error("expected approval");

    const store = new ConfigStore(dir);
    const refused = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    await expect(completeKingdomPairing(store, dir, pairing, approved.installationId, { connect: s => new KingdomRuntimeConnection(s, () => 0, refused), start: false })).rejects.toThrow();
    expect(await readdir(dir)).not.toContain(`kingdom-runtime-${approved.installationId}.json`);
    expect((await store.load()).kingdomRuntime).toBeUndefined();

    const { settings } = await completeKingdomPairing(store, dir, pairing, approved.installationId, { connect: s => new KingdomRuntimeConnection(s, () => 0), start: false });
    expect((await lstat(settings.credentialFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(settings.credentialFile, "utf8"))).toEqual({ secret: pairing.secret });
    const saved = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    expect(saved.kingdomRuntime).toEqual({ url: kingdom.url, installationId: approved.installationId, credentialFile: settings.credentialFile });
    expect(JSON.stringify(saved)).not.toContain(pairing.secret);

    let removed = false;
    expect((await disconnectKingdom(store, () => { removed = true; }))?.installationId).toBe(approved.installationId);
    expect(removed).toBe(true);
    await expect(lstat(settings.credentialFile)).rejects.toThrow();
    expect(await disconnectKingdom(store)).toBeUndefined();
  } finally { kingdom.server.stop(true); await rm(dir, { recursive: true, force: true }); }
});

test("CLI pairing polls at Kingdom's interval, opens the approval page and persists like the viewer; replacing needs --replace", async () => {
  const kingdom = mockKingdom(), dir = await configDirectory();
  const lines: string[] = [], waits: number[] = [], opened: string[] = [];
  try {
    const result = await pairKingdom({ configDir: dir, url: kingdom.url, name: "CLI Foundry", log: line => lines.push(line), sleep: async ms => { waits.push(ms); }, launch: url => opened.push(url) });
    expect(result).toMatchObject({ status: "connected", url: kingdom.url, restartViewer: false });
    expect(waits).toEqual([1000]);
    expect(opened).toEqual([`${kingdom.url}/dashboard?connectFoundry=ABCDEF012345`]);
    expect(lines.join("\n")).toContain("ABCDEF012345");
    const saved = (await new ConfigStore(dir).load()).kingdomRuntime!;
    expect(saved.credentialFile).toBe(join(dir, `kingdom-runtime-${result.installationId}.json`));
    expect(kingdom.calls.filter(call => call.action === "access/runtimeHeartbeat")).toHaveLength(1);
    expect(await kingdomStatus(dir)).toEqual({ status: "connected", url: kingdom.url, installationId: result.installationId });
    await expect(pairKingdom({ configDir: dir, url: kingdom.url, log: () => {}, sleep: async () => {} })).rejects.toThrow("--replace");
    kingdom.revokeAll();
    expect((await kingdomStatus(dir)).status).toBe("unavailable");
  } finally { kingdom.server.stop(true); await rm(dir, { recursive: true, force: true }); }
});

test("CLI pairing stops at expiry without writing a credential or binding", async () => {
  const kingdom = mockKingdom({ expiresInMs: 150, hold: true }), dir = await configDirectory();
  try {
    await expect(pairKingdom({ configDir: dir, url: kingdom.url, open: false, log: () => {}, sleep: () => Bun.sleep(60) })).rejects.toThrow("expired");
    expect(kingdom.calls.filter(call => call.action === "access/pollRuntime").length).toBeGreaterThan(0);
    expect((await readdir(dir)).filter(name => name.startsWith("kingdom-runtime-"))).toEqual([]);
    expect((await new ConfigStore(dir).load()).kingdomRuntime).toBeUndefined();
    expect(await kingdomStatus(dir)).toEqual({ status: "disconnected" });
  } finally { kingdom.server.stop(true); await rm(dir, { recursive: true, force: true }); }
});

test("non-interactive setup pairs, connects matching Kingdom connections and direct Archives through verification, and doctor reports the state", async () => {
  const kingdom = mockKingdom(), dir = await configDirectory([P1, P2, P3]);
  const token = "synthetic-direct-archive-token-0001";
  const hosted = startArchiveServer({ store: ":memory:", token, port: 0 });
  const archivesPath = join(dir, "archives.json");
  await writeFile(archivesPath, JSON.stringify([{ kind: "archive", projectId: P3, url: "https://existing.example/", tokenEnv: "EXISTING_TOKEN" }]), { mode: 0o600 });
  process.env.FOUNDRY_TEST_ARCHIVE_TOKEN = token;
  try {
    const skipped = await runArchiveSetup({ configDir: dir, log: () => {} });
    expect(skipped.kingdom.status).toBe("disconnected");
    expect(skipped.projects).toEqual([
      { projectId: P1, status: "skipped", reason: "Kingdom is not connected and no --archive-url was given." },
      { projectId: P2, status: "skipped", reason: "Kingdom is not connected and no --archive-url was given." },
      { projectId: P3, status: "configured" },
    ]);

    const result = await runArchiveSetup({ configDir: dir, kingdomUrl: kingdom.url, name: "Setup Foundry", open: false, sleep: async () => {}, log: () => {},
      archiveUrl: hosted.server.url.href, archiveTokenEnv: "FOUNDRY_TEST_ARCHIVE_TOKEN" });
    expect(result.kingdom.status).toBe("connected");
    expect(result.restartViewer).toBe(false);
    expect(result.projects).toEqual([{ projectId: P1, status: "connected" }, { projectId: P2, status: "connected" }, { projectId: P3, status: "configured" }]);
    const saved = JSON.parse(await readFile(archivesPath, "utf8"));
    expect(saved).toHaveLength(3);
    expect(saved.find((d: any) => d.projectId === P1)).toEqual({ kind: "kingdom", projectId: P1, url: `${kingdom.url}/`, connectionId: "conn-a", credential: { type: "kingdom-runtime" } });
    const direct = saved.find((d: any) => d.projectId === P2);
    expect(direct).toMatchObject({ kind: "archive", url: hosted.server.url.href, credential: { type: "managed" } });
    expect(JSON.stringify(saved)).not.toContain(token);
    expect((await lstat(join(dir, "credentials", `${direct.credential.id}.json`))).mode & 0o777).toBe(0o600);
    expect(kingdom.calls.filter(call => call.action === "archive/remote/search")).toHaveLength(1);

    const config = await new ConfigStore(dir).load();
    const live = await inspectReadiness(config, { configDir: dir, transport: fetch, environment: {}, which: () => "/controlled/cli" });
    expect(live.kingdom).toMatchObject({ status: "connected", url: kingdom.url });
    expect(live.archives).toEqual([
      { projectId: P1, status: "configured", destinations: 1 },
      { projectId: P2, status: "configured", destinations: 1 },
      { projectId: P3, status: "verification-failing", destinations: 1 },
    ]);
    expect(live.issues.filter(item => item.code.startsWith("archive") || item.code.startsWith("kingdom")).map(item => [item.scope, item.code]))
      .toEqual([[P3, "archive-destination-failing"]]);
    const offline = await inspectReadiness(config, { configDir: dir, environment: {}, which: () => "/controlled/cli" });
    expect(offline.kingdom?.status).toBe("unverified");
    expect(offline.archives?.every(item => item.status === "configured")).toBe(true);

    kingdom.revokeAll();
    const revoked = await inspectReadiness(config, { configDir: dir, transport: fetch, environment: {}, which: () => "/controlled/cli" });
    expect(revoked.kingdom?.status).toBe("unavailable");
    expect(revoked.configurationReady).toBe(false);
    expect(revoked.issues.map(item => item.code)).toContain("kingdom-unavailable");
    expect(revoked.archives?.find(item => item.projectId === P1)?.status).toBe("verification-failing");
    expect(JSON.stringify(revoked)).not.toContain(token);
  } finally {
    delete process.env.FOUNDRY_TEST_ARCHIVE_TOKEN;
    kingdom.server.stop(true);
    await hosted.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("setup picks only the named connection and never guesses between several", async () => {
  const kingdom = mockKingdom({ connections: [{ id: "one", projectId: P1 }, { id: "two", projectId: P1 }] }), dir = await configDirectory([P1]);
  try {
    await pairKingdom({ configDir: dir, url: kingdom.url, open: false, log: () => {}, sleep: async () => {} });
    expect((await runArchiveSetup({ configDir: dir, log: () => {} })).projects).toEqual([{ projectId: P1, status: "skipped", reason: "Several Kingdom connections carry this project; pass --connection." }]);
    expect((await runArchiveSetup({ configDir: dir, connection: "missing", log: () => {} })).projects[0]!.status).toBe("skipped");
    expect((await runArchiveSetup({ configDir: dir, connection: "two", log: () => {} })).projects).toEqual([{ projectId: P1, status: "connected" }]);
    expect(JSON.parse(await readFile(join(dir, "archives.json"), "utf8"))[0].connectionId).toBe("two");
  } finally { kingdom.server.stop(true); await rm(dir, { recursive: true, force: true }); }
});

test("guided prompts offer matching connections, Kingdom storage, a direct server or skip", async () => {
  const kingdom = mockKingdom(), dir = await configDirectory([P1, P2]);
  const asked: string[][] = [];
  const answers = [0, 0];
  const prompts = {
    ask: async (_: string, fallback?: string) => fallback === undefined ? "" : (fallback.startsWith("http") ? kingdom.url : fallback),
    confirm: async () => true,
    secret: async () => "",
    choose: async (_: string, options: string[]) => { asked.push(options); return answers.shift()!; },
  };
  try {
    const result = await runArchiveSetup({ configDir: dir, prompts, open: false, sleep: async () => {}, log: () => {} });
    expect(result.kingdom.status).toBe("connected");
    expect(asked).toEqual([
      ["Kingdom connection: Team archive (conn-a)", "Kingdom-stored archives", "Direct Archive server (URL + token)", "Skip"],
      ["Kingdom-stored archives", "Direct Archive server (URL + token)", "Skip"],
    ]);
    const saved = JSON.parse(await readFile(join(dir, "archives.json"), "utf8"));
    expect(saved.map((d: any) => [d.projectId, d.connectionId ?? null])).toEqual([[P1, "conn-a"], [P2, null]]);
  } finally { kingdom.server.stop(true); await rm(dir, { recursive: true, force: true }); }
});

test("archive setup and kingdom CLIs run the same flow non-interactively", async () => {
  const dir = await configDirectory([P1]);
  const run = async (script: string, args: string[]) => {
    const child = Bun.spawn([process.execPath, new URL(script, import.meta.url).pathname, ...args],
      { env: { PATH: process.env.PATH, VIEWER_PORT: process.env.VIEWER_PORT }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(child.stdout).text();
    return { code: await child.exited, output: JSON.parse(stdout) };
  };
  try {
    const setup = await run("../src/archives/cli.ts", ["setup", "--yes", "--config", join(dir, "archives.json")]);
    expect(setup.code).toBe(0);
    expect(setup.output).toEqual({ kingdom: { status: "disconnected" }, projects: [{ projectId: P1, status: "skipped", reason: "Kingdom is not connected and no --archive-url was given." }], restartViewer: false });
    expect(await run("../src/providers/kingdom-cli.ts", ["status", "--config-dir", dir])).toEqual({ code: 0, output: { status: "disconnected" } });
    expect(await run("../src/providers/kingdom-cli.ts", ["disconnect", "--config-dir", dir])).toEqual({ code: 0, output: { status: "disconnected" } });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
