import { expect, test } from "bun:test";
import { CodexAppServerSession, type SessionResult } from "../../../../agent-session/src";

type Request = { id?: number; method: string; params?: Record<string, unknown> };
const threadId = "controlled-outcome-thread";
const turnId = "controlled-outcome-turn";
const flush = async () => { await Bun.sleep(0); await Bun.sleep(0); };

// Valid installed-schema response/notification shapes over controlled pipes.
// Unlike the wire smoke, native completion is asserted independently of RPC.
function fixture() {
  const requests: Request[] = [];
  let out!: ReadableStreamDefaultController<Uint8Array>, exit!: (code: number) => void;
  let closed = false;
  const emit = (value: unknown) => out.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n"));
  const turn = (status: string, id = turnId) => ({ id, status, items: [],
    error: status === "failed" ? { message: "CONTROLLED_NATIVE_FAILURE", codexErrorInfo: null, additionalDetails: null } : null });
  const proc = {
    stdout: new ReadableStream<Uint8Array>({ start(c) { out = c; } }),
    stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
    exited: new Promise<number>(resolve => { exit = resolve; }),
    kill() { if (!closed) { closed = true; out.close(); exit(143); } },
    stdin: { write(line: string) {
      const r = JSON.parse(line) as Request; requests.push(r);
      if (r.id === undefined) return;
      queueMicrotask(() => {
        if (closed) return;
        const result = ["thread/start", "thread/resume"].includes(r.method) ? { thread: { id: threadId, status: { type: "idle" }, turns: [] } }
          : r.method === "turn/start" ? { turn: turn("inProgress") } : {};
        emit({ id: r.id, result });
        if (r.method === "turn/start") emit({ method: "turn/started", params: { threadId, turn: turn("inProgress") } });
      });
    }, flush() {}, end() {} },
  };
  const session = new CodexAppServerSession({ model: "gpt-6-astra", effort: "xhigh", timeout: 300,
    cwd: process.cwd(), spawn: () => proc });
  let admissionId: string | undefined, settled = false, result: SessionResult | undefined, error: unknown;
  let pending: Promise<void> | undefined;
  return {
    session, requests,
    get settled() { return settled; }, get result() { return result; }, get error() { return error; },
    get evidence() { return admissionId ? session.inspectAttempt(admissionId) : undefined; },
    async start(rejectAdmission = false) {
      await session.start();
      pending = session.send("Controlled native outcomes", { onAdmission: async admission => {
        admissionId = admission.admissionId;
        if (rejectAdmission) throw Error("CONTROLLED_JOURNAL_FAILURE");
      } }).then(value => { settled = true; result = value; }, e => { settled = true; error = e; });
      await flush();
    },
    complete(status = "completed", owner = threadId, id = turnId) {
      emit({ method: "turn/completed", params: { threadId: owner, turn: turn(status, id) } });
    },
    async close() { session.kill(); await proc.exited; await pending; },
  };
}

test("app-server owned completion establishes native outcome separately from the start RPC", async () => {
  const f = fixture();
  try {
    await f.start(); expect(f.settled).toBe(false);
    f.complete(); await flush();
    expect(f.error).toBeUndefined();
    expect(f.result).toMatchObject({ nativeOutcome: "completed" });
    expect(f.evidence).toMatchObject({ nativeOutcome: "completed", rpcOutcome: "resolved", threadId, turnId });
  } finally { await f.close(); }
});

test("app-server failed native turn retains explicit failure independently of local settlement", async () => {
  const f = fixture();
  try {
    await f.start(); f.complete("failed"); await flush();
    expect(f.settled).toBe(true);
    const failure = f.result ?? (f.error as { attempt?: { nativeOutcome?: string } } | undefined)?.attempt;
    expect(failure?.nativeOutcome).toBe("failed");
    expect(f.evidence?.nativeOutcome).toBe("failed");
  } finally { await f.close(); }
});

test("app-server foreign thread and turn completions cannot settle the admitted work", async () => {
  const f = fixture();
  try {
    await f.start();
    f.complete("completed", "foreign-thread");
    f.complete("completed", threadId, "foreign-turn");
    await flush();
    expect(f.settled).toBe(false); expect(f.evidence?.nativeOutcome).toBe("unknown");
    f.complete(); await flush(); expect(f.result?.nativeOutcome).toBe("completed");
  } finally { await f.close(); }
});

test("app-server requested effort uses the native turn effort field", async () => {
  const f = fixture();
  try {
    await f.start();
    expect(f.requests.find(r => r.method === "turn/start")?.params?.effort).toBe("xhigh");
    expect(f.requests.find(r => r.method === "thread/start")?.params).not.toHaveProperty("modelReasoningEffort");
  } finally { await f.close(); }
});

test("control: refused durable admission writes no app-server thread or turn work", async () => {
  const f = fixture();
  try {
    await f.start(true);
    expect(f.settled).toBe(true); expect(String(f.error)).toContain("CONTROLLED_JOURNAL_FAILURE");
    expect(f.requests.filter(r => ["thread/start", "thread/resume", "turn/start"].includes(r.method))).toHaveLength(0);
    expect(f.evidence?.dispatch).toBe("not-dispatched");
  } finally { await f.close(); }
});
