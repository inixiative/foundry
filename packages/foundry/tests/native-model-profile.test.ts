import { expect, test } from "bun:test";
import type { ClaudeCodeSessionConfig, CodexSessionConfig, HarnessSession, SessionEvent } from "@inixiative/agent-session";
import { ClaudeCodeSessionAdapter, CodexSessionAdapter, InMemoryExternalSessionStore, type ConfigurationEvidence } from "../src/providers/session-adapter";
import { SessionBackedProvider } from "../src/providers/session-backed";

// Offline: fake subprocesses capture the argv and first native MCP configuration
// the production adapters emit. Nothing here proves which model actually ran;
// it proves what Foundry requested reached the engine's spawn or first call.

type ClaudeProc = ReturnType<NonNullable<ClaudeCodeSessionConfig["spawn"]>>;
type CodexProc = ReturnType<NonNullable<CodexSessionConfig["spawn"]>>;

function streamPair() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
  const stderr = new ReadableStream<Uint8Array>({ start() {} });
  let exit!: (code: number) => void;
  const exited = new Promise<number>((r) => { exit = r; });
  const emit = (j: Record<string, unknown>) => ctrl.enqueue(new TextEncoder().encode(JSON.stringify(j) + "\n"));
  return { stdout, stderr, exited, emit, kill: () => { try { ctrl.close(); } catch {} exit(143); } };
}

function claudeCapture(sessionId = "claude-native-1", initModel?: string) {
  const calls: Array<{ cmd: string[]; turns: string[] }> = [];
  const spawn = (cmd: string[]) => {
    const s = streamPair();
    const turns: string[] = [];
    calls.push({ cmd, turns });
    queueMicrotask(() => s.emit({ type: "system", subtype: "init", session_id: sessionId, ...(initModel ? { model: initModel } : {}) }));
    const proc: ClaudeProc = {
      stdin: { write(data: string) {
        for (const line of data.split("\n")) if (line.trim()) {
          turns.push(line);
          queueMicrotask(() => s.emit({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: sessionId,
            uuid: `r-${turns.length}`, usage: { input_tokens: 1, output_tokens: 1 } }));
        }
      }, flush() {}, end() {} },
      stdout: s.stdout, stderr: s.stderr, exited: s.exited, kill: s.kill,
    };
    return proc;
  };
  return { calls, spawn };
}

function codexCapture(threadId = "codex-thread-1", extra: { configuredModel?: string } = {}) {
  const calls: Array<{ cmd: string[]; requests: Array<{ method?: string; params?: any }> }> = [];
  const spawn = (cmd: string[]) => {
    const s = streamPair();
    const requests: Array<{ method?: string; params?: any }> = [];
    calls.push({ cmd, requests });
    const configured = () => { if (extra.configuredModel) s.emit({ jsonrpc: "2.0", method: "codex/event", params: { msg: { type: "session_configured", thread_id: threadId, session_id: threadId, model: extra.configuredModel } } }); };
    const proc: CodexProc = {
      stdin: { write(data: string) {
        for (const line of data.split("\n")) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as { id?: number; method?: string; params?: any };
          requests.push({ method: msg.method, params: msg.params });
          if (typeof msg.id !== "number") continue;
          queueMicrotask(() => {
            if (msg.method === "initialize") s.emit({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {} } });
            else if (msg.method === "tools/list") s.emit({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "codex", inputSchema: {} }, { name: "codex-reply", inputSchema: {} }] } });
            else if (msg.method === "tools/call") {
              configured();
              // Explicit controlled protocol terminals; RPC resolution alone must
              // not make the candidate engine available for another admission.
              const turn = `controlled-turn-${msg.id}`;
              for(const type of ["task_started","task_complete"]) s.emit({jsonrpc:"2.0",method:"codex/event",params:{id:turn,msg:{type,turn_id:turn}}});
              s.emit({ jsonrpc: "2.0", id: msg.id, result: { structuredContent: { threadId, content: "ok" }, content: [{ type: "text", text: "ok" }] } });
            }
          });
        }
      }, flush() {}, end() {} },
      stdout: s.stdout, stderr: s.stderr, exited: s.exited, kill: s.kill,
    };
    return proc;
  };
  return { calls, spawn };
}

