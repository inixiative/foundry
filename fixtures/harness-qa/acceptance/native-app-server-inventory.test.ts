import { expect, test } from "bun:test";
import { CodexAppServerSession } from "../../../../agent-session/src";

const owned = { name: "owned", runtimeStatus: "connected", tools: {
  foundry_query: { name: "foundry_query", inputSchema: { type: "object" } },
  foundry_memory: { name: "foundry_memory", inputSchema: { type: "object" } },
}, resources: [], resourceTemplates: [], authStatus: "unsupported" };

// Public class with controlled pipes only; no CLI process or model call.
async function inventory(pages: unknown[]) {
  const requests: Array<{ id?: number; method: string; params?: any }> = [];
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (code: number) => void, closed = false, page = 0;
  const emit = (value: unknown) => output.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n"));
  const proc = {
    stdout: new ReadableStream<Uint8Array>({ start(c) { output = c; } }),
    stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
    exited: new Promise<number>(resolve => { exit = resolve; }),
    kill() { if (!closed) { closed = true; output.close(); exit(0); } },
    stdin: { write(line: string) {
      const request = JSON.parse(line); requests.push(request);
      if (request.id === undefined) return;
      queueMicrotask(() => {
        if (closed) return;
        let result: unknown = {};
        if (request.method === "initialize") result = { userAgent: "controlled", platformFamily: "unix", platformOs: "macos", codexHome: "/controlled/codex" };
        if (request.method === "thread/resume") result = {
          thread: { id: "retained", status: { type: "idle" }, turns: [] },
          model: "gpt-6-astra", modelProvider: "openai", cwd: process.cwd(),
          approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" },
        };
        if (request.method === "mcpServerStatus/list") result = pages[page++] ?? { data: [], nextCursor: null };
        if (request.method === "turn/start") result = { turn: { id: "turn-owned", status: "inProgress", items: [] } };
        emit({ id: request.id, result });
        if (request.method === "turn/start") emit({ method: "turn/completed", params: {
          threadId: "retained", turn: { id: "turn-owned", status: "completed", items: [], error: null },
        } });
      });
    }, flush() {}, end() {} },
  };
  const session = new CodexAppServerSession({ cwd: process.cwd(), model: "gpt-6-astra",
    externalSessionId: "retained", timeout: 250, spawn: () => proc,
    appServer: { requireConfiguration: true, requiredMcpServer: { name: "owned", tools: ["foundry_query", "foundry_memory"] } },
  });
  let error: unknown;
  try { await session.start(); await session.send("Controlled readiness check"); }
  catch (caught) { error = caught; }
  finally { session.kill(); await proc.exited; }
  return { error, requests };
}

test("owned inventory can appear on a later page before the only turn write", async () => {
  const result = await inventory([{ data: [{ ...owned, name: "unrelated" }], nextCursor: "page-2" }, { data: [owned], nextCursor: null }]);
  expect(result.error).toBeUndefined();
  const reads = result.requests.filter(r => r.method === "mcpServerStatus/list");
  expect(reads).toHaveLength(2);
  expect(reads.map(r => r.params.threadId)).toEqual(["retained", "retained"]);
  expect(reads[1].params.cursor).toBe("page-2");
  expect(result.requests.filter(r => r.method === "turn/start")).toHaveLength(1);
});

const failures = [
  { name: "duplicate owned server across pages", pages: [{ data: [owned], nextCursor: "next" }, { data: [owned], nextCursor: null }] },
  { name: "repeated pagination cursor", pages: [{ data: [], nextCursor: "same" }, { data: [owned], nextCursor: "same" }] },
  { name: "malformed pagination cursor", pages: [{ data: [owned], nextCursor: 42 }] },
  { name: "missing second required tool", pages: [{ data: [{ ...owned, tools: { foundry_memory: owned.tools.foundry_memory } }], nextCursor: null }] },
  { name: "tool map key with a different declared tool name", pages: [{ data: [{ ...owned, tools: { ...owned.tools, foundry_memory: { name: "foreign" } } }], nextCursor: null }] },
];
for (const scenario of failures) test(`inventory refuses ${scenario.name} without a turn write`, async () => {
  const result = await inventory(scenario.pages);
  expect(result.error).toBeInstanceOf(Error);
  expect(result.requests.filter(r => r.method === "turn/start")).toHaveLength(0);
  expect(result.requests.filter(r => r.method === "thread/start")).toHaveLength(0);
  expect(result.requests.filter(r => r.method === "thread/resume")).toHaveLength(1);
});
