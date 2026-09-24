import { expect, test } from "bun:test";
import { CodexAppServerSession } from "../../../../agent-session/src";

type Request = { id?: number; method: string; params?: Record<string, unknown> };

// Controlled transport only. Wire expectations come from the installed 0.153.4
// schema; permissive replies let each assertion isolate one production defect.
async function observe(existing?: string, rejectResume = false, threadOverrides: Record<string, unknown> = {}) {
  const requests: Request[] = [];
  let command: string[] = [], closed = false;
  let out!: ReadableStreamDefaultController<Uint8Array>, exit!: (code: number) => void;
  const emit = (v: unknown) => out.enqueue(new TextEncoder().encode(JSON.stringify(v) + "\n"));
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
        if (r.method === "thread/resume" && rejectResume) {
          emit({ id: r.id, error: { code: -32000, message: "Owned thread unavailable" } }); return;
        }
        const result = r.method === "thread/start" || r.method === "thread/resume"
          ? { thread: { id: existing ?? "controlled-fresh-thread", status: { type: "idle" }, turns: [], ...threadOverrides } }
          : r.method === "turn/start" ? { turn: { id: "controlled-turn", status: "inProgress", items: [], error: null } } : {};
        emit({ id: r.id, result });
        if (r.method === "turn/start") {
          emit({ method: "turn/started", params: { threadId: existing ?? "controlled-fresh-thread", turn: { id: "controlled-turn", status: "inProgress" } } });
          emit({ method: "turn/completed", params: { threadId: existing ?? "controlled-fresh-thread", turn: { id: "controlled-turn", status: "completed", error: null, items: [] } } });
        }
      });
    }, flush() {}, end() {} },
  };
  const session = new CodexAppServerSession({ externalSessionId: existing, cwd: process.cwd(), timeout: 150,
    spawn: argv => { command = [...argv]; return proc; } });
  let error: unknown;
  try { await session.start(); await session.send("Controlled recovery input"); }
  catch (e) { error = e; }
  finally { session.kill(); await proc.exited; }
  return { requests, command, error, closed };
}

test("app-server pipe adapter selects stdio rather than an unread WebSocket listener", async () => {
  const { command } = await observe();
  expect(command.some(arg => arg.startsWith("ws://"))).toBe(false);
  const i = command.indexOf("--listen");
  if (i >= 0) expect(command[i + 1]).toBe("stdio://");
});

test("app-server turn input uses the installed typed input array", async () => {
  const { requests } = await observe();
  const input = requests.find(r => r.method === "turn/start")?.params?.input;
  expect(input).toMatchObject([{ type: "text", text: "Controlled recovery input" }]);
});

test("cold app-server binding resumes the same thread before admitting a turn", async () => {
  const { requests } = await observe("controlled-existing-thread");
  const resume = requests.findIndex(r => r.method === "thread/resume");
  const turn = requests.findIndex(r => r.method === "turn/start");
  expect(resume).toBeGreaterThanOrEqual(0);
  expect(turn).toBeGreaterThan(resume);
  expect(requests[resume]?.params?.threadId).toBe("controlled-existing-thread");
  expect(requests[turn]?.params?.threadId).toBe("controlled-existing-thread");
  expect(requests.filter(r => r.method === "thread/start")).toHaveLength(0);
});

test("failed app-server resume neither starts a fresh thread nor writes a turn", async () => {
  const { requests, error } = await observe("controlled-existing-thread", true);
  expect(requests.filter(r => r.method === "thread/resume")).toHaveLength(1);
  expect(requests.filter(r => ["thread/start", "turn/start"].includes(r.method))).toHaveLength(0);
  expect(String(error)).toContain("Owned thread unavailable");
});

test("control: fresh app-server wire initializes once and creates one thread with owned teardown", async () => {
  const { requests, closed } = await observe();
  expect(requests.slice(0, 3).map(r => r.method)).toEqual(["initialize", "initialized", "thread/start"]);
  expect(requests.filter(r => r.method === "thread/start")).toHaveLength(1);
  expect(requests.filter(r => r.method === "turn/start")).toHaveLength(1);
  expect(requests.filter(r => r.method === "thread/resume")).toHaveLength(0);
  expect(closed).toBe(true);
});

test("cold resume with absent runtime status cannot authorize a new turn", async () => {
  const { requests, error } = await observe("controlled-existing-thread", false, { status: undefined });
  expect(requests.filter(r => r.method === "thread/resume")).toHaveLength(1);
  expect(requests.filter(r => ["thread/start", "turn/start"].includes(r.method))).toHaveLength(0);
  expect(error).toBeDefined();
});

test("control: a resumed active thread cannot be steered by a fresh turn", async () => {
  const { requests, error } = await observe("controlled-existing-thread", false, { status: { type: "active", activeFlags: [] } });
  expect(requests.filter(r => r.method === "thread/resume")).toHaveLength(1);
  expect(requests.filter(r => ["thread/start", "turn/start"].includes(r.method))).toHaveLength(0);
  expect(error).toBeDefined();
});