const argAfter = (cmd: string[], flag: string) => cmd[cmd.indexOf(flag) + 1];

test("Claude adapter: explicit model reaches --model argv; absent model falls back to the adapter default", async () => {
  const { calls, spawn } = claudeCapture();
  const adapter = new ClaudeCodeSessionAdapter({ store: new InMemoryExternalSessionStore(), defaults: { bin: "claude", model: "fable", spawn } });
  const explicit = await adapter.createSession({ threadId: "t1", cwd: "/tmp/p", model: "haiku", tools: false, maxTurns: 1 });
  await explicit.start();
  const fallback = await adapter.createSession({ threadId: "t2", cwd: "/tmp/p" });
  await fallback.start();
  expect(argAfter(calls[0].cmd, "--model")).toBe("haiku");
  expect(argAfter(calls[0].cmd, "--max-turns")).toBe("1");
  for (const flag of ["--safe-mode", "--tools", "--strict-mcp-config", "--disable-slash-commands"]) expect(calls[0].cmd).toContain(flag);
  expect(argAfter(calls[1].cmd, "--model")).toBe("fable");
  expect(calls[1].cmd).not.toContain("--safe-mode");
  explicit.kill(); fallback.kill();
});

test("Codex adapter: explicit and fallback models reach the first native `codex` call configuration", async () => {
  const { calls, spawn } = codexCapture();
  const adapter = new CodexSessionAdapter({ store: new InMemoryExternalSessionStore(), defaults: { bin: "codex", model: "gpt-5.5", spawn } });
  const explicit = await adapter.createSession({ threadId: "c1", cwd: "/tmp/p", model: "gpt-6-astra" });
  await explicit.start(); await explicit.send("first");
  const fallback = await adapter.createSession({ threadId: "c2", cwd: "/tmp/p" });
  await fallback.start(); await fallback.send("first");
  const firstCall = (i: number) => calls[i].requests.find((r) => r.method === "tools/call")!;
  expect(firstCall(0).params.name).toBe("codex");
  expect(firstCall(0).params.arguments.model).toBe("gpt-6-astra");
  expect(firstCall(1).params.arguments.model).toBe("gpt-5.5");
  // Text-only remains unenforceable on this adapter and must still fail closed.
  await expect(adapter.createSession({ threadId: "c3", cwd: "/tmp/p", model: "gpt-6-astra", tools: false })).rejects.toThrow(/text-only/);
  explicit.kill(); fallback.kill();
});

test("provider over the real Claude adapter: a changed model cannot dispatch into the warm process, identical models reuse it, and the profile is inspectable", async () => {
  const { calls, spawn } = claudeCapture("claude-native-9");
  const adapter = new ClaudeCodeSessionAdapter({ store: new InMemoryExternalSessionStore(), defaults: { bin: "claude", spawn } });
  const provider = new SessionBackedProvider({ id: "claude-code", adapter, defaultModel: "fable", defaultCwd: "/tmp/p" });
  const first = await provider.complete([{ role: "user", content: "one" }], { threadId: "work" });
  await provider.complete([{ role: "user", content: "two" }], { threadId: "work", model: "fable" });
  await expect(provider.complete([{ role: "user", content: "three" }], { threadId: "work", model: "haiku" }))
    .rejects.toThrow(/requestedModel: warm "fable", requested "haiku".*not replaced/);
  expect(calls).toHaveLength(1);
  expect(argAfter(calls[0].cmd, "--model")).toBe("fable");
  expect(calls[0].turns).toHaveLength(2);
  expect(provider.warmProfile("work")).toEqual({ requestedModel: "fable", textOnly: false, maxTurns: null, resumedBinding: null, bindingLookup: "resolved",
    preliminaryLookup: null, bindingSource: "construction", bindingId: "work", persistedModelIdentity: "fresh-session" });
  expect(Object.isFrozen(provider.warmProfile("work"))).toBe(true);
  // The fake engine emitted no model label, so nothing claims native acknowledgment.
  expect(first.model).toBe("fable");
  expect((first.raw as any).nativeModel).toBeUndefined();
  expect((first.raw as any).profile.requestedModel).toBe("fable");
});

