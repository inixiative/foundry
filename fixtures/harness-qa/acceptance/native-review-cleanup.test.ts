import { expect, test } from "bun:test";
import { ClaudeCodeSessionAdapter, InMemoryExternalSessionStore, type ClaudeCodeSessionAdapterConfig } from "../../../packages/foundry/src/providers/session-adapter";
import { SessionBackedProvider } from "../../../packages/foundry/src/providers/session-backed";

type Proc = ReturnType<NonNullable<NonNullable<ClaudeCodeSessionAdapterConfig["defaults"]>["spawn"]>>;

function fixture(automaticTerminal: boolean) {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let errors!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (code: number) => void;
  let sent!: () => void;
  const started = new Promise<void>(resolve => { sent = resolve; });
  const stdout = new ReadableStream<Uint8Array>({ start(controller) { output = controller; } });
  const stderr = new ReadableStream<Uint8Array>({ start(controller) { errors = controller; } });
  const exited = new Promise<number>(resolve => { exit = resolve; });
  let kills = 0;
  let didExit = false;
  let sequence = 0;
  const emit = (raw: object) => output.enqueue(new TextEncoder().encode(JSON.stringify(raw) + "\n"));
  const terminal = () => emit({ type: "result", subtype: "success", is_error: false, result: "CONTROLLED_COMPLETED_REVIEW",
    session_id: "controlled-review-binding", uuid: `result-${++sequence}` });
  const proc: Proc = { stdout, stderr, exited,
    kill() { kills++; },
    stdin: { write(data: string) { if (data.trim()) { sent(); if (automaticTerminal) queueMicrotask(terminal); } }, flush() {}, end() {} },
  };
  const adapter = new ClaudeCodeSessionAdapter({ store: new InMemoryExternalSessionStore(), defaults: { spawn: () => {
    queueMicrotask(() => emit({ type: "system", subtype: "init", session_id: "controlled-review-binding" }));
    return proc;
  } } });
  const provider = new SessionBackedProvider({ id: "claude-code", adapter, defaultModel: "controlled", defaultCwd: "/controlled/no-process" });
  const opts = { threadId: "work:aux:review:owned-generation:domain:conventions", tools: false, maxTurns: 1 };
  return { provider, opts, started, terminal, get kills() { return kills; }, get didExit() { return didExit; }, close() {
    if (didExit) return; didExit = true; output.close(); errors.close(); exit(0);
  } };
}

test("requesting cleanup of an idle native review is not proof that its process was released", async () => {
  const f = fixture(true);
  let cleanup: Promise<unknown> | undefined;
  try {
    const result = await f.provider.complete([{ role: "user", content: "Controlled review" }], f.opts);
    expect(f.provider.completionLifecycle.settlement({ result })).toBe("settled");
    cleanup = f.provider.completionLifecycle.releaseIdle!(f.opts);
    const observation = await Promise.race([
      cleanup.then(status => ({ status })), Bun.sleep(20).then(() => ({ pending: true })),
    ]);
    expect(f.kills).toBe(1);
    expect(f.didExit).toBe(false);
    if ("status" in observation) expect(observation.status).not.toBe("released");
  } finally { f.close(); await cleanup; }
});

test("cleanup cannot kill an active review with unknown native outcome", async () => {
  const f = fixture(false);
  const work = f.provider.complete([{ role: "user", content: "Held review" }], f.opts);
  try {
    await f.started;
    expect(await f.provider.completionLifecycle.releaseIdle!(f.opts)).toBe("unknown");
    expect(f.kills).toBe(0);
  } finally { f.terminal(); await work; f.close(); }
});
