import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, defaultProjectAgents, validateConfig } from "../src/viewer/config";
import { resolveSubscriptionPolicy } from "../src/providers/subscription-policy";
import { resolveProjectView } from "../src/viewer/config-resolve";
import { SubscriptionAuthentication } from "../src/providers/subscription-authentication";
import { subscriptionStatusProcess } from "./helpers/subscription-transport";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "subscription-policy-")); roots.push(root);
  const profile = (name: string) => { const dir = join(root, name); mkdirSync(dir, { mode: 0o700 }); return dir; };
  const c = defaultConfig();
  const worker = { id: crypto.randomUUID(), connectionId: crypto.randomUUID(), runtime: "claude" as const, mode: "native-profile" as const, profileDirectory: profile("worker") };
  const decision = { ...worker, id: crypto.randomUUID(), connectionId: crypto.randomUUID(), profileDirectory: profile("decision") };
  c.nativeAuthentication = [worker, decision];
  c.defaults = { provider: "claude-code", model: "worker-model", nativeAuthenticationId: worker.id, classifierProvider: "subscription-decisions", classifierModel: "decision-model" };
  c.subscriptionOnly = { decisionSourceId: decision.id, model: "decision-model", expectedObservedModel: "decision-canonical", directory: profile("calls"), maxCalls: 50, maxQueued: 8, callTimeoutMs: 2000 };
  c.agents = defaultProjectAgents("claude-code", "worker-model", "subscription-decisions", "decision-model");
  c.projects = { project: { id: "project", path: root, tags: [] } };
  return { c, root, worker, decision };
}

test("subscription policy resolves explicit models and sources without API access", () => {
  const f = fixture();
  expect(() => validateConfig(f.c)).not.toThrow();
  expect(resolveSubscriptionPolicy(f.c)).toMatchObject({ worker: { id: f.worker.id }, decision: { id: f.decision.id }, policy: { model: "decision-model" } });
});

for (const change of ["worker-api", "review-api", "review-model", "same-profile", "gateway", "codex-worker", "expert-tools", "claude-decision-model", "codex-observed-model", "claude-concurrency"] as const)
  test(`subscription startup refuses ${change} before provider construction`, () => {
    const f = fixture();
    switch (change) {
      case "worker-api": f.c.defaults.provider = "openai"; break;
      case "review-api": f.c.learning = { review: { provider: "openai" } }; break;
      case "review-model": f.c.learning = { review: { model: "gpt-5.6-luna" } }; break;
      case "same-profile": f.decision.profileDirectory = f.worker.profileDirectory; break;
      case "gateway": f.c.nativeAuthentication![1] = { id: f.decision.id, connectionId: f.decision.connectionId, runtime: "claude", mode: "gateway", baseUrl: "https://example.com", credential: { type: "environment", variable: "SYNTHETIC_KEY" } }; break;
      case "codex-worker": f.c.nativeAuthentication![0].runtime = "codex"; break;
      case "expert-tools": f.c.agents.router.tools = true; break;
      case "claude-decision-model": delete f.c.subscriptionOnly!.model; break;
      case "codex-observed-model": f.c.nativeAuthentication![1].runtime = "codex"; break;
      case "claude-concurrency": f.c.subscriptionOnly!.maxConcurrent = 2; break;
    }
    expect(() => validateConfig(f.c)).toThrow();
  });

// Decision roles saved on another provider or model run on the subscription decision profile.
for (const change of ["classifier-api", "project-api", "agent-model", "project-model"] as const)
  test(`subscription mode routes ${change} to subscription decisions`, () => {
    const f = fixture();
    switch (change) {
      case "classifier-api": f.c.agents.classifier.provider = "openai"; break;
      case "project-api": f.c.projects.project.agents = { router: { provider: "openai" } }; break;
      case "agent-model": f.c.agents.router.model = "gpt-5.6-luna"; break;
      case "project-model": f.c.projects.project.defaults = { classifierModel: "gpt-5.6-luna" }; break;
    }
    expect(() => validateConfig(f.c)).not.toThrow();
    const resolved = resolveSubscriptionPolicy(f.c)!;
    const view = resolveProjectView(resolved.config, "project")!.config;
    for (const agent of [view.agents.classifier, view.agents.router]) expect(agent).toMatchObject({ provider: "subscription-decisions", model: "decision-model" });
    expect(view.defaults).toMatchObject({ classifierProvider: "subscription-decisions", classifierModel: "decision-model" });
  });

test("an explicit Codex decision profile runs Codex decisions beside the Claude worker", () => {
  const f = fixture();
  f.c.nativeAuthentication![1].runtime = "codex";
  delete f.c.subscriptionOnly!.expectedObservedModel;
  expect(resolveSubscriptionPolicy(f.c)).toMatchObject({ worker: { runtime: "claude" }, decision: { id: f.decision.id, runtime: "codex" }, policy: { model: "decision-model" } });
});

test("different IDs or aliases cannot share the warm worker profile", () => {
  const f = fixture();
  const alias = join(f.root, "alias"); symlinkSync(f.root, alias);
  f.decision.profileDirectory = join(alias, "worker");
  expect(() => resolveSubscriptionPolicy(f.c)).toThrow("separate private profile");
});

