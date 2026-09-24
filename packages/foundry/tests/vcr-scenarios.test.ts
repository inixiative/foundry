// Foundry's native protocol surfaces, recorded from the real CLIs and services on the
// developer's machine. `bun run test` replays them; `bun run test:live` runs every scenario
// live, re-records it, then replays the fresh cassette in-process and requires the same
// conclusion. Each replay also compares against the conclusion live reached when recorded.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VCR, vcrMode, httpCassettes, webSocketCassettes } from "../src/vcr";
import { buildNativeTextProvider, subscriptionStatus } from "../src/providers/native-text-provider";
import { buildCodexTextProvider, codexSubscriptionStatus } from "../src/providers/codex-text-provider";
import { SubscriptionAuthentication } from "../src/providers/subscription-authentication";
import { ClaudeCodeSessionAdapter, CodexSessionAdapter, InMemoryExternalSessionStore } from "../src/providers/session-adapter";
import { SessionBackedProvider } from "../src/providers/session-backed";
import { KingdomRuntimeConnection } from "../src/providers/kingdom-runtime-connection";
import { ProcessCassettes } from "../src/vcr";
import { ANSWER, DECIDED, LIVE, answerPrompt, decisionMessages, claudeVcr, codexVcr, kingdomVcr, recordedClaudeTransport, recordedCodexTransport, sameAsLive, settleRecordings } from "./helpers/vcr";

const recording = vcrMode() === "record";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(settleRecordings);

function root() {
  const directory = mkdtempSync(join(tmpdir(), "vcr-scenario-")); roots.push(directory);
  return directory;
}
function source(runtime: "claude" | "codex", directory: string) {
  const profileDirectory = join(directory, "profile"); mkdirSync(profileDirectory, { mode: 0o700 });
  return { id: crypto.randomUUID(), connectionId: crypto.randomUUID(), runtime, mode: "native-profile" as const, profileDirectory };
}

/** Runs a scenario, checks it against live's recorded conclusion, and on a live run replays it immediately. */
async function scenario<T>(vcr: VCR, name: string, run: () => Promise<T>): Promise<T> {
  const now = JSON.parse(JSON.stringify(await run())) as T;
  expect(now).toEqual((await sameAsLive(vcr, name, now)).live);
  if (recording) {
    await settleRecordings();
    process.env.FOUNDRY_VCR = "replay";
    try { expect(JSON.parse(JSON.stringify(await run()))).toEqual(now); }
    finally { process.env.FOUNDRY_VCR = "record"; }
  }
  return now;
}

const messages = decisionMessages();
const LIVE_TIMEOUT = 90_000;

test("claude auth status: the login is a claude.ai subscription, and the account never reaches the cassette", async () => {
  const vcr = claudeVcr();
  expect(await scenario(vcr, "auth-status", async () => {
    const status = recordedClaudeTransport({ status: ["subscribed"] }, vcr);
    const started = Date.now();
    const subscribed = await subscriptionStatus(status.statusSpawn("unused"));
    return { subscribed, withinStatusDeadline: Date.now() - started < 20_000 };
  })).toEqual({ subscribed: true, withinStatusDeadline: true });
}, LIVE_TIMEOUT);

test("codex login status: the login is a ChatGPT subscription", async () => {
  const vcr = codexVcr();
  expect(await scenario(vcr, "login-status", async () => {
    const status = recordedCodexTransport({ status: ["chatgpt"] }, vcr);
    return { subscribed: await codexSubscriptionStatus(status.statusSpawn("unused")) };
  })).toEqual({ subscribed: true });
}, LIVE_TIMEOUT);

test("claude text decision: one stream-json turn, text only, observed model acknowledged, process released", async () => {
  const vcr = claudeVcr();
  const out = await scenario(vcr, "decision", async () => {
    const transport = recordedClaudeTransport({ status: ["subscribed"], decision: ["answer"] }, vcr);
    const directory = root();
    const run = buildNativeTextProvider({ directory, source: source("claude", directory), runId: crypto.randomUUID(), model: LIVE.claudeModel,
      expectedObservedModel: LIVE.claudeObservedModel, maxCalls: 1, callTimeoutMs: 30_000 }, transport);
    const result = await run.provider.complete(messages);
    const call = run.snapshot().calls[0]!;
    return { content: result.content, model: result.model, tokens: !!result.tokens?.output,
      native: { outcome: result.native?.nativeOutcome, observedModel: result.native?.configuration?.observedModel, terminal: result.native?.terminal?.type },
      call: { valid: call.valid, release: call.release, processExit: call.processExit, statusProcessExit: call.statusProcessExit } };
  });
  expect(out.content).toMatch(DECIDED);
  expect(out).toMatchObject({ native: { outcome: "completed", observedModel: LIVE.claudeObservedModel }, call: { valid: true, release: "released", processExit: "exited", statusProcessExit: "exited" } });
}, LIVE_TIMEOUT);

test("codex decision: one ephemeral `codex exec --json` turn on the ChatGPT login, answered within the decision deadline", async () => {
  const vcr = codexVcr();
  const out = await scenario(vcr, "decision", async () => {
    const transport = recordedCodexTransport({ status: ["chatgpt"], decision: ["answer"] }, vcr);
    const directory = root();
    const run = buildCodexTextProvider({ directory, source: source("codex", directory), runId: crypto.randomUUID(), model: LIVE.codexModel,
      maxCalls: 1, callTimeoutMs: 30_000 }, transport);
    const result = await run.provider.complete(messages);
    const call = run.snapshot().calls[0]!;
    return { content: result.content, model: result.model, tokens: !!result.tokens?.output, native: result.native?.nativeOutcome,
      call: { valid: call.valid, release: call.release, processExit: call.processExit, statusProcessExit: call.statusProcessExit } };
  });
  expect(out.content).toMatch(DECIDED);
  expect(out).toMatchObject({ model: LIVE.codexModel, tokens: true, native: "completed", call: { valid: true, release: "released", processExit: "exited", statusProcessExit: "exited" } });
}, LIVE_TIMEOUT);

