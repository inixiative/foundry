import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tunnelAuth, FoundryTunnel } from "../src/viewer/tunnel";
import { authenticatedRequest, sessionValue } from "../src/viewer/request-auth";
import { privateTunnelToken } from "../src/viewer/private-token";
import { createViewer } from "../src/viewer/server";
import { ContextStack, EventStream, Harness, InterventionLog, Thread } from "@inixiative/foundry-core";

const token = "synthetic-only-token-0123456789abcdef";
const directories: string[] = [];
const directory = () => { const dir = mkdtempSync(join(tmpdir(), "foundry-auth-")); directories.push(dir); return dir; };
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fixture = () => {
  const app = new Hono();
  app.use("*", tunnelAuth(token));
  app.all("*", c => c.json({ protected: true }));
  return app;
};

test("forwarding headers and URL credentials cannot bypass authentication", async () => {
  const app = fixture();
  for (const headers of [{ "x-forwarded-for": "127.0.0.1" }, { "x-real-ip": "10.1.2.3" }, {}])
    expect((await app.request("https://viewer.test/api/threads", { headers })).status).toBe(401);
  expect((await app.request(`https://viewer.test/ws?authorization=${token}`)).status).toBe(401);
  expect((await app.request("https://viewer.test/api/threads", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
});

test("login sets a private cookie; origin, expiration and signature checks apply to HTTP and websocket", async () => {
  const app = fixture();
  const login = await app.request("https://viewer.test/auth", { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://viewer.test" }, body: `token=${token}` });
  expect(login.status).toBe(302);
  const setCookie = login.headers.get("set-cookie")!;
  expect(setCookie).toContain("HttpOnly"); expect(setCookie).toContain("Secure");
  expect(setCookie).not.toContain(token);
  const cookie = setCookie.split(";")[0];
  for (const path of ["/api/threads", "/ws"]) {
    expect(authenticatedRequest(new Request(`https://viewer.test${path}`, { headers: { cookie } }), token)).toBe(true);
    expect((await app.request(`https://viewer.test${path}`, { headers: { cookie, origin: "https://evil.test" } })).status).toBe(403);
  }
  const expired = `foundry_session=${sessionValue(token, Date.now() - 86400001)}`;
  expect((await app.request("https://viewer.test/api/threads", { headers: { cookie: expired } })).status).toBe(401);
  expect(authenticatedRequest(new Request("https://viewer.test/ws", { headers: { cookie: `${cookie}x` } }), token)).toBe(false);
});

test("tunnel credential persists privately and refuses symlinks instead of reading another file", () => {
  const dir = directory(), first = privateTunnelToken(dir);
  expect(privateTunnelToken(dir)).toBe(first);
  expect(statSync(join(dir, "tunnel-token")).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  const other = directory(), target = join(other, "unrelated");
  writeFileSync(target, token); symlinkSync(target, join(other, "tunnel-token"));
  expect(() => privateTunnelToken(other)).toThrow();
});

test("stopping a tunnel preserves the HTTP authentication boundary", async () => {
  const dir = directory(), thread = new Thread("security-test", new ContextStack());
  const viewer = createViewer({ harness: new Harness(thread), eventStream: new EventStream(),
    interventions: new InterventionLog(thread.signals), configDir: dir, localStore: null,
    tunnel: { port: 4400, token, configDir: dir } });
  const response = await viewer.app.request("http://localhost/api/tunnel/stop", { method: "POST", headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  expect(viewer.tunnelHolder.tunnel).toBeInstanceOf(FoundryTunnel);
  expect((await viewer.app.request("http://localhost/api/tunnel")).status).toBe(401);
  expect((await viewer.app.request("http://localhost/api/tunnel", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  await viewer.analyticsReady;
});

 test("trusted HTTPS tunnel origin works behind loopback proxy and does not trust forwarded origins", async () => {
  const app = new Hono();
  app.use("*", tunnelAuth(token, "https://public-viewer.test"));
  app.get("/api/threads", c => c.json({ ok: true }));
  const login = await app.request("http://127.0.0.1:4400/auth", { method: "POST", headers: { origin: "https://public-viewer.test", "content-type": "application/x-www-form-urlencoded" }, body: `token=${token}` });
  expect(login.status).toBe(302);
  expect(login.headers.get("set-cookie")).toContain("Secure");
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  expect(authenticatedRequest(new Request("http://127.0.0.1:4400/ws", { headers: { cookie, origin: "https://public-viewer.test" } }), token, "https://public-viewer.test")).toBe(true);
  expect((await app.request("http://127.0.0.1:4400/api/threads", { headers: { cookie, origin: "https://evil.test", "x-forwarded-host": "evil.test", "x-forwarded-proto": "https" } })).status).toBe(403);
});