test("resume provenance stays unknown; only a package that retains own init can acknowledge its model", async () => {
  const store = new InMemoryExternalSessionStore();
  await store.save("work", "claude-code", "persisted-native-7");
  const { calls, spawn } = claudeCapture("persisted-native-7", "claude-fable-5-1");
  const adapter = new ClaudeCodeSessionAdapter({ store, defaults: { bin: "claude", spawn } });
  const provider = new SessionBackedProvider({ id: "claude-code", adapter, defaultModel: "fable", defaultCwd: "/tmp/p" });
  const result = await provider.complete([{ role: "user", content: "one" }], { threadId: "work" });
  expect(argAfter(calls[0].cmd, "--resume")).toBe("persisted-native-7");
  expect(argAfter(calls[0].cmd, "--model")).toBe("fable");
  expect(result.model).toBe("fable");
  // Registry 0.1.0 drops init. The reviewed candidate retains it; both consumers
  // must preserve their actual evidence rather than asserting identical capacity.
  const candidate = (result.raw as any).budgets.enforcement.maxTurns === "launch-option";
  expect((result.raw as any).nativeModel).toBe(candidate ? "claude-fable-5-1" : undefined);
  expect(provider.warmProfile("work")).toMatchObject({ resumedBinding: "persisted-native-7", persistedModelIdentity: "unknown" });
});

test("SYNTHETIC: a supported init envelope for this session's own binding is acknowledged; the same label on a tool event or a foreign binding is not", async () => {
  // These envelopes are synthetic shapes of the supported Claude stream-json init line.
  // Installed agent-session 0.1.0 does not retain the real init event; this proves the
  // correlation rule, not that Claude currently emits an observable acknowledgment.
  const make = (events: unknown[]) => new SessionBackedProvider({ id: "claude-code", defaultModel: "fable", defaultCwd: "/tmp/p", adapter: {
    runtime: "controlled", async getExternalSessionId() { return null; }, async clearSession() {},
    async createSession() { return { events, async start() {}, kill() {}, async send() { return { content: "ok", externalSessionId: "own-binding", events }; } } as any; },
  } as any });
  const own = await make([{ kind: "session_start", timestamp: 1, raw: { type: "system", subtype: "init", session_id: "own-binding", model: "claude-fable-5-1" } }])
    .complete([{ role: "user", content: "one" }], { threadId: "work", model: "haiku" });
  expect(own.model).toBe("haiku");
  expect((own.raw as any).nativeModel).toBe("claude-fable-5-1");
  const foreign = await make([{ kind: "session_start", timestamp: 1, raw: { type: "system", subtype: "init", session_id: "someone-else", model: "X" } }])
    .complete([{ role: "user", content: "one" }], { threadId: "work" });
  expect((foreign.raw as any).nativeModel).toBeUndefined();
  const tool = await make([{ kind: "tool_use", timestamp: 1, raw: { type: "tool_use", model: "X" } }, { kind: "result", timestamp: 2, raw: { type: "result", model: "X" } }])
    .complete([{ role: "user", content: "one" }], { threadId: "work" });
  expect((tool.raw as any).nativeModel).toBeUndefined();
  // Codex: a session_configured envelope naming this thread binding is the supported equivalent.
  const codex = await make([{ kind: "native_status", timestamp: 1, raw: { type: "session_configured", thread_id: "own-binding", model: "gpt-6-astra" } }])
    .complete([{ role: "user", content: "one" }], { threadId: "work" });
  expect((codex.raw as any).nativeModel).toBe("gpt-6-astra");
});

