import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KastleAuthentication } from "../src/providers/kastle-authentication";
import { KastleClient } from "../src/providers/kastle-client";
import { kastleToken } from "../src/providers/kastle-token-helper";
import { readPrivateJson } from "../src/providers/kastle-credential-file";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const secret = (prefix: string) => `${prefix}${"x".repeat(43)}`;

test("Kastle resolves once, persists source identity, and delegates only one-run renewal authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "foundry-kastle-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const kastleId = crypto.randomUUID(), bindingId = crypto.randomUUID();
  const calls: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const action = new URL(request.url).pathname.split("/").pop()!; calls.push(action);
    expect(request.headers.get("authorization")).toBe(`Bearer ${secret("kastle_runtime_")}`);
    if (action === "resolveRun") {
      const body = await request.json() as { runId: string };
      return Response.json({ data: { id: bindingId, kastleId, installationId: crypto.randomUUID(), runId: body.runId, capacityId: crypto.randomUUID(), connectionId: crypto.randomUUID(), model: "bound-model", effort: "low", runtime: "claude", expiresAt: new Date(Date.now() + 3600000).toISOString(), gatewayPath: `/api/v1/access/gateway/${bindingId}` } });
    }
    return Response.json({ data: { secret: secret("kastle_refresh_"), expiresAt: new Date(Date.now() + 3600000).toISOString() } });
  } });
  cleanups.push(async () => server.stop(true));
  const credentialFile = join(directory, "installation.json"); await writeFile(credentialFile, JSON.stringify({ secret: secret("kastle_runtime_") }), { mode: 0o600 });
  const options = { directory: join(directory, "runs"), defaultKastleId: kastleId, sources: [{ id: kastleId, url: server.url.origin, credentialFile, selection: { model: "bound-model", effort: "low" } }] };
  const auth = new KastleAuthentication(options);
  const [a, b] = await Promise.all([auth.prepare("thread", "claude"), auth.prepare("thread", "claude")]);
  expect(calls).toEqual(["resolveRun", "delegateRun"]); expect(a.bindingId).toBe(b.bindingId);
  expect(a.model).toBe("bound-model"); expect(a.effort).toBe("low");
  const child = a.launch(["claude"], {});
  expect(() => b.launch(["claude"], {})).toThrow("in use");
  const settings = await readFile(join(child.env.CLAUDE_CONFIG_DIR!, "settings.json"), "utf8");
  expect(settings).not.toContain(credentialFile); expect(settings).not.toContain(secret("kastle_runtime_"));
  a.release(); b.release();
  const restored = await new KastleAuthentication(options).prepare("thread", "claude");
  expect(restored.bindingId).toBe(a.bindingId); expect(calls).toHaveLength(2); restored.release();
  const changed = new KastleAuthentication({ ...options, sources: [{ ...options.sources[0]!, selection: { model: "other-model", effort: "low" } }] });
  await expect(changed.prepare("thread", "claude")).rejects.toThrow("selection changed");
});

test("concurrent helper invocations renew once and cache only the scoped access token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "foundry-kastle-token-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const bindingId = crypto.randomUUID(); let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls++; expect(request.headers.get("authorization")).toBe(`Bearer ${secret("kastle_refresh_")}`);
    expect(await request.json()).toEqual({ bindingId });
    return Response.json({ data: { id: crypto.randomUUID(), secret: secret("kastle_run_"), expiresAt: new Date(Date.now() + 600000).toISOString() } });
  } }); cleanups.push(async () => server.stop(true));
  const file = join(directory, "run.json");
  await writeFile(file, JSON.stringify({ url: server.url.origin, bindingId, refreshCredential: secret("kastle_refresh_"), expiresAt: new Date(Date.now() + 3600000).toISOString() }), { mode: 0o600 });
  expect(await Promise.all([kastleToken(file), kastleToken(file), kastleToken(file)])).toEqual(Array(3).fill(secret("kastle_run_")));
  expect(calls).toBe(1); expect(await readFile(file, "utf8")).not.toContain("kastle_runtime_");
});

test("Kastle clients reject credential URLs, remote HTTP and public credential files", async () => {
  expect(() => new KastleClient("https://user:secret@example.com", "secret")).toThrow();
  expect(() => new KastleClient("http://example.com", "secret")).toThrow();
  const directory = await mkdtemp(join(tmpdir(), "foundry-kastle-mode-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "public.json"); await writeFile(file, "{}", { mode: 0o644 });
  await chmod(file, 0o644); // A restrictive runner umask must not turn this public-file fixture private.
  await expect(readPrivateJson(file)).rejects.toThrow("private regular file");
});

test("a transient resolution failure can retry the same durable run intent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "foundry-kastle-retry-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const kastleId = crypto.randomUUID(), bindingId = crypto.randomUUID(), runIds: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith("resolveRun")) {
      const body = await request.json() as { runId: string }; runIds.push(body.runId);
      if (runIds.length === 1) return new Response("temporary failure", { status: 503 });
      return Response.json({ data: { id: bindingId, kastleId, installationId: crypto.randomUUID(), runId: body.runId, capacityId: crypto.randomUUID(), connectionId: crypto.randomUUID(), model: "model", effort: "low", runtime: "claude", expiresAt: new Date(Date.now() + 3600000).toISOString(), gatewayPath: `/api/v1/access/gateway/${bindingId}` } });
    }
    return Response.json({ data: { secret: secret("kastle_refresh_"), expiresAt: new Date(Date.now() + 3600000).toISOString() } });
  } }); cleanups.push(async () => server.stop(true));
  const file = join(directory, "installation.json"); await writeFile(file, JSON.stringify({ secret: secret("kastle_runtime_") }), { mode: 0o600 });
  const auth = new KastleAuthentication({ directory: join(directory, "runs"), defaultKastleId: kastleId, sources: [{ id: kastleId, url: server.url.origin, credentialFile: file, selection: { model: "model", effort: "low" } }] });
  await expect(auth.prepare("thread", "claude")).rejects.toThrow("503");
  const recovered = await auth.prepare("thread", "claude"); recovered.release();
  expect(runIds).toHaveLength(2); expect(runIds[0]).toBe(runIds[1]);
});
