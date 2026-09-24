import { expect, test } from "bun:test";
import { ClaudeCodeSession } from "../../../../agent-session/src";
import limitTerminal from "../native/claude-limit-terminal.json";

async function runTerminal(raw: Record<string, unknown>) {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let finish!: (code: number) => void;
  const proc = {
    stdin: {
      write() { queueMicrotask(() => output.enqueue(new TextEncoder().encode(JSON.stringify(raw) + "\n"))); },
      flush() {}, end() {},
    },
    stdout: new ReadableStream<Uint8Array>({ start(controller) { output = controller; } }),
    stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
    exited: new Promise<number>(resolve => { finish = resolve; }),
    kill() { output.close(); finish(143); },
  };
  const session = new ClaudeCodeSession({ spawn: () => proc, timeout: 200 });
  await session.start();
  try {
    const result = await session.send("controlled terminal test").catch(error => ({ rejected: true, error }));
    return { result, attempt: session.attempts.at(-1) };
  } finally { session.kill(); await proc.exited; }
}

test("the retained real Claude limit terminal is native failed despite success subtype", async () => {
  const { attempt } = await runTerminal({ ...limitTerminal.event });
  expect(attempt?.nativeOutcome).toBe("failed");
});

for (const flag of [undefined, false]) {
  test(`an explicit API error cannot become completed when is_error is ${String(flag)}`, async () => {
    // A synthetic robustness variant of the observed envelope, not a new native capture.
    const raw: Record<string, unknown> = { ...limitTerminal.event };
    if (flag === undefined) delete raw.is_error;
    else raw.is_error = flag;
    const { attempt } = await runTerminal(raw);
    expect(attempt?.nativeOutcome).toBeDefined();
    expect(attempt?.nativeOutcome).not.toBe("completed");
  });
}

test("a returned result cannot mutate the session's retained terminal evidence", async () => {
  const { result, attempt } = await runTerminal({
    type: "result", subtype: "success", is_error: false, uuid: "controlled-terminal-1",
    session_id: "controlled-session", result: "ORIGINAL_OUTPUT",
  });
  expect(attempt?.nativeOutcome).toBe("completed");
  if ("rejected" in result) throw Error("Successful fixture was rejected");
  const terminal = result.events.find(event => event.kind === "result")!;
  // Readonly types do not protect the JavaScript/plugin boundary. Mutation may
  // be rejected or affect a detached copy, but must not rewrite retained evidence.
  try { (terminal as { text?: string }).text = "CHANGED_OUTPUT"; } catch {}
  try { (terminal.raw as Record<string, unknown>).result = "CHANGED_RAW"; } catch {}
  expect(attempt?.events.find(event => event.kind === "result")?.text).toBe("ORIGINAL_OUTPUT");
  expect((attempt?.events.find(event => event.kind === "result")?.raw as Record<string, unknown>).result).toBe("ORIGINAL_OUTPUT");
});