test("a failed binding lookup is retained as failed and unknown, never rewritten as fresh, and a pending lookup is unknown", async () => {
  let release!: (v: string | null) => void;
  const pending = new Promise<string | null>((r) => { release = r; });
  let lookups = 0;
  const provider = new SessionBackedProvider({ id: "claude-code", defaultModel: "fable", defaultCwd: "/tmp/p", adapter: {
    runtime: "controlled", async clearSession() {},
    getExternalSessionId: () => (++lookups === 1 ? pending : Promise.reject(new Error("STORE_DOWN"))),
    async createSession() { return { events: [], async start() {}, kill() {}, async send() { return { content: "ok", externalSessionId: "b", events: [] }; } } as any; },
  } as any });
  const running = provider.complete([{ role: "user", content: "one" }], { threadId: "a" });
  expect(provider.warmProfile("a")).toMatchObject({ bindingLookup: "pending", persistedModelIdentity: "unknown" });
  release(null);
  await running;
  // This controlled adapter neither describes construction nor exposes a binding on its
  // session, so provenance stays unknown rather than being called fresh.
  expect(provider.warmProfile("a")).toMatchObject({ bindingLookup: "resolved", bindingSource: "unavailable", persistedModelIdentity: "unknown" });
  const failed = await provider.complete([{ role: "user", content: "one" }], { threadId: "b" });
  expect((failed.raw as any).profile).toMatchObject({ bindingLookup: "failed", bindingLookupError: "STORE_DOWN", persistedModelIdentity: "unknown", resumedBinding: null });
});

// Evidence ownership around BOTH production adapters over controlled transports.
test("Claude: a genuine init for this binding is acknowledged from owned evidence; caller mutation of returned raw and a later observer cannot forge or break completion", async () => {
  const { spawn } = claudeCapture("own-binding", "claude-fable-5-1");
  const adapter = new ClaudeCodeSessionAdapter({ store: new InMemoryExternalSessionStore(), defaults: { bin: "claude", spawn } });
  let created: any;
  const create = adapter.createSession.bind(adapter);
  adapter.createSession = async (opts) => (created = await create(opts));
  const provider = new SessionBackedProvider({ id: "claude-code", adapter, defaultModel: "fable", defaultCwd: "/tmp/p" });
  const first = await provider.complete([{ role: "user", content: "one" }], { threadId: "work" });
  // Registry 0.1.0 drops init; the additive candidate retains the actual controlled
  // envelope. Neither path is allowed to acknowledge the request or observer forgery.
  const expectedModel = created.admissionProtocol === "prewrite-v1" ? "claude-fable-5-1" : undefined;
  expect((first.raw as any).nativeModel).toBe(expectedModel);
  expect(adapter.observedConfiguration(created)?.map(f=>f.model)).toEqual(expectedModel ? [expectedModel] : []);
  const returned = (first.raw as any).events[0];
  expect(Object.isFrozen(returned)).toBe(true);
  expect(Object.isFrozen(returned.raw)).toBe(true);
  expect(() => { (returned.raw as any).model = "FORGED"; }).toThrow();
  const seen: unknown[] = [];
  const dispose = created.onEvent((event: any) => { seen.push(event); try { Object.assign(event.raw, { type: "system", subtype: "init", session_id: "own-binding", model: "FORGED" }); } catch {} });
  const second = await provider.complete([{ role: "user", content: "two" }], { threadId: "work", timeout: 500 });
  dispose();
  expect((second.raw as any).nativeModel).toBe(expectedModel);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((event: any) => Object.isFrozen(event) && Object.isFrozen(event.raw))).toBe(true);
});

test("owned first-boundary facts win over forged returned events for an adapter that provides them", async () => {
  const facts = [Object.freeze({ envelope: "system-init" as const, binding: "own-binding", model: "engine-observed-model", observedAt: 1 })];
  const forgedEvents = [{ kind: "result", timestamp: 1, raw: { type: "system", subtype: "init", session_id: "own-binding", model: "FORGED_IN_RESULT" } }];
  const provider = new SessionBackedProvider({ id: "claude-code", defaultModel: "fable", defaultCwd: "/tmp/p", adapter: {
    runtime: "controlled", async getExternalSessionId() { return null; }, async clearSession() {},
    observedConfiguration() { return facts; },
    async createSession() { return { async start() {}, kill() {}, async send() { return { content: "ok", externalSessionId: "own-binding", events: forgedEvents }; } } as any; },
  } as any });
  const result = await provider.complete([{ role: "user", content: "one" }], { threadId: "work" });
  expect((result.raw as any).nativeModel).toBe("engine-observed-model");
});

