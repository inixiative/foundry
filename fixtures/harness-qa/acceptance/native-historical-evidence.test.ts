import { expect, test } from "bun:test";
import { ClaudeCodeSession, CodexMcpSession } from "../../../../agent-session/src";

// Controlled stream envelopes test production ownership, not native capability.
function fixture(engine: "claude" | "mcp") {
  const writes: Array<Record<string, any>> = [];
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let finish!: (code: number) => void;
  let closed = false;
  const emit = (value: unknown) => output.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n"));
  const stop = (code: number) => { if (!closed) { closed = true; output.close(); finish(code); } };
  const proc = {
    stdin: { write(data: string) {
      const value = JSON.parse(data); writes.push(value);
      if (["initialize", "tools/list"].includes(value.method)) {
        queueMicrotask(() => emit({ jsonrpc: "2.0", id: value.id, result: {} }));
      }
    }, flush() {}, end() {} },
    stdout: new ReadableStream<Uint8Array>({ start(controller) { output = controller; } }),
    stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
    exited: new Promise<number>(resolve => { finish = resolve; }),
    kill() { stop(143); },
  };
  const Session = engine === "claude" ? ClaudeCodeSession : CodexMcpSession;
  const session = new Session({ externalSessionId: "controlled-session", spawn: () => proc, timeout: 1000 });
  const complete = () => {
    if (engine === "claude") {
      emit({ type: "result", uuid: "controlled-result", session_id: "controlled-session",
        subtype: "success", is_error: false, result: "COMPLETED_EVIDENCE_21" });
    } else {
      for (const type of ["task_started", "task_complete"]) {
        emit({ jsonrpc: "2.0", method: "codex/event", params: {
          id: "controlled-turn", msg: { type, turn_id: "controlled-turn" },
        } });
      }
      const call = writes.findLast(value => value.method === "tools/call")!;
      emit({ jsonrpc: "2.0", id: call.id, result: { structuredContent: {
        threadId: "controlled-session", content: "COMPLETED_EVIDENCE_21",
      } } });
    }
  };
  return { session, proc, emit, complete, closeTransport() { stop(1); } };
}

for (const engine of ["claude", "mcp"] as const) {
  test(`${engine}: later idle transport failure does not relabel a fully completed admission`, async () => {
    const f = fixture(engine);
    try {
      await f.session.start();
      const pending = f.session.send("Complete this controlled turn.");
      f.complete();
      const result = await pending;
      expect(result.nativeOutcome).toBe("completed");
      const before = f.session.attempts[0];
      expect(before.localOutcome).toBe("resolved");
      f.closeTransport();
      await f.proc.exited;
      await Bun.sleep(10);
      const after = f.session.attempts[0];
      expect(after.admissionId).toBe(before.admissionId);
      expect(after.nativeOutcome).toBe("completed");
      expect(after.transportOutcome).toBe(before.transportOutcome);
    } finally { f.session.kill(); await f.proc.exited; }
  });
}

test("Claude retains unowned startup evidence without attributing it to the next admission", async () => {
  const f = fixture("claude");
  try {
    await f.session.start();
    f.emit({ type: "system", subtype: "init", session_id: "controlled-session",
      model: "controlled-model", tools: ["controlled-tool"] });
    await Bun.sleep(10);
    const startup = f.session.events.find(event => (event.raw as any)?.subtype === "init");
    expect(startup).toBeDefined();
    expect(startup?.admissionId).toBeUndefined();
    const pending = f.session.send("A later controlled admission.");
    f.complete();
    const result = await pending;
    expect(result.events.some(event => (event.raw as any)?.subtype === "init")).toBe(false);
    expect(f.session.artifact().events.some(event => (event.raw as any)?.subtype === "init")).toBe(true);
  } finally { f.session.kill(); await f.proc.exited; }
});
