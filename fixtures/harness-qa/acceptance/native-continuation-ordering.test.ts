import { expect, test } from "bun:test";
import { ContinuationCapture } from "../../../../agent-session/scripts/s0/continuation";
import { CONTINUATION_TASKS } from "../../../../agent-session/scripts/s0/continuation-plan";

// Controlled MCP transport through the actual recorder and sibling engine.
// No CLI, credentials, native model or workspace content is used.
function fixture(terminalDelay: number | null, deadline = 300) {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let finish!: (code: number) => void;
  let closed = false;
  let sends = 0;
  let kills = 0;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const emit = (value: unknown) => { if (!closed) output.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n")); };
  const event = (msg: Record<string, unknown>) => emit({ jsonrpc: "2.0", method: "codex/event", params: { id: msg.turn_id, msg } });
  const exit = () => {
    if (closed) return;
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    output.close(); finish(0);
  };
  const proc = {
    stdin: { write(data: string) {
      const request = JSON.parse(data);
      if (["initialize", "tools/list"].includes(request.method)) {
        queueMicrotask(() => emit({ jsonrpc: "2.0", id: request.id, result: {} }));
        return;
      }
      if (request.method !== "tools/call") return;
      const index = sends++;
      const task = CONTINUATION_TASKS[index];
      const turn_id = `controlled-turn-${index}`;
      queueMicrotask(() => {
        event({ type: "session_configured", thread_id: "controlled-binding", model: "gpt-6-astra" });
        event({ type: "task_started", turn_id });
        event({ type: "exec_command_begin", turn_id, call_id: `controlled-call-${index}`,
          command: ["/bin/zsh", "-lc", `bun --version && cat ${task.file}`] });
        event({ type: "exec_command_end", turn_id, call_id: `controlled-call-${index}`, exit_code: 0,
          stdout: `1.3.14\n${task.content}` });
        emit({ jsonrpc: "2.0", id: request.id,
          result: { structuredContent: { threadId: "controlled-binding", content: task.marker } } });
        if (terminalDelay !== null) timers.push(setTimeout(() => event({ type: "task_complete", turn_id }), terminalDelay));
      });
    }, flush() {}, end() {} },
    stdout: new ReadableStream<Uint8Array>({ start(c) { output = c; } }),
    stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
    exited: new Promise<number>(resolve => { finish = resolve; }),
    kill() { kills++; exit(); },
  };
  const capture = new ContinuationCapture("codex-mcp", {
    cwd: "controlled-sample", spawn: () => proc, startDeadlineMs: 100, sendDeadlineMs: deadline, settleMs: 50,
  });
  return { capture, exit,
    terminal() { event({ type: "task_complete", turn_id: `controlled-turn-${sends - 1}` }); },
    get sends() { return sends; }, get kills() { return kills; } };
}

test("native completion after the settle interval but inside the deadline permits exactly two verified admissions", async () => {
  const f = fixture(90);
  try {
    const report = await f.capture.run();
    expect(report.stop).toBe("complete");
    expect(report.admittedSends).toBe(2);
    expect(report.observedTurnWrites).toBe(2);
    expect(report.turns.every(turn => turn.verified)).toBe(true);
    expect(report.turns.every(turn => (turn.attempt as { nativeOutcome?: string }).nativeOutcome === "completed")).toBe(true);
    expect(await f.capture.closeOwned()).toBe(true);
  } finally { f.exit(); await f.capture.closeOwned(); }
});

test("RPC-only completion waits the admission deadline without dispatching task two or claiming cancellation", async () => {
  const f = fixture(null, 140);
  const started = performance.now();
  try {
    const report = await f.capture.run();
    expect(performance.now() - started).toBeGreaterThanOrEqual(120);
    expect(report.stop).not.toBe("complete");
    expect(report.nativeOutcome).toBe("unknown");
    expect(f.sends).toBe(1);
    expect(await f.capture.closeOwned()).toBe(false);
    expect(f.kills).toBe(0);
  } finally { f.exit(); await f.capture.closeOwned(); }
});

test("a terminal arriving between deadline observation and final verification cannot reopen admission", async () => {
  const f = fixture(null, 40);
  // Fault-inject only timing: deliver a genuine controlled transport frame just
  // after the recorder reports deadline. Do not edit engine evidence or outcomes.
  const boundary = f.capture as unknown as { awaitOwnedOutcome(turn: unknown): Promise<string> };
  const wait = boundary.awaitOwnedOutcome.bind(f.capture);
  boundary.awaitOwnedOutcome = async turn => {
    const outcome = await wait(turn);
    if (outcome === "deadline") f.terminal();
    return outcome;
  };
  try {
    const report = await f.capture.run();
    expect(f.sends).toBe(1);
    expect(report.stop).not.toBe("complete");
    expect(report.turns[0].nativeWait).toBe("deadline");
    await f.capture.waitForCleanup();
    expect(f.capture.snapshot().nativeOutcome).toBe("completed");
    expect(await f.capture.closeOwned()).toBe(true);
  } finally { f.exit(); await f.capture.closeOwned(); }
});