test("Codex: session_configured for this thread is acknowledged from owned evidence and observer mutation cannot forge it", async () => {
  const { spawn } = codexCapture("thread-7", { configuredModel: "gpt-6-astra" });
  const adapter = new CodexSessionAdapter({ store: new InMemoryExternalSessionStore(), defaults: { bin: "codex", spawn } });
  let created: any;
  const create = adapter.createSession.bind(adapter);
  adapter.createSession = async (opts) => (created = await create(opts));
  const provider = new SessionBackedProvider({ id: "codex", adapter, defaultModel: "gpt-6-astra", defaultCwd: "/tmp/p" });
  const first = await provider.complete([{ role: "user", content: "one" }], { threadId: "work" });
  const expectedModel = created.admissionProtocol === "prewrite-v1" ? "gpt-6-astra" : undefined;
  expect((first.raw as any).nativeModel).toBe(expectedModel);
  expect(adapter.observedConfiguration(created)!.every((fact) => fact.model === "gpt-6-astra")).toBe(true);
  const dispose = created.onEvent((event: any) => { try { Object.assign(event.raw, { type: "session_configured", thread_id: "thread-7", model: "FORGED" }); } catch {} });
  const second = await provider.complete([{ role: "user", content: "two" }], { threadId: "work", timeout: 500 });
  dispose();
  expect((second.raw as any).nativeModel).toBe(expectedModel);
  expect((second.raw as any).events.every((event: any) => Object.isFrozen(event))).toBe(true);
});

// Construction provenance around BOTH production adapters. Native start/send are
// replaced only after real construction; no process is spawned.
function offline<T extends { createSession: any }>(adapter: T) {
  const create = adapter.createSession.bind(adapter);
  const seen: Array<string | null> = [];
  adapter.createSession = async (opts: any) => {
    const session = await create(opts);
    seen.push(session.externalSessionId ?? null);
    session.start = async () => {};
    session.send = async () => ({ content: "ok", events: [], externalSessionId: session.externalSessionId ?? "new-binding" });
    return session;
  };
  return seen;
}

test("Claude auxiliary with only preserved coding history constructs fresh: profile says fresh with the text-only binding key, history untouched", async () => {
  const store = new InMemoryExternalSessionStore();
  await store.save("t:aux:classifier", "claude-code", "legacy-coding-binding");
  const adapter = new ClaudeCodeSessionAdapter({ store, defaults: { spawn: () => { throw Error("no spawn"); } } });
  const seen = offline(adapter);
  const provider = new SessionBackedProvider({ id: "claude-code", adapter, defaultModel: "fable", defaultCwd: "/tmp/p" });
  const result = await provider.complete([{ role: "user", content: "classify" }], { threadId: "t:aux:classifier" });
  expect(seen).toEqual([null]);
  expect((result.raw as any).profile).toMatchObject({ bindingSource: "construction", bindingId: "t:aux:classifier:profile:text-only-v1",
    resumedBinding: null, persistedModelIdentity: "fresh-session", preliminaryLookup: "legacy-coding-binding" });
  expect(await store.load("t:aux:classifier", "claude-code")).toBe("legacy-coding-binding");
});

test("Codex central thread: resumed binding is reported from construction; a fresh thread is fresh", async () => {
  const store = new InMemoryExternalSessionStore();
  await store.save("central", "codex", "codex-thread-9");
  const adapter = new CodexSessionAdapter({ store, defaults: { spawn: () => { throw Error("no spawn"); } } });
  const seen = offline(adapter);
  const provider = new SessionBackedProvider({ id: "codex", adapter, defaultModel: "gpt-6-astra", defaultCwd: "/tmp/p" });
  const resumed = await provider.complete([{ role: "user", content: "one" }], { threadId: "central" });
  const fresh = await provider.complete([{ role: "user", content: "one" }], { threadId: "other" });
  expect(seen).toEqual(["codex-thread-9", null]);
  expect((resumed.raw as any).profile).toMatchObject({ bindingSource: "construction", bindingId: "central", resumedBinding: "codex-thread-9", persistedModelIdentity: "unknown" });
  expect((fresh.raw as any).profile).toMatchObject({ bindingSource: "construction", bindingId: "other", resumedBinding: null, persistedModelIdentity: "fresh-session" });
});

