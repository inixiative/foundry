import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeEvidence } from "@inixiative/foundry-core";
import { ConfigStore, defaultConfig, starterConfig, validateConfig } from "../src/viewer/config";
import { resolveSubscriptionPolicy } from "../src/providers/subscription-policy";
import { NativeAuthentication } from "../src/providers/native-authentication";
import { defaultProfileSource } from "../src/providers/default-profiles";
import { createPrimedDecisionHost } from "../src/providers/primed-decisions";
import { buildSubscriptionDecisions, type SubscriptionDecisionConfig } from "../src/providers/subscription-decisions";
import { appServerTransport, subscriptionTransport } from "./helpers/subscription-transport";
import { settleRecordings } from "./helpers/vcr";
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
afterAll(settleRecordings);
const LIVE_TIMEOUT = 90_000;

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

/** The production scheduler over a primed host whose app-server is a controlled double. */
function primedDecisions(transport: ReturnType<typeof appServerTransport>, bounds: Partial<SubscriptionDecisionConfig> = {}) {
  const root = userHome(), directory = join(root, "receipts"); mkdirSync(directory, { mode: 0o700 });
  const config: SubscriptionDecisionConfig = { directory, source: defaultProfileSource("codex"), model: "gpt-5.6-luna", maxCalls: 20, maxQueued: 8, callTimeoutMs: 2000, ...bounds };
  const primed = createPrimedDecisionHost({ source: config.source, directory, model: config.model, maxConcurrent: config.maxConcurrent ?? 1,
    callTimeoutMs: config.callTimeoutMs, spawn: transport.spawn });
  const decisions = buildSubscriptionDecisions(config, primed.createRun);
  return { root, primed, decisions, async close() { await decisions.shutdown(); await primed.close(); } };
}

test("Codex decisions run on one warm, tool-free app-server with the prompt never on argv", async () => {
  const transport = appServerTransport();
  const { root, primed, decisions, close } = primedDecisions(transport);
  try {
    const result = await decisions.provider.complete([{ role: "system", content: "Return JSON" }, ...messages], { threadId: "T:aux:route" });
    expect(result).toMatchObject({ content: "accepted-private-answer", model: "gpt-5.6-luna", tokens: { input: 2, cacheRead: 1, output: 2 }, native: { nativeOutcome: "completed" } });
    const [launch] = transport.launches;
    expect(launch!.argv.slice(0, 2)).toEqual(["codex", "app-server"]);
    expect(launch!.argv).toContain("shell_tool");
    expect(launch!.argv.filter((_, i) => launch!.argv[i - 1] === "-c")).toEqual(['approval_policy="never"', 'web_search="disabled"']);
    expect(launch!.argv.join(" ")).not.toContain("private-input");
    expect(Object.keys(launch!.env).filter(key => /API_KEY|CODEX_HOME|CLAUDE_CONFIG_DIR/.test(key))).toEqual([]);
    const start = transport.requests.find(r => r.method === "thread/start")!.params;
    expect(start).toMatchObject({ model: "gpt-5.6-luna", sandbox: "read-only", approvalPolicy: "never", ephemeral: true, developerInstructions: "Return JSON",
      config: { "mcp_servers.node_repl.enabled": false, notify: [] } });
    expect(start.baseInstructions).toContain("Foundry's internal decision middleware");
    expect(transport.turns).toEqual(["private-input"]);
    // The warm process holds a shared registration on the login while it lives.
    expect(existsSync(join(root, ".codex", ".foundry-auth-shared"))).toBe(true);
    const receipts = readFileSync(primed.receiptsPath, "utf8");
    expect(receipts).not.toContain("private-input"); expect(receipts).not.toContain("accepted-private-answer");
    expect(JSON.parse(receipts.trim().split("\n")[0]!)).toMatchObject({ transport: "primed", valid: true, settled: true, release: "released", prime: "cold" });
  } finally { await close(); }
  expect(transport.launches[0]!.exited).toBe(true);
  expect(existsSync(join(root, ".codex", ".foundry-auth-shared"))).toBe(false);
});

test("each middleware role keeps its own primed session and re-primes only when its stable context changes", async () => {
  const transport = appServerTransport();
  const { decisions, close } = primedDecisions(transport);
  const cache = "## Domain cache (api)\nroutes live under src/api\n";
  const advise = (message: string, content = cache) => decisions.provider.complete([{ role: "system", content: "ADVISE" },
    { role: "user", content: `${content}\n## Message\n${message}` }], { threadId: "T:aux:domain:api", stablePrefix: content });
  try {
    await advise("one"); await advise("two");
    await decisions.provider.complete([{ role: "system", content: "GUARD" }, { role: "user", content: `${cache}\n## Tool observation\nls` }],
      { threadId: "T:aux:domain:api", stablePrefix: cache });
    await advise("three", "## Domain cache (api)\nroutes moved to src/http\n");
    const primers = transport.requests.filter(r => r.method === "turn/start" && String(r.params.input[0].text).includes("standing context"));
    // advice primed once, guard (other instructions, same aux id) separately, then advice again after the cache changed.
    expect(primers.map(r => String(r.params.input[0].text).split("\n")[1])).toEqual(["routes live under src/api", "routes live under src/api", "routes moved to src/http"]);
    expect(transport.requests.filter(r => r.method === "thread/fork")).toHaveLength(4);
    // Only the per-cycle part is sent as the decision input.
    expect(transport.turns).toEqual(["\n## Message\none", "\n## Message\ntwo", "\n## Tool observation\nls", "\n## Message\nthree"]);
  } finally { await close(); }
});