test("claude worker session: two turns on one persistent stream-json process behind the subscription status gate", async () => {
  const vcr = claudeVcr();
  const out = await scenario(vcr, "worker", async () => {
    const transport = recordedClaudeTransport({ status: ["subscribed"], decision: [] }, vcr);
    vcr.queue("worker", "two-turns");
    const worker = new ProcessCassettes(vcr, "worker");
    const directory = root(), cwd = join(directory, "project"); mkdirSync(cwd);
    const auth = new SubscriptionAuthentication(directory, source("claude", directory), transport.statusSpawn);
    const adapter = new ClaudeCodeSessionAdapter({ authentication: auth, store: new InMemoryExternalSessionStore(), defaults: { spawn: worker.spawn } });
    const provider = new SessionBackedProvider({ id: "worker", adapter, defaultModel: LIVE.claudeModel, defaultCwd: cwd });
    try {
      const first = await provider.complete([{ role: "user", content: answerPrompt("first turn") }], { threadId: "worker", cwd });
      const second = await provider.complete([{ role: "user", content: answerPrompt("second turn") }], { threadId: "worker", cwd });
      return { turns: [first.content, second.content], launches: worker.launches.length, writes: worker.writes, statusChecks: transport.statusChecks,
        sameSession: !!first.native?.nativeSessionId && first.native.nativeSessionId === second.native?.nativeSessionId };
    } finally { await adapter.releaseAll(); }
  });
  expect(out).toEqual({ turns: [ANSWER, ANSWER], launches: 1, writes: 2, statusChecks: 1, sameSession: true });
}, LIVE_TIMEOUT);

test("codex app-server: JSON-RPC initialize, thread/start and one turn/start on the ChatGPT login", async () => {
  const vcr = codexVcr();
  const out = await scenario(vcr, "app-server", async () => {
    const server = new ProcessCassettes(vcr.queue("app-server", "turn"), "app-server", { model: LIVE.codexModel });
    const directory = root(), cwd = join(directory, "project"); mkdirSync(cwd);
    const adapter = new CodexSessionAdapter({ engine: "app-server", store: new InMemoryExternalSessionStore(), defaults: { spawn: server.spawn } });
    const provider = new SessionBackedProvider({ id: "app-server", adapter, defaultModel: LIVE.codexModel, defaultCwd: cwd });
    try {
      const result = await provider.complete([{ role: "user", content: answerPrompt() }], { threadId: "main", cwd });
      return { content: result.content, outcome: result.native?.nativeOutcome, rpc: result.native?.rpcOutcome, terminal: result.native?.terminal?.type,
        observedModel: result.native?.configuration?.observedModel, launches: server.launches.length };
    } finally { await adapter.releaseAll(); }
  });
  expect(out).toEqual({ content: ANSWER, outcome: "completed", rpc: "resolved", terminal: "turn/completed", observedModel: LIVE.codexModel, launches: 1 });
}, LIVE_TIMEOUT);

const kingdomUp = !recording || await fetch(`${LIVE.kingdomUrl}/health`, { signal: AbortSignal.timeout(2_000) }).then(r => r.ok, () => false);
if (!kingdomUp) console.warn(`VCR: Kingdom is not reachable at ${LIVE.kingdomUrl}; its cassettes were not refreshed`);

test.skipIf(!kingdomUp)("kingdom runtime heartbeat: an unenrolled installation credential is refused and the connection reports unavailable", async () => {
  const vcr = kingdomVcr();
  expect(await scenario(vcr, "heartbeat", async () => {
    const directory = root(), credentialFile = join(directory, "runtime.json");
    writeFileSync(credentialFile, JSON.stringify({ secret: `kastle_runtime_${"x".repeat(43)}` }), { mode: 0o600 });
    const connection = new KingdomRuntimeConnection({ url: LIVE.kingdomUrl, installationId: crypto.randomUUID(), credentialFile }, () => 0,
      httpCassettes(vcr.queue("runtime-heartbeat", "unenrolled"), "runtime-heartbeat"));
    const error = await connection.check().then(() => undefined, (e: Error) => e.message);
    connection.stop();
    return { connected: connection.connected, error };
  })).toEqual({ connected: false, error: "Kingdom runtime unavailable; check enrollment, expiry and connection" });
}, LIVE_TIMEOUT);

test.skipIf(!kingdomUp)("kingdom websocket: connect, ping and an anonymous authenticate", async () => {
  const vcr = kingdomVcr();
  expect(await scenario(vcr, "socket", async () => {
    const socket = webSocketCassettes(vcr.queue("socket", "anonymous"), "socket")(`${LIVE.kingdomUrl.replace(/^http/, "ws")}/`);
    const seen: Record<string, unknown>[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Kingdom socket did not answer")), 10_000);
      socket.onmessage = event => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        seen.push(message);
        if (message.type === "connected") socket.send(JSON.stringify({ action: "ping" }));
        if (message.type === "pong") socket.send(JSON.stringify({ action: "authenticate", headers: {} }));
        if (message.type === "identity") { clearTimeout(timer); socket.close(1000); resolve(); }
      };
    });
    return seen.map(message => ({ type: message.type, ...(message.type === "identity" ? { userId: message.userId } : {}),
      ...(message.type === "connected" ? { connectionId: typeof message.connectionId } : {}) }));
  })).toEqual([{ type: "connected", connectionId: "string" }, { type: "pong" }, { type: "identity", userId: null }]);
}, LIVE_TIMEOUT);
