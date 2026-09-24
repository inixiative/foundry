import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRecoverySample, type RecoveryTestDependencies } from "../../../../scripts/native-foundry-sample";

const req = createRequire(new URL("../../package.json", import.meta.url));
const { Client } = await import(req.resolve("@modelcontextprotocol/sdk/client/index.js"));
const { StdioClientTransport } = await import(req.resolve("@modelcontextprotocol/sdk/client/stdio.js"));
type Mode = "success" | "module" | "browser" | "setup" | "registration" | "configuration" | "readiness" | "binding"
  | "native-failure" | "rpc-pending" | "leak" | "wrong-recall" | "history" | "cleanup" | "checkpoint" | "sql" | "spawn-refused" | "checkpoint-late" | "write-refused";

async function fixture(mode: Mode = "success", realBrowser = false) {
  const parent = await mkdtemp(join(realBrowser ? process.env.FOUNDRY_RECOVERY_EVIDENCE_PARENT ?? tmpdir() : tmpdir(), "foundry-recovery-offline-"));
  let processes = 0, writes = 0, exits = 0, nonce = "", releaseRPC: (() => void) | undefined;
  const requests: any[] = [], clients: InstanceType<typeof Client>[] = [], tasks: Promise<void>[] = [];
  const observers: string[] = [];
  let firstTerminal!: () => void;
  const terminal = new Promise<void>(r => firstTerminal = r);
  const browser = {
    async newPage() { return page(); }, async newContext() { return { newPage: async () => page(), close: async () => {} }; },
    async close() { if (mode === "cleanup") throw Error("CONTROLLED_BROWSER_CLEANUP_FAILURE"); },
  };
  const page = (): any => ({
    async goto(url: string) { observers.push(url); }, setViewportSize: async () => {}, screenshot: async () => {},
    locator(selector: string) { return { filter: () => this.locator(selector), locator: (s: string) => this.locator(s),
      waitFor: async () => { if (mode === "history") throw Error("CONTROLLED_HISTORY_MISSING"); }, isVisible: async () => false, click: async () => {}, scrollIntoViewIfNeeded: async () => {} }; },
  });
  const dependencies: RecoveryTestDependencies = {
    parent, observationMs: mode === "rpc-pending" ? 1200 : 10000, cleanupMs: 2000,
    async preflight() { if (mode === "module") throw Error("MODULE_MISSING"); return { sourceOnly: true, modelCalls: 0 }; },
    async browser() { if (mode === "browser") throw Error("BROWSER_MISSING");
      return realBrowser ? createRequire(import.meta.url)(process.env.FOUNDRY_QA_PLAYWRIGHT!).chromium.launch({ channel: "chrome", headless: true }) : browser; },
    async setup({ provider, viewer, bindings, nonce: actualNonce }) {
      nonce = actualNonce;
      if (mode === "setup") throw Error("PARTIAL_SETUP_FAILURE");
      if (mode === "registration") viewer.localStore!.registerNative = () => { throw Error("REGISTRATION_FAILURE"); };
      if (mode === "binding") bindings.save = async () => { throw Error("BINDING_FAILURE"); };
      if (mode === "sql") (viewer.localStore as any).db.exec("CREATE TEMP TRIGGER reject_recovery_trace BEFORE INSERT ON session_traces BEGIN SELECT RAISE(ABORT, 'CONTROLLED_COMMIT_FAILURE'); END");
      if (mode === "leak") {
        const complete = provider.complete.bind(provider);
        provider.complete = (messages, opts) => complete(writes === 1 ? [...messages, { role: "user", content: nonce }] : messages, opts);
      }
    },
    spawn() {
      if (mode === "spawn-refused") throw Error("CONTROLLED_SPAWN_REFUSAL");
      processes++; const processIndex = processes;
      let out!: ReadableStreamDefaultController<Uint8Array>, exit!: (n: number) => void, closed = false;
      let client: InstanceType<typeof Client>, ready: Promise<void> = Promise.resolve(), server = "";
      const exited = new Promise<number>(r => exit = r);
      const emit = (v: unknown) => { if (!closed) out.enqueue(new TextEncoder().encode(JSON.stringify(v) + "\n")); };
      return { stdout: new ReadableStream({ start(c) { out = c; } }), stderr: new ReadableStream({ start(c) { c.close(); } }), exited,
        kill() { if (!closed) { closed = true; exits++; out.close(); exit(143); } },
        stdin: { write(data: string) {
          const v = JSON.parse(data); requests.push(v);
          if (v.method === "initialize") queueMicrotask(() => emit({ id: v.id, result: { userAgent: "codex/0.153.4", platformFamily: "unix", platformOs: "macos", codexHome: "/controlled-native-home" } }));
          if (["thread/start", "thread/resume"].includes(v.method)) {
            const key = Object.keys(v.params.config).find(k => k.startsWith("mcp_servers.foundry_"))!;
            server = key.slice("mcp_servers.".length);
            const launch = v.params.config[key];
            // This is the actual descriptor delivered by the production adapter,
            // not a bridge created or manually configured by the test.
            client = new Client({ name: "controlled-recovery-native", version: "1" }); clients.push(client);
            ready = client.connect(new StdioClientTransport({ command: launch.command, args: launch.args, stderr: "pipe" }));
            tasks.push(ready); void ready.catch(() => {}); // setup refusal may close this owned handshake
            const thread = { id: "retained-native-thread", sessionId: "retained-native-tree", status: { type: "idle" }, turns: processIndex === 2 ? [{ id: "native-turn-1", status: "completed", items: [] }] : [] };
            queueMicrotask(() => emit({ id: v.id, result: { thread, model: mode === "configuration" ? undefined : "gpt-6-astra", modelProvider: "openai", cwd: v.params.cwd,
              approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" }, reasoningEffort: "xhigh" } }));
          }
          if (v.method === "mcpServerStatus/list") {
            const task = (async () => { await ready; const list = await client.listTools(); emit({ id: v.id, result: { data: mode === "readiness" ? [] : [{ name: server, runtimeStatus: "connected", tools: Object.fromEntries(list.tools.map((t: {name: string}) => [t.name, t])), resources: [], resourceTemplates: [], authStatus: "unsupported" }] } }); })();
            tasks.push(task); void task.catch(() => {});
          }
          if (v.method === "turn/start") {
            if (mode === "write-refused") { closed = true; exits++; out.close(); exit(1); throw Error("CONTROLLED_PIPE_WRITE_REFUSED"); }
            writes++; const index = writes, turnId = `native-turn-${index}`;
            const task = (async () => {
              await ready;
              const reply = () => emit({ id: v.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
              if (mode === "rpc-pending") releaseRPC = reply; else reply();
              const notify = (method: string, rest: object) => emit({ method, params: { threadId: "retained-native-thread", turnId, ...rest } });
              notify("turn/started", { turn: { id: turnId, status: "inProgress", items: [] } });
              const item = { id: `native-item-${index}`, type: "mcpToolCall", server, tool: "foundry_memory", arguments: { id: `recall-${index}` }, status: "inProgress" };
              notify("item/started", { item });
              const result = await client.callTool({ name: item.tool, arguments: item.arguments });
              notify("item/completed", { item: { ...item, status: "completed", result: { content: result.content } } });
              // Synthetic reasoning never belongs in the runner's public artifact.
              notify("item/completed", { item: { id: "hidden", type: "reasoning", summary: ["SYNTHETIC_REASONING_MUST_NOT_PERSIST"] } });
              const answer = index === 1 ? "RECOVERY_FIRST_FACT\nRECOVERY_1_DONE" : `RECALL:${mode === "wrong-recall" ? "WRONG" : nonce}\nRECOVERY_SECOND_FACT\nRECOVERY_2_DONE`;
              notify("item/agentMessage/delta", { itemId: `answer-${index}`, delta: answer });
              notify("item/completed", { item: { id: `answer-${index}`, type: "agentMessage", text: answer } });
              notify("turn/completed", { turn: { id: turnId, status: mode === "native-failure" ? "failed" : "completed", items: [] } });
              firstTerminal();
            })(); tasks.push(task); void task.catch(() => {});
          }
        }, flush() {}, end() {} } };
    },
  };
  let checkpoints = 0;
  if (mode === "checkpoint" || mode === "checkpoint-late") (dependencies as { beforeCheckpoint?: () => void }).beforeCheckpoint = () => { if (++checkpoints === (mode === "checkpoint" ? 2 : 3)) throw Error("CHECKPOINT_WRITE_FAILURE"); };
  const run = () => runRecoverySample("app-server", "r1-controlled", "unused-offline-manifest", dependencies);
  return { parent, run, requests, terminal, releaseRPC: () => releaseRPC?.(), counts: () => ({ processes, writes, exits }), observers,
    report: async () => JSON.parse(await readFile(join(parent, "r1-controlled/report.json"), "utf8")),
    async close() { await Promise.allSettled(tasks); for (const client of clients) await client.close(); if (!realBrowser) await rm(parent, { recursive: true, force: true }); } };
}

test("recovery capture: production runtime/installed-class seam/SDK proxy cold resume, immutable history and nonce omission", async () => {
  const f = await fixture(); try {
    const result = await f.run(); const report = await f.report();
    expect(report.failures).toEqual([]); expect(result.passed).toBe(true); expect(f.counts()).toEqual({ processes: 2, writes: 2, exits: 2 });
    expect(f.requests.filter(r => r.method === "thread/start")).toHaveLength(1);
    expect(f.requests.filter(r => r.method === "thread/resume")[0].params.threadId).toBe("retained-native-thread");
    expect(report.processes[0].requests[0].bridgeName).not.toBe(report.processes[1].requests[0].bridgeName);
    expect(report.turns.every((t: any) => t.continuity.valid && t.readiness && t.capacity === "settled")).toBe(true);
    expect(report.browser).toHaveLength(8); expect(report.frozenHistory).toBe(true);
    const artifact = await readFile(join(result.run, "turn-2.json"), "utf8");
    expect(artifact).not.toContain("SYNTHETIC_REASONING_MUST_NOT_PERSIST"); expect(artifact).not.toContain("protectedLaunch");
    const parsed = JSON.parse(artifact); expect(parsed.events.some((e: any) => e.kind === "tool_result" && e.itemId && !e.callId)).toBe(true);
    const before = await readFile(result.report, "utf8"); await expect(f.run()).rejects.toThrow(); expect(await readFile(result.report, "utf8")).toBe(before);
  } finally { await f.close(); }
}, 20000);

for (const mode of ["module", "browser", "setup", "checkpoint", "spawn-refused"] as const) test(`recovery ${mode} failure retains a report with zero model processes/writes`, async () => {
  const f = await fixture(mode); try { expect((await f.run()).passed).toBe(false); expect(f.counts()).toEqual({ processes: 0, writes: 0, exits: 0 }); expect((await f.report()).finishedAt).toBeTruthy(); } finally { await f.close(); }
});
for (const mode of ["registration", "configuration", "readiness", "binding"] as const) test(`recovery ${mode} refusal cannot write native work or start a second process`, async () => {
  const f = await fixture(mode); try { expect((await f.run()).passed).toBe(false); expect(f.counts().writes).toBe(0); expect(f.counts().processes).toBeLessThanOrEqual(1); expect((await f.report()).finishedAt).toBeTruthy(); } finally { await f.close(); }
}, 15000);
for (const mode of ["native-failure", "leak", "wrong-recall", "history", "cleanup", "checkpoint-late"] as const) test(`recovery ${mode} stays failed; no replay or third admission`, async () => {
  const f = await fixture(mode); try { expect((await f.run()).passed).toBe(false); expect(f.counts().writes).toBeLessThanOrEqual(mode === "wrong-recall" || mode === "cleanup" ? 2 : 1); expect(f.counts().processes).toBeLessThanOrEqual(2); const r = await f.report(); expect(r.finishedAt).toBeTruthy(); expect(r.failures.length + r.cleanupFailures.length).toBeGreaterThan(0); } finally { await f.close(); }
}, 15000);
test("real SQL rejection preserves completed native output and failure artifact; no cold replay", async () => {
  const f = await fixture("sql"); try {
    const result = await f.run(), report = await f.report(); expect(result.passed).toBe(false);
    expect(f.counts()).toEqual({ processes: 1, writes: 1, exits: 1 }); expect(report.turns[0].persistence).toBe("failed");
    const artifact = JSON.parse(await readFile(join(result.run, "turn-1.json"), "utf8"));
    expect(artifact.native.nativeOutcome).toBe("completed"); expect(artifact.output).toContain("RECOVERY_1_DONE");
  } finally { await f.close(); }
});
test("a failed pipe write is an attempted admission, not returned delivery or native completion", async () => {
  const f = await fixture("write-refused"); try {
    expect((await f.run()).passed).toBe(false); const r = await f.report();
    expect(f.counts()).toEqual({ processes: 1, writes: 0, exits: 1 }); expect(r.gate.admissions).toBe(1);
    expect(r.processes[0].workWriteAttemptedAt).toBeTruthy(); expect(r.processes[0].workWriteReturnedAt).toBeUndefined();
    expect(r.gate.verified).toBe(0); expect(r.processes[0].release).not.toBe("released");
  } finally { await f.close(); }
});
test("native completion with pending RPC stays owned after expiry; a late reply permits cleanup only", async () => {
  const f = await fixture("rpc-pending"); try {
    const running = f.run(); await f.terminal; await Bun.sleep(1300);
    expect(f.counts()).toEqual({ processes: 1, writes: 1, exits: 0 });
    const pending = await f.report(); expect(pending.gate.closed).toBe(true); expect(pending.finishedAt).toBeUndefined();
    f.releaseRPC(); const result = await running; expect(result.passed).toBe(false); expect(f.counts()).toEqual({ processes: 1, writes: 1, exits: 1 });
  } finally { f.releaseRPC(); await f.close(); }
}, 20000);

test.skipIf(!process.env.FOUNDRY_QA_PLAYWRIGHT)("real headless desktop/mobile observers: actual production composer history and native item/SDK inspection after cold reconstruction", async () => {
  const f = await fixture("success", true); try {
    const result = await f.run(); console.log(`Recovery browser evidence: ${result.report}`);
    const report = await f.report(); expect(report.failures).toEqual([]); expect(result.passed).toBe(true);
    expect(report.browser).toHaveLength(8); expect(f.counts()).toEqual({ processes: 2, writes: 2, exits: 2 });
  } finally { await f.close(); }
}, 30000);