for (const [name, transport, closes] of [
  ["an API-key login", () => appServerTransport({ login: "apiKey" }), false],
  ["a tool item", () => appServerTransport({ items: [{ id: "cmd", type: "commandExecution", command: "ls" }] }), true],
] as const) test(`Codex decisions refuse ${name} with no fallback or retry`, async () => {
  const t = transport();
  const { decisions, close } = primedDecisions(t);
  try {
    await expect(decisions.provider.complete(messages)).rejects.toThrow("Subscription decision failed; no fallback or retry");
    expect(t.turns.length).toBe(name === "an API-key login" ? 0 : 1);
    expect(decisions.snapshot().closed).toBe(closes);
  } finally { await close(); }
});

test("a stalled Codex decision is interrupted at its deadline; settled, it leaves admission open", async () => {
  const t = appServerTransport({ hang: true });
  const { decisions, close } = primedDecisions(t, { callTimeoutMs: 200 });
  try {
    await expect(decisions.provider.complete(messages)).rejects.toThrow("no fallback or retry");
    expect(t.requests.filter(r => r.method === "turn/interrupt")).toHaveLength(1);
    expect(decisions.snapshot()).toMatchObject({ closed: false, active: false });
    expect(t.launches[0]!.exited).toBe(false);
  } finally { await close(); }
});

test("an unacknowledged interrupt recycles the process before the decision reports settled", async () => {
  const t = appServerTransport({ hang: true, ignoreInterrupt: true });
  const { decisions, close } = primedDecisions(t, { callTimeoutMs: 200 });
  try {
    await expect(decisions.provider.complete(messages)).rejects.toThrow("no fallback or retry");
    expect(t.launches[0]!.exited).toBe(true);
    expect(decisions.snapshot().closed).toBe(false);
  } finally { await close(); }
});

test("a substituted model is refused even though the turn completed", async () => {
  const t = appServerTransport({ model: "other-model" });
  const { decisions, close } = primedDecisions(t);
  try {
    await expect(decisions.provider.complete(messages)).rejects.toThrow("no fallback or retry");
    expect(decisions.snapshot().closed).toBe(true);
  } finally { await close(); }
});

test("the decision scheduler accepts a Codex decision only with settled ownership evidence", async () => {
  const transport = appServerTransport();
  const { decisions, close } = primedDecisions(transport, { maxCalls: 3, maxQueued: 2 });
  try {
    const observed: NativeEvidence[] = [];
    const owner = { threadId: "T", generation: "G", dispatchId: "D" };
    const result = await decisions.provider.complete(messages, { threadId: "T:aux:route", nativeObservation: { owner, register(e) { observed.push(e); }, observe(e) { observed.push(e); } } });
    expect(result.content).toBe("accepted-private-answer");
    expect(result.native?.owner?.providerSessionKey).toBe("T:aux:route");
    expect(observed.map(e => e.nativeOutcome)).toEqual(["unknown", "completed"]);
    expect(observed[0]!.admissionId).toBe(observed[1]!.admissionId);
    await expect(decisions.provider.complete(messages, { model: "gpt-6-astra" })).rejects.toThrow("refused");
    expect(decisions.snapshot()).toMatchObject({ attempts: 1, closed: false });
  } finally { await close(); }
});

test("a refused registration dispatches nothing and leaves admission open", async () => {
  const transport = appServerTransport();
  const { decisions, close } = primedDecisions(transport);
  try {
    await expect(decisions.provider.complete(messages, { threadId: "T:aux:route", nativeObservation: { owner: { threadId: "T", generation: "G", dispatchId: "D" },
      register() { throw Error("journal refused"); }, observe() {} } })).rejects.toThrow("no fallback or retry");
    expect(transport.turns).toHaveLength(0);
    expect(decisions.snapshot().closed).toBe(false);
  } finally { await close(); }
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
  const codex = appServerTransport({ hang: true });
  const primed = createPrimedDecisionHost({ source: defaultProfileSource("codex"), directory, model: "gpt-5.6-luna", maxConcurrent: 1, callTimeoutMs: 20000, spawn: codex.spawn });
  const decisions = buildSubscriptionDecisions({ directory, source: defaultProfileSource("codex"), model: "gpt-5.6-luna", maxCalls: 3, maxQueued: 2, callTimeoutMs: 20000 },
    primed.createRun);
  const pending = decisions.provider.complete(messages).then(() => undefined, (error: Error) => error);
  for (let n = 0; !codex.turns.length; n++) { if (n > 200) throw Error("decision never launched"); await Bun.sleep(5); }
  expect(existsSync(join(root, ".codex", ".foundry-auth-shared"))).toBe(true);

  await Promise.all([adapter.releaseAll(), decisions.shutdown().then(() => primed.close())]);
  expect((await pending)?.message).toContain("no fallback");
  expect(worker.launches[0]!.exited).toBe(true); expect(codex.launches[0]!.exited).toBe(true);
  expect(existsSync(join(root, ".claude", ".foundry-auth-lock"))).toBe(false);
  expect(existsSync(join(root, ".codex", ".foundry-auth-shared"))).toBe(false);
  expect(decisions.snapshot()).toMatchObject({ closed: true, active: false });
});