test("native worker requires subscription status and strips paid credentials while preserving tools", async () => {
  const f = fixture();
  const denied = new SubscriptionAuthentication(f.root, f.worker, () => subscriptionStatusProcess(false));
  await expect(denied.prepare("worker", "claude")).rejects.toThrow("no API fallback");
  const auth = new SubscriptionAuthentication(f.root, f.worker, () => subscriptionStatusProcess());
  const launch = await auth.prepare("worker", "claude");
  const command = launch.launch(["claude", "--model", "worker-model"], { PATH: process.env.PATH, OPENAI_API_KEY: "synthetic-paid-key", ANTHROPIC_API_KEY: "synthetic-paid-key", CLAUDE_CODE_OAUTH_TOKEN: "synthetic-other-account" });
  try {
    expect(command.env.OPENAI_API_KEY).toBeUndefined(); expect(command.env.ANTHROPIC_API_KEY).toBeUndefined(); expect(command.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(command.env.CLAUDE_CONFIG_DIR).toBe(realpathSync(f.worker.profileDirectory));
    expect(command.argv.slice(-2)).toEqual(["--setting-sources", ""]);
    expect(command.argv).not.toContain("--tools");
    const second = await auth.prepare("another-worker", "claude");
    expect(() => second.launch(["claude"], {})).toThrow("in use");
  } finally { launch.release(); }
  const override = await auth.prepare("worker", "claude");
  expect(() => override.launch(["claude", "--fallback-model=paid-model"], {})).toThrow("override");
});

test("full subscription startup reaches viewer with no API provider requests or native model launch", async () => {
  const f = fixture(), configDir = join(f.root, ".foundry"); mkdirSync(configDir, { mode: 0o700 });
  f.c.layers = { system: { id: "system", prompt: "Test system", sourceIds: ["system"], enabled: true, staleness: 0 } };
  f.c.sources = { system: { id: "system", label: "System", type: "inline", uri: "Test instructions", enabled: true } };
  writeFileSync(join(configDir, "settings.json"), JSON.stringify(f.c), { mode: 0o600 });
  const probe = join(f.root, "network-attempt"), preload = join(f.root, "deny-network.ts");
  writeFileSync(preload, `import {writeFileSync} from 'node:fs'; globalThis.fetch = (() => {writeFileSync(${JSON.stringify(probe)}, 'attempted'); throw Error('External requests forbidden in startup test');}) as typeof fetch;`, { mode: 0o600 });
  const env = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG"].map(key => [key, process.env[key]]));
  const child = Bun.spawn([process.execPath, "--preload", preload, new URL("../src/start.ts", import.meta.url).pathname], {
    cwd: f.root, env: { ...env, VIEWER_PORT: "0", FOUNDRY_STARTUP_SELF_TEST: "0", OPENAI_API_KEY: "synthetic-never-send", ANTHROPIC_API_KEY: "synthetic-never-send" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  let output = "";
  const read = async (stream: ReadableStream<Uint8Array>) => { for await (const chunk of stream) output += new TextDecoder().decode(chunk); };
  const stdout = read(child.stdout), stderr = read(child.stderr);
  try {
    for (let attempt = 0; !output.includes("Ready. Send messages"); attempt++) {
      if (attempt >= 100 || child.exitCode !== null) throw Error(`Subscription startup did not become ready: ${output}`);
      await Bun.sleep(25);
    }
    const port = output.match(/Foundry Viewer running at http:\/\/localhost:(\d+)/)?.[1];
    expect(port).toBeDefined();
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(health.status).toBe(200);
    expect(output).toContain("subscription-decisions");
    expect(output).toContain("Provider self-test skipped");
    expect(existsSync(probe)).toBe(false);
    expect(existsSync(join(f.worker.profileDirectory, ".foundry-auth-lock"))).toBe(false);
    expect(existsSync(join(f.decision.profileDirectory, ".foundry-auth-lock"))).toBe(false);
  } finally { child.kill("SIGINT"); await child.exited; await Promise.all([stdout, stderr]); }
}, 5000);

for (const throwsOnKill of [false, true]) test(`unknown status exit closes admission (kill throws: ${throwsOnKill})`, async () => {
  const f = fixture();
  let launches = 0, kills = 0, settle!: (code: number) => void;
  const exited = new Promise<number>(resolve => { settle = resolve; });
  const auth = new SubscriptionAuthentication(f.root, f.worker, () => {
    launches++;
    return { ...subscriptionStatusProcess(), exited, kill() { kills++; if (throwsOnKill) throw Error("Controlled termination failure"); } };
  });
  try {
    const first = auth.prepare("first", "claude");
    await expect(auth.prepare("concurrent", "claude")).rejects.toThrow("no API fallback");
    await expect(first).rejects.toThrow("no API fallback");
    await expect(auth.prepare("later", "claude")).rejects.toThrow("no API fallback");
    expect(launches).toBe(1); expect(kills).toBe(1);
    expect(existsSync(join(f.worker.profileDirectory, ".foundry-auth-lock"))).toBe(false);
  } finally { settle(143); }
}, 8000);
