import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeEvidence } from "@inixiative/foundry-core";
import { ConfigStore, defaultConfig, starterConfig, validateConfig } from "../src/viewer/config";
import { resolveSubscriptionPolicy } from "../src/providers/subscription-policy";
import { NativeAuthentication } from "../src/providers/native-authentication";
import { defaultProfileSource } from "../src/providers/default-profiles";
import { buildCodexTextProvider } from "../src/providers/codex-text-provider";
import { buildSubscriptionDecisions, type SubscriptionDecisionConfig } from "../src/providers/subscription-decisions";
import { codexTransport, subscriptionTransport } from "./helpers/subscription-transport";
import { ClaudeCodeSessionAdapter, InMemoryExternalSessionStore } from "../src/providers/session-adapter";

const roots: string[] = [];
const home = process.env.HOME;
afterEach(async () => {
  process.env.HOME = home;
  await Bun.sleep(10);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
/** A temporary HOME holding the user's own login locations, shared (0755) like a real ~/.claude. */
function userHome() {
  const root = mkdtempSync(join(tmpdir(), "subscription-default-")); roots.push(root);
  for (const name of [".claude", ".codex"]) mkdirSync(join(root, name), { mode: 0o755 });
  writeFileSync(join(root, ".claude", "settings.json"), "{}", { mode: 0o644 });
  writeFileSync(join(root, ".codex", "auth.json"), "{}", { mode: 0o600 });
  process.env.HOME = root;
  return root;
}
const messages = [{ role: "user" as const, content: "private-input" }];

test("a fresh configuration is subscription-only: Claude worker and Codex Luna decisions from the user's own logins", () => {
  const root = userHome(), cwd = join(root, "project"); mkdirSync(cwd);
  const config = defaultConfig();
  expect(config.apiTokens).toBeUndefined();
  expect(() => validateConfig(config)).not.toThrow();
  const resolved = resolveSubscriptionPolicy(config, { startup: true, cwd })!;
  expect(resolved.worker).toMatchObject({ runtime: "claude", mode: "native-profile", profileDirectory: join(root, ".claude") });
  expect(resolved.decision).toMatchObject({ runtime: "codex", mode: "native-profile", profileDirectory: join(root, ".codex") });
  expect(resolved.policy).toEqual({ model: "gpt-6-luna", directory: join(cwd, ".foundry", "decision-receipts"), maxCalls: 10000,
    maxQueued: 256, maxQueuedPerThread: 32, maxConcurrent: 8, callTimeoutMs: 30000 });
  expect(statSync(resolved.policy.directory).mode & 0o777).toBe(0o700);
  expect(resolved.config.defaults).toMatchObject({ provider: "claude-code", classifierProvider: "subscription-decisions", classifierModel: "gpt-6-luna" });
  expect(resolved.rerouted).toEqual([]);
});

test("the user's default profiles are referenced in place but their credential files must stay private", () => {
  const root = userHome();
  chmodSync(join(root, ".codex", "auth.json"), 0o644);
  expect(() => resolveSubscriptionPolicy(defaultConfig(), { startup: true, cwd: root })).toThrow("codex subscription profile unavailable");
  chmodSync(join(root, ".codex", "auth.json"), 0o600);
  rmSync(join(root, ".claude"), { recursive: true });
  expect(() => resolveSubscriptionPolicy(defaultConfig(), { startup: true, cwd: root })).toThrow("claude subscription profile unavailable");
  // Saving settings does not depend on this machine's logins.
  expect(() => validateConfig(defaultConfig())).not.toThrow();
});

test("API tokens are an explicit, exclusive opt-in", () => {
  userHome();
  const api = starterConfig("anthropic", "claude-sonnet-5");
  expect(api.apiTokens).toBe(true);
  expect(resolveSubscriptionPolicy(api)).toBeUndefined();
  const opted = defaultConfig(); opted.apiTokens = true;
  expect(resolveSubscriptionPolicy(opted)).toBeUndefined();
  opted.subscriptionOnly = { maxCalls: 5 };
  expect(() => validateConfig(opted)).toThrow("exclusive");
  const worker = defaultConfig(); worker.defaults.provider = "anthropic";
  expect(() => validateConfig(worker)).toThrow("set apiTokens: true");
  const invalid = defaultConfig(); (invalid as { apiTokens?: unknown }).apiTokens = "yes";
  expect(() => validateConfig(invalid)).toThrow("apiTokens");
});

test("the settings API opts in to API tokens and back out explicitly", async () => {
  const root = userHome(), store = new ConfigStore(join(root, ".foundry"));
  await store.load();
  await expect(store.patch("defaults", { provider: "gemini", model: "gemini-3.1-flash" })).rejects.toThrow("set apiTokens: true");
  expect((await store.patch("apiTokens", { enabled: true })).apiTokens).toBe(true);
  expect((await store.patch("defaults", { provider: "gemini", model: "gemini-3.1-flash" })).defaults.provider).toBe("gemini");
  await expect(store.patch("apiTokens", { enabled: false })).rejects.toThrow("set apiTokens: true");
  await store.patch("defaults", { provider: "claude-code", model: "fable" });
  expect((await store.patch("apiTokens", { enabled: false })).apiTokens).toBeUndefined();
});

test("saved decision roles run on subscription decisions without rewriting the saved configuration", () => {
  userHome();
  const config = defaultConfig();
  config.defaults = { provider: "claude-code", model: "opus", classifierProvider: "gemini", classifierModel: "gemini-3.1-flash-lite-preview" };
  config.agents.librarian = { id: "librarian", kind: "librarian", prompt: "Reconcile", provider: "claude-code", model: "opus", temperature: 0, tools: false, visibleLayers: [], peers: [], maxDepth: 1, enabled: true };
  config.agents.artificer = { id: "artificer", kind: "executor", prompt: "Work", provider: "claude-code", model: "opus", tools: true, visibleLayers: [], peers: [], maxDepth: 5, enabled: true };
  config.projects = { P: { id: "P", path: "/tmp/p", agents: { classifier: { id: "classifier", kind: "classifier", prompt: "Classify", provider: "openai", model: "gpt-5.6-luna", tools: false, visibleLayers: { replace: [] }, ownedLayers: { replace: [] }, peers: { replace: [] }, maxDepth: 1, enabled: true } } } };
  const before = JSON.stringify(config);
  expect(() => validateConfig(config)).not.toThrow();
  const resolved = resolveSubscriptionPolicy(config)!;
  expect(JSON.stringify(config)).toBe(before);
  expect(resolved.rerouted).toEqual(["librarian (claude-code/opus)", "P/classifier (openai/gpt-5.6-luna)"]);
  expect(resolved.config.agents.librarian).toMatchObject({ provider: "subscription-decisions", model: "gpt-6-luna" });
  expect(resolved.config.agents.artificer).toMatchObject({ provider: "claude-code", model: "opus" });
  expect(resolved.config.projects.P!.agents!.classifier).toMatchObject({ provider: "subscription-decisions", model: "gpt-6-luna" });
  config.agents.librarian.thinking = "high";
  expect(() => validateConfig(config)).toThrow("sampling override");
});

test("default profiles are selected by omission, so the child never overrides CLAUDE_CONFIG_DIR or CODEX_HOME", async () => {
  const root = userHome();
  for (const runtime of ["claude", "codex"] as const) {
    const source = defaultProfileSource(runtime);
    const auth = new NativeAuthentication({ directory: join(root, "auth"), sources: [source], defaultSourceId: source.id });
    const launch = await auth.prepare("worker", runtime);
    const command = launch.launch([runtime], { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/elsewhere", CODEX_HOME: "/elsewhere", OPENAI_API_KEY: "synthetic-paid-key" });
    try {
      expect(command.env.CLAUDE_CONFIG_DIR).toBeUndefined(); expect(command.env.CODEX_HOME).toBeUndefined();
      expect(command.env.OPENAI_API_KEY).toBeUndefined();
      // One Foundry owner per login; the user's own interactive sessions do not take this lock.
      expect(existsSync(join(source.profileDirectory, ".foundry-auth-lock"))).toBe(true);
    } finally { launch.release(); }
    expect(existsSync(join(source.profileDirectory, ".foundry-auth-lock"))).toBe(false);
  }
});

function codexRun(transport: ReturnType<typeof codexTransport>, timeout = 2000) {
  const root = userHome(), directory = join(root, "receipts"); mkdirSync(directory, { mode: 0o700 });
  return { root, run: buildCodexTextProvider({ directory, source: defaultProfileSource("codex"), runId: crypto.randomUUID(), model: "gpt-5.6-luna", maxCalls: 2, callTimeoutMs: timeout }, transport) };
}

test("Codex decisions are one ephemeral, read-only, tool-disabled exec turn with the prompt on stdin", async () => {
  const transport = codexTransport();
  const { root, run } = codexRun(transport);
  const result = await run.provider.complete([{ role: "system", content: "Return JSON" }, ...messages]);
  expect(result).toMatchObject({ content: "accepted-private-answer", model: "gpt-5.6-luna", tokens: { input: 3, output: 2 }, native: { nativeOutcome: "completed" } });
  const [launch] = transport.launches;
  expect(launch!.argv.slice(0, 2)).toEqual(["codex", "exec"]);
  for (const flag of ["--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check"]) expect(launch!.argv).toContain(flag);
  expect(launch!.argv[launch!.argv.indexOf("--sandbox") + 1]).toBe("read-only");
  expect(launch!.argv[launch!.argv.indexOf("--model") + 1]).toBe("gpt-5.6-luna");
  expect(launch!.argv).toContain("shell_tool"); expect(launch!.argv.at(-1)).toBe("-");
  expect(launch!.argv.join(" ")).not.toContain("private-input");
  expect(launch!.stdin).toContain("private-input"); expect(launch!.stdin).toContain("Foundry's internal decision middleware");
  expect(Object.keys(launch!.env).filter(key => /API_KEY|CODEX_HOME|CLAUDE_CONFIG_DIR/.test(key))).toEqual([]);
  expect(existsSync(join(root, ".codex", ".foundry-auth-shared"))).toBe(false);
  const report = readFileSync(run.reportPath, "utf8");
  expect(report).not.toContain("private-input"); expect(report).not.toContain("accepted-private-answer");
  expect(run.snapshot().calls[0]).toMatchObject({ valid: true, release: "released", processExit: "exited", statusProcessExit: "exited" });
});

for (const [name, transport] of [
  ["an API-key login", () => codexTransport({ login: "Logged in using an API key - sk-***" })],
  ["a tool item", () => codexTransport({ items: [{ id: "cmd", type: "command_execution", command: "ls" }] })],
  ["a non-zero exit", () => codexTransport({ exitCode: 1 })],
] as const) test(`Codex decisions refuse ${name} with no fallback, retry or further admission`, async () => {
  const t = transport();
  const { root, run } = codexRun(t);
  await expect(run.provider.complete(messages)).rejects.toThrow("Codex text call failed");
  expect(t.launches.length).toBe(name === "an API-key login" ? 0 : 1);
  await expect(run.provider.complete(messages)).rejects.toThrow("admission closed");
  expect(t.launches.length).toBeLessThanOrEqual(1);
  expect(existsSync(join(root, ".codex", ".foundry-auth-shared"))).toBe(false);
});

test("a stalled Codex decision is killed at its deadline and its profile lock released", async () => {
  const t = codexTransport({ hang: true });
  const { root, run } = codexRun(t, 200);
  await expect(run.provider.complete(messages)).rejects.toThrow("Codex text call failed");
  expect(run.snapshot().calls[0]).toMatchObject({ deadline: true, processExit: "exited", valid: false });
  expect(t.launches[0]!.exited).toBe(true);
  expect(existsSync(join(root, ".codex", ".foundry-auth-shared"))).toBe(false);
});

test("the decision scheduler accepts a Codex decision only with settled ownership evidence", async () => {
  const root = userHome(), directory = join(root, "receipts"); mkdirSync(directory, { mode: 0o700 });
  const transport = codexTransport();
  const config: SubscriptionDecisionConfig = { directory, source: defaultProfileSource("codex"), model: "gpt-5.6-luna", maxCalls: 3, maxQueued: 2, callTimeoutMs: 2000 };
  const decisions = buildSubscriptionDecisions(config, cfg => buildCodexTextProvider(cfg, transport));
  const observed: NativeEvidence[] = [];
  const owner = { threadId: "T", generation: "G", dispatchId: "D" };
  const result = await decisions.provider.complete(messages, { threadId: "T:aux:route", nativeObservation: { owner, register(e) { observed.push(e); }, observe(e) { observed.push(e); } } });
  expect(result.content).toBe("accepted-private-answer");
  expect(result.native?.owner?.providerSessionKey).toBe("T:aux:route");
  expect(observed.map(e => e.nativeOutcome)).toEqual(["unknown", "completed"]);
  await expect(decisions.provider.complete(messages, { model: "gpt-6-astra" })).rejects.toThrow("refused");
  expect(decisions.snapshot()).toMatchObject({ attempts: 1, closed: false });
  decisions.close();
});

async function startFoundry(root: string, extra: Record<string, string> = {}) {
  const probe = join(root, "network-attempt"), preload = join(root, "deny-network.ts");
  writeFileSync(preload, `import {writeFileSync} from 'node:fs'; globalThis.fetch = (() => {writeFileSync(${JSON.stringify(probe)}, 'attempted'); throw Error('External requests forbidden in startup test');}) as typeof fetch;`, { mode: 0o600 });
  const env = Object.fromEntries(["PATH", "USER", "LOGNAME", "TMPDIR", "LANG"].map(key => [key, process.env[key]]));
  // The starter project's conventions source reads <project>/docs.
  const cwd = join(root, "project"); mkdirSync(join(cwd, "docs"), { recursive: true });
  const child = Bun.spawn([process.execPath, "--preload", preload, new URL("../src/start.ts", import.meta.url).pathname], {
    cwd, env: { ...env, HOME: root, VIEWER_PORT: "0", FOUNDRY_STARTUP_SELF_TEST: "0", OPENAI_API_KEY: "synthetic-never-send", ANTHROPIC_API_KEY: "synthetic-never-send", GEMINI_API_KEY: "synthetic-never-send", ...extra },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  let output = "";
  const read = async (stream: ReadableStream<Uint8Array>) => { for await (const chunk of stream) output += new TextDecoder().decode(chunk); };
  const streams = Promise.all([read(child.stdout), read(child.stderr)]);
  return { child, cwd, probe, get output() { return output; }, async stop() { child.kill("SIGINT"); await child.exited; await streams; } };
}

test("a fresh install starts subscription-only with no settings, API provider or network request", async () => {
  const root = userHome();
  const foundry = await startFoundry(root);
  try {
    for (let attempt = 0; !foundry.output.includes("Ready. Send messages"); attempt++) {
      if (attempt >= 200 || foundry.child.exitCode !== null) throw Error(`Fresh subscription startup did not become ready: ${foundry.output}`);
      await Bun.sleep(25);
    }
    expect(foundry.output).toContain(`Subscription-only: worker claude-code (${join(root, ".claude")}), decisions codex gpt-6-luna (${join(root, ".codex")}); no API providers`);
    expect(foundry.output).toContain("Librarian (subscription-decisions)");
    expect(foundry.output).not.toContain("openai-decisions");
    expect(foundry.output).not.toContain("Decision roles use subscription decisions");
    const port = foundry.output.match(/Foundry Viewer running at http:\/\/localhost:(\d+)/)?.[1];
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200);
    const saved = JSON.parse(readFileSync(join(foundry.cwd, ".foundry", "settings.json"), "utf8"));
    expect(saved.apiTokens).toBeUndefined();
    expect(saved.defaults).toMatchObject({ provider: "claude-code", classifierProvider: "subscription-decisions", classifierModel: "gpt-6-luna" });
    expect(existsSync(foundry.probe)).toBe(false);
    expect(statSync(join(foundry.cwd, ".foundry", "decision-receipts")).mode & 0o777).toBe(0o700);
  } finally { await foundry.stop(); }
}, 10000);

test("API tokens opted in without a key refuse startup instead of falling back to subscriptions", async () => {
  const root = userHome(), config = defaultConfig(); config.apiTokens = true;
  mkdirSync(join(root, "project", ".foundry"), { recursive: true });
  writeFileSync(join(root, "project", ".foundry", "settings.json"), JSON.stringify(config), { mode: 0o600 });
  const foundry = await startFoundry(root, { OPENAI_API_KEY: "" });
  const code = await foundry.child.exited;
  await foundry.stop();
  expect(code).not.toBe(0);
  expect(foundry.output).toContain("Foundry decisions require OPENAI_API_KEY for openai/gpt-6-luna");
  expect(foundry.output).not.toContain("Subscription-only");
}, 10000);

test("shutdown stops live worker and decision processes so the user's profile locks are released", async () => {
  const root = userHome(), source = defaultProfileSource("claude"), worker = subscriptionTransport();
  const adapter = new ClaudeCodeSessionAdapter({ store: new InMemoryExternalSessionStore(),
    authentication: new NativeAuthentication({ directory: join(root, "auth"), sources: [source], defaultSourceId: source.id }),
    defaults: { spawn: worker.spawn } });
  const session = await adapter.createSession({ threadId: "main", cwd: root });
  await session.start();
  expect(existsSync(join(root, ".claude", ".foundry-auth-lock"))).toBe(true);

  const directory = join(root, "receipts"); mkdirSync(directory, { mode: 0o700 });
  const codex = codexTransport({ hang: true });
  const decisions = buildSubscriptionDecisions({ directory, source: defaultProfileSource("codex"), model: "gpt-5.6-luna", maxCalls: 3, maxQueued: 2, callTimeoutMs: 20000 },
    cfg => buildCodexTextProvider(cfg, codex));
  const pending = decisions.provider.complete(messages).then(() => undefined, (error: Error) => error);
  for (let n = 0; !existsSync(join(root, ".codex", ".foundry-auth-shared")); n++) { if (n > 200) throw Error("decision never launched"); await Bun.sleep(5); }

  await Promise.all([adapter.releaseAll(), decisions.shutdown()]);
  expect((await pending)?.message).toContain("no fallback");
  expect(worker.launches[0]!.exited).toBe(true); expect(codex.launches[0]!.exited).toBe(true);
  expect(existsSync(join(root, ".claude", ".foundry-auth-lock"))).toBe(false);
  expect(existsSync(join(root, ".codex", ".foundry-auth-shared"))).toBe(false);
  expect(decisions.snapshot()).toMatchObject({ closed: true, active: false });
});
