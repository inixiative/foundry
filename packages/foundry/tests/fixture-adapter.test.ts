import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NativeBridgeLease, NativeBridgeSource, NativeOwner, NativeToolPolicy } from "@inixiative/foundry-core";
import { ClaudeCodeSessionAdapter, CodexSessionAdapter, InMemoryExternalSessionStore } from "../src/providers/session-adapter";
import { SessionBackedProvider } from "../src/providers/session-backed";
import { withIsolatedFixture, withNativeBridge } from "../src/providers/native-launch";
import { subscriptionTransport } from "./helpers/subscription-transport";

const roots: string[] = [];
afterEach(async () => { await Bun.sleep(10); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(transport = subscriptionTransport()) {
  const cwd = mkdtempSync(join(tmpdir(), "fixture-adapter-")); roots.push(cwd);
  const owner: NativeOwner = { threadId: "owner", projectId: "P", generation: "G", dispatchId: "D" };
  const toolPolicy: NativeToolPolicy = Object.freeze({ version: "isolated-fixture-v1", digest: "a".repeat(64) });
  let closed = false, acquisitions = 0;
  const lease: NativeBridgeLease = { id: crypto.randomUUID(), name: "fixture_owned", owner, toolPolicy, fixtureCwd: cwd, configurationHash: "b".repeat(64),
    launch: { claudeJson: JSON.stringify({ mcpServers: { fixture_owned: { command: "bun", args: ["/controlled/proxy.ts", "/controlled/launch.json"] } } }), codexOverrides: [] },
    check() { if (closed) throw Error("closed"); }, register() {}, observe() {}, evidence: () => [], close: async () => { closed = true; } };
  const source: NativeBridgeSource = { key: "source", toolPolicy, check() { lease.check(); }, async acquire() { acquisitions++; return lease; } };
  const store = new InMemoryExternalSessionStore();
  const adapter = new ClaudeCodeSessionAdapter({ store, controlledFixtureSpawn: transport.spawn });
  const provider = new SessionBackedProvider({ id: "claude-code", adapter, defaultCwd: "/logical/host/project", defaultModel: "test-model" });
  const opts = { threadId: owner.threadId, model: "test-model", maxTurns: 5, nativeObservation: { owner, bridge: source, register() {}, observe() {} } };
  return { cwd, owner, lease, source, store, transport, adapter, provider, opts, acquisitions: () => acquisitions };
}

test("controlled fixture dispatch disables native tools and cannot resume unrestricted history", async () => {
  const f = fixture();
  await f.store.save("owner", "claude-code", "retained-unrestricted-session");
  const result = await f.provider.complete([{ role: "user", content: "Controlled fixture task" }], f.opts);
  try {
    const launch = f.transport.launches[0], args = launch.argv;
    expect(launch.cwd).toBe(f.cwd);
    expect(args).toContain("--restricted"); expect(args).not.toContain("--safe-mode"); expect(args).not.toContain("--bare");
    expect(args).not.toContain("--resume"); expect(args).not.toContain("retained-unrestricted-session");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config"); expect(args).toContain("--disable-slash-commands"); expect(args).toContain("--no-chrome");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe(f.lease.launch.claudeJson);
    expect(result.native?.configuration?.transportMode).toBe("controlled-fixture");
    expect(result.native?.bridge?.toolPolicy).toEqual(f.source.toolPolicy);
    expect(f.provider.warmProfile("owner", "/logical/host/project")?.bindingId).toContain(":profile:isolated-fixture-v1:");
    expect(await f.store.load("owner", "claude-code")).toBe("retained-unrestricted-session");
  } finally { await f.provider.completionLifecycle.releaseOwnedAdmission!(result.native!.owner!, result.native!.admissionId!); }
  expect(f.transport.launches[0].exited).toBe(true);
});

test("changing fixture policy or bridge source refuses warm reuse before write", async () => {
  const f = fixture();
  const first = await f.provider.complete([{ role: "user", content: "first" }], f.opts);
  try {
    const changed = { ...f.source, toolPolicy: { version: "isolated-fixture-v1" as const, digest: "c".repeat(64) } };
    await expect(f.provider.complete([{ role: "user", content: "second" }], { ...f.opts, nativeObservation: { ...f.opts.nativeObservation, bridge: changed } })).rejects.toThrow("profile changed");
    expect(f.transport.writes).toBe(1); expect(f.acquisitions()).toBe(1);
  } finally { await f.provider.completionLifecycle.releaseOwnedAdmission!(first.native!.owner!, first.native!.admissionId!); }
});

test("normal native, Codex, and auxiliary paths cannot acquire fixture launch privileges", async () => {
  const f = fixture(); let spawns = 0;
  const defaults = { spawn() { spawns++; throw Error("Must never launch"); } };
  const native = new ClaudeCodeSessionAdapter({ store: f.store, defaults });
  await expect(native.createSession({ threadId: "owner", cwd: f.cwd, maxTurns: 5, nativeBridge: f.lease })).rejects.toThrow("managed execution");
  const codex = new CodexSessionAdapter({ store: f.store, defaults });
  await expect(codex.createSession({ threadId: "owner", cwd: f.cwd, maxTurns: 5, nativeBridge: f.lease })).rejects.toThrow("unsupported");
  await expect(f.adapter.createSession({ threadId: "owner:aux:review", cwd: f.cwd, tools: false, nativeBridge: f.lease })).rejects.toThrow("cannot be granted");
  expect(() => withNativeBridge(["claude"], "claude", f.lease)).toThrow("isolated transport");
  expect(spawns).toBe(0);
});

test("restricted argv composition rejects added configuration, resume and unbounded execution", () => {
  const f = fixture();
  const base = ["claude", "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--model", "test-model", "--permission-mode", "dontAsk", "--max-turns", "5"];
  for (const extra of [["--settings", "untrusted.json"], ["--resume", "historical"], ["--plugin-dir", "/host"], ["--tools", "Bash"], ["--mcp-config", "untrusted"], ["--chrome"], ["--permission-mode", "bypassPermissions"], ["--safe-mode"], ["--bare"]])
    expect(() => withIsolatedFixture([...base, ...extra], f.lease)).toThrow();
  expect(() => withIsolatedFixture(base.slice(0, -2), f.lease)).toThrow("Bounded");
});


test("controlled registration, observations, errors and inspection retain provenance", async () => {
  const transport = subscriptionTransport({ response: () => new Promise(() => {}) });
  const f = fixture(transport);
  const recorded: import("@inixiative/foundry-core").NativeEvidence[] = [];
  const error = await f.provider.complete([{ role: "user", content: "controlled timeout" }], {
    ...f.opts, timeout: 100, nativeObservation: { ...f.opts.nativeObservation, register(e) { recorded.push(e); }, observe(e) { recorded.push(e); } },
  }).catch(error => error);
  expect(error.native.executionMode).toBe("controlled-fixture");
  expect(recorded.length).toBeGreaterThan(0);
  expect(recorded.every(e => e.executionMode === "controlled-fixture")).toBe(true);
  const evidence = recorded[0];
  const inspection = await f.provider.completionLifecycle.inspectOwnedAdmission!(evidence.owner!, evidence.admissionId!);
  expect(inspection?.evidence.executionMode).toBe("controlled-fixture");
  // This controlled helper keeps its child alive after the local timeout; the
  // owned adapter must terminate it explicitly. No release is inferred here.
  await f.adapter.releaseIdleSession!(await (f.provider as any)._sessions.values().next().value);
});