test("a store that changes between the diagnostic lookup and construction yields construction truth with the stale lookup visible", async () => {
  const store = new InMemoryExternalSessionStore();
  let loads = 0;
  store.load = async () => (++loads === 1 ? null : "late-binding");
  const adapter = new ClaudeCodeSessionAdapter({ store, defaults: { spawn: () => { throw Error("no spawn"); } } });
  const seen = offline(adapter);
  const provider = new SessionBackedProvider({ id: "claude-code", adapter, defaultModel: "fable", defaultCwd: "/tmp/p" });
  const result = await provider.complete([{ role: "user", content: "one" }], { threadId: "central" });
  expect(seen).toEqual(["late-binding"]);
  expect((result.raw as any).profile).toMatchObject({ preliminaryLookup: null, resumedBinding: "late-binding", bindingSource: "construction", persistedModelIdentity: "unknown" });
});

test("a concurrent different-profile request is refused while the first session is still being created", async () => {
  const { calls, spawn } = claudeCapture();
  const adapter = new ClaudeCodeSessionAdapter({ store: new InMemoryExternalSessionStore(), defaults: { bin: "claude", spawn } });
  const provider = new SessionBackedProvider({ id: "claude-code", adapter, defaultModel: "fable", defaultCwd: "/tmp/p" });
  const a = provider.complete([{ role: "user", content: "one" }], { threadId: "work" });
  const b = provider.complete([{ role: "user", content: "two" }], { threadId: "work", model: "haiku" });
  await expect(b).rejects.toThrow(/profile changed/);
  await a;
  expect(calls).toHaveLength(1);
});

// R1: real production adapters/providers over controlled subprocess streams.
// The installed registry drops configuration notifications. Positive collection
// tests therefore inject explicitly SYNTHETIC supported envelopes at its event
// emitter, without changing parsing/send or claiming real native acknowledgment.
async function configurationCollectionFixture(engine: "claude-code" | "codex") {
  const binding = `${engine}-controlled-binding`;
  const store = new InMemoryExternalSessionStore();
  await store.save("work", engine, binding);
  const adapter = engine === "claude-code"
    ? new ClaudeCodeSessionAdapter({ store, defaults: { spawn: claudeCapture(binding).spawn } })
    : new CodexSessionAdapter({ store, defaults: { spawn: codexCapture(binding).spawn } });
  let session!: HarnessSession;
  const create = adapter.createSession.bind(adapter);
  adapter.createSession = async opts => (session = await create(opts));
  const provider = new SessionBackedProvider({ id: engine, adapter, defaultModel: "requested-only", defaultCwd: "/controlled/offline" });
  let sends = 0;
  const complete = () => provider.complete([{ role: "user", content: `controlled task ${++sends}` }], { threadId: "work", timeout: 500 });
  return {
    adapter, binding, store, provider, complete,
    get session() { return session; },
    emitConfiguration(nativeBinding: string, model: string) {
      const raw = engine === "claude-code"
        ? { type: "system", subtype: "init", session_id: nativeBinding, model }
        : { type: "session_configured", thread_id: nativeBinding, model };
      (session as unknown as { _emit(event: SessionEvent): void })._emit({ kind: "session_start", timestamp: Date.now(), raw });
      return raw;
    },
    close() { session?.kill(); },
  };
}

const collectionAttacks = {
  push: (facts: ConfigurationEvidence[], forged: ConfigurationEvidence) => { facts.push(forged); },
  splice: (facts: ConfigurationEvidence[], forged: ConfigurationEvidence) => { facts.splice(0, 1, forged); },
  replace: (facts: ConfigurationEvidence[], forged: ConfigurationEvidence) => { facts[0] = forged; },
};

