import { expect, test } from "bun:test";
import { ClaudeCodeSessionAdapter, InMemoryExternalSessionStore, type ClaudeCodeSessionAdapterConfig, type SessionAdapter } from "../../../packages/foundry/src/providers/session-adapter";
import { SessionBackedProvider } from "../../../packages/foundry/src/providers/session-backed";

type Session = Awaited<ReturnType<SessionAdapter["createSession"]>>;
type Proc = ReturnType<NonNullable<NonNullable<ClaudeCodeSessionAdapterConfig["defaults"]>["spawn"]>>;

function fixture() {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let errors!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (code: number) => void;
  let closed = false;
  let sends = 0;
  let session!: Session;
  const stdout = new ReadableStream<Uint8Array>({ start(c) { output = c; } });
  const stderr = new ReadableStream<Uint8Array>({ start(c) { errors = c; } });
  const exited = new Promise<number>(resolve => { exit = resolve; });
  const emit = (raw: object) => output.enqueue(new TextEncoder().encode(JSON.stringify(raw) + "\n"));
  const kill = () => {
    if (closed) return;
    closed = true;
    output.close(); errors.close(); exit(0);
  };
  const proc: Proc = { stdout, stderr, exited, kill, stdin: {
    write(data: string) {
      for (const line of data.split("\n")) if (line.trim()) {
        sends++;
        const n = sends;
        queueMicrotask(() => emit({ type: "result", subtype: "success", is_error: false,
          result: "Controlled", session_id: "controlled-binding", uuid: `controlled-${n}` }));
      }
    }, flush() {}, end() {},
  } };
  const adapter = new ClaudeCodeSessionAdapter({ store: new InMemoryExternalSessionStore(), defaults: {
    spawn: () => {
      // Production adapter/registry parser over synthetic streams. No model or
      // configuration label is ever emitted; no OS process is created.
      queueMicrotask(() => emit({ type: "system", subtype: "init", session_id: "controlled-binding" }));
      return proc;
    },
  } });
  const create = adapter.createSession.bind(adapter);
  adapter.createSession = async opts => { session = await create(opts); return session; };
  const provider = new SessionBackedProvider({ id: "claude-code", adapter, defaultModel: "fable", defaultCwd: "/controlled/offline" });
  return { provider, adapter, get session() { return session; }, get sends() { return sends; }, close: kill };
}

function forge(raw: unknown) {
  try {
    Object.assign(raw as object, { type: "system", subtype: "init", session_id: "controlled-binding", model: "FABRICATED_CLIENT_MODEL" });
  } catch { /* Immutable evidence may reject mutation; detached copies may allow it. */ }
}

test("caller mutation cannot manufacture native model acknowledgment from historical events", async () => {
  const f = fixture();
  try {
    const first = await f.provider.complete([{ role: "user", content: "one" }], { threadId: "work" });
    const raw = first.raw as { nativeModel?: string; events: Array<{ raw?: unknown }> };
    expect(raw.nativeModel).toBeUndefined();
    expect(raw.events.length).toBeGreaterThan(0);
    forge(raw.events[0].raw);
    const second = await f.provider.complete([{ role: "user", content: "two" }], { threadId: "work" });
    expect((second.raw as { nativeModel?: string }).nativeModel).toBeUndefined();
    expect(f.sends).toBe(2);
  } finally { f.close(); }
});

test("an external session observer cannot fabricate configuration before the provider reads it", async () => {
  const f = fixture();
  try {
    await f.provider.complete([{ role: "user", content: "one" }], { threadId: "work" });
    const dispose = f.session.onEvent(event => { if (event.kind === "result") forge(event.raw); });
    try {
      const second = await f.provider.complete([{ role: "user", content: "two" }], { threadId: "work", timeout: 100 });
      expect((second.raw as { nativeModel?: string }).nativeModel).toBeUndefined();
      expect(f.sends).toBe(2);
    } finally { dispose(); }
  } finally { f.close(); }
});

test("mutating a returned configuration collection cannot inject a model acknowledgment", async () => {
  const f = fixture();
  try {
    const first = await f.provider.complete([{ role: "user", content: "one" }], { threadId: "work" });
    expect((first.raw as { nativeModel?: string }).nativeModel).toBeUndefined();
    const facts = f.adapter.observedConfiguration(f.session);
    expect(facts).toBeDefined();
    try {
      (facts as unknown as unknown[]).push({ envelope: "system-init", binding: "controlled-binding",
        model: "FABRICATED_COLLECTION_MODEL", observedAt: Date.now() });
    } catch { /* A frozen collection may reject mutation; a detached one may allow it. */ }
    const second = await f.provider.complete([{ role: "user", content: "two" }], { threadId: "work" });
    expect((second.raw as { nativeModel?: string }).nativeModel).toBeUndefined();
    expect(f.sends).toBe(2);
  } finally { f.close(); }
});