for (const engine of ["claude-code", "codex"] as const) {
  test(`${engine}: an owned empty configuration snapshot is distinct from unavailable evidence`, async () => {
    const f = await configurationCollectionFixture(engine);
    try {
      const result = await f.complete();
      expect((result.raw as { nativeModel?: string }).nativeModel).toBeUndefined();
      const empty = f.adapter.observedConfiguration(f.session)!;
      expect(empty).toEqual([]);
      expect(Object.isFrozen(empty)).toBe(true);
      expect(f.adapter.observedConfiguration(f.session)).not.toBe(empty);
      const foreignAdapter = engine === "claude-code"
        ? new ClaudeCodeSessionAdapter({ store: f.store })
        : new CodexSessionAdapter({ store: f.store });
      expect(foreignAdapter.observedConfiguration(f.session)).toBeUndefined();
      f.emitConfiguration(f.binding, "controlled-observed-A");
      expect(empty).toEqual([]);
      expect(f.adapter.observedConfiguration(f.session)).toHaveLength(1);
    } finally { f.close(); }
  });

  for (const [attack, mutate] of Object.entries(collectionAttacks)) {
    test(`${engine}: ${attack} cannot replace collected configuration or forge the next completion`, async () => {
      const f = await configurationCollectionFixture(engine);
      try {
        await f.complete();
        const source = f.emitConfiguration(f.binding, "controlled-observed-A");
        const saved = f.adapter.observedConfiguration(f.session)!;
        const forged = Object.freeze({ envelope: "system-init" as const, binding: f.binding, model: "FORGED", observedAt: 1 });
        expect(() => mutate(saved as ConfigurationEvidence[], forged)).toThrow();
        expect(Object.isFrozen(saved)).toBe(true);
        expect(Object.isFrozen(saved[0])).toBe(true);
        expect(() => Object.assign(saved[0], { model: "FORGED_FACT" })).toThrow();
        source.model = "FORGED_SOURCE";
        const next = await f.complete();
        expect((next.raw as { nativeModel?: string }).nativeModel).toBe("controlled-observed-A");
        expect(f.adapter.observedConfiguration(f.session)).toEqual(saved);
        expect(saved).toHaveLength(1);
        expect(saved[0].model).toBe("controlled-observed-A");
        expect(f.session.turns).toBe(2);
      } finally { f.close(); }
    });
  }

  test(`${engine}: observers cannot alter snapshots, and later own-binding evidence only updates new reads`, async () => {
    const f = await configurationCollectionFixture(engine);
    const disposers: Array<() => void> = [];
    try {
      await f.complete();
      const retained: Array<readonly ConfigurationEvidence[]> = [];
      let rejectedMutations = 0;
      disposers.push(f.session.onEvent(event => {
        if (event.kind !== "session_start") return;
        const facts = f.adapter.observedConfiguration(f.session)!;
        const forged = { envelope: "system-init" as const, binding: f.binding, model: "FORGED_OBSERVER", observedAt: 1 };
        for (const mutate of Object.values(collectionAttacks)) {
          try { mutate(facts as ConfigurationEvidence[], forged); } catch { rejectedMutations++; }
        }
      }));
      disposers.push(f.session.onEvent(event => {
        if (event.kind === "session_start") retained.push(f.adapter.observedConfiguration(f.session)!);
      }));
      f.emitConfiguration("foreign-binding", "foreign-model");
      const foreign = f.adapter.observedConfiguration(f.session)!;
      const withoutOwn = await f.complete();
      expect((withoutOwn.raw as { nativeModel?: string }).nativeModel).toBeUndefined();
      f.emitConfiguration(f.binding, "controlled-observed-A");
      const firstOwn = f.adapter.observedConfiguration(f.session)!;
      const ownA = await f.complete();
      expect((ownA.raw as { nativeModel?: string }).nativeModel).toBe("controlled-observed-A");
      f.emitConfiguration(f.binding, "controlled-observed-B");
      const ownB = await f.complete();
      expect((ownB.raw as { nativeModel?: string }).nativeModel).toBe("controlled-observed-B");
      expect(retained.map(facts => facts.map(fact => fact.model))).toEqual([
        ["foreign-model"],
        ["foreign-model", "controlled-observed-A"],
        ["foreign-model", "controlled-observed-A", "controlled-observed-B"],
      ]);
      expect(rejectedMutations).toBe(9);
      expect(foreign).toEqual(retained[0]);
      expect(firstOwn).toEqual(retained[1]);
      expect(f.adapter.observedConfiguration(f.session)).toEqual(retained[2]);
      expect(f.session.turns).toBe(4);
      expect(f.provider.warmProfile("work")).toMatchObject({ resumedBinding: f.binding });
      expect(await f.store.load("work", engine)).toBe(f.binding);
    } finally { for (const dispose of disposers) dispose(); f.close(); }
  });
}
