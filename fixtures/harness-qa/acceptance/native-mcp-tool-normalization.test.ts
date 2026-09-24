import { expect, test } from "bun:test";
import { CodexMcpSession } from "../../../../agent-session/src";

// Controlled notifications derived from the upstream protocol definitions, not
// a capture from the installed CLI. Actual wire verification remains required.
// https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs
// McpInvocation / McpToolCallBeginEvent / McpToolCallEndEvent use call_id,
// invocation {server, tool, arguments}, and Result<CallToolResult, String>.
async function run(mode: "success" | "tool-error" | "transport-error" | "shell") {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (code: number) => void;
  let closed = false, writes = 0;
  const emit = (value: unknown) => output.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n"));
  const invocation = { server: "foundry_controlled", tool: "foundry_memory", arguments: { id: "owned-fact" } };
  const proc = {
    stdout: new ReadableStream<Uint8Array>({ start(c) { output = c; } }),
    stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
    exited: new Promise<number>(r => { exit = r; }),
    kill() { if (!closed) { closed = true; output.close(); exit(143); } },
    stdin: { write(line: string) {
      const request = JSON.parse(line);
      if (["initialize", "tools/list"].includes(request.method)) {
        queueMicrotask(() => emit({ id: request.id, result: {} }));
      } else if (request.method === "tools/call") {
        writes++;
        queueMicrotask(() => {
          const event = (msg: unknown) => emit({ method: "codex/event", params: { id: "controlled-turn", msg } });
          event({ type: "task_started", turn_id: "controlled-turn" });
          if (mode === "shell") {
            event({ type: "exec_command_begin", call_id: "controlled-call", command: ["/bin/zsh", "-c", "bun --version"] });
            event({ type: "exec_command_end", call_id: "controlled-call", command: ["/bin/zsh", "-c", "bun --version"], aggregated_output: "CONTROLLED_PUBLIC_RESULT", exit_code: 0 });
          } else {
            event({ type: "mcp_tool_call_begin", call_id: "controlled-call", invocation });
            event({ type: "mcp_tool_call_end", call_id: "controlled-call", invocation, duration: { secs: 0, nanos: 1 },
              result: mode === "transport-error" ? { Err: "CONTROLLED_TOOL_TRANSPORT_ERROR" }
                : { Ok: { content: [{ type: "text", text: "CONTROLLED_PUBLIC_RESULT" }], isError: mode === "tool-error" } } });
          }
          event({ type: "task_complete", turn_id: "controlled-turn" });
          emit({ id: request.id, result: { structuredContent: { threadId: "controlled-session", content: "DONE" } } });
        });
      }
    }, flush() {}, end() {} },
  };
  const session = new CodexMcpSession({ spawn: () => proc, externalSessionId: "controlled-session", timeout: 1000 });
  try {
    await session.start();
    const result = await session.send("Controlled protocol test");
    expect(writes).toBe(1);
    expect(result.nativeOutcome).toBe("completed");
    return result.events;
  } finally { session.kill(); await proc.exited; }
}

test("MCP native notifications retain callable tool identity, arguments and joined public result", async () => {
  const events = await run("success");
  const starts = events.filter(e => e.kind === "tool_use");
  const ends = events.filter(e => e.kind === "tool_result");
  expect(starts).toHaveLength(1);
  expect(ends).toHaveLength(1);
  expect(starts[0].toolName).toContain("foundry_memory");
  expect(starts[0].toolInput).toEqual({ id: "owned-fact" });
  expect(starts[0].callId).toBe("controlled-call");
  expect(ends[0].callId).toBe(starts[0].callId);
  expect(ends[0].toolOutput).toContain("CONTROLLED_PUBLIC_RESULT");
  expect(ends[0].toolError).not.toBe(true);
});

for (const mode of ["tool-error", "transport-error"] as const) {
  test(`MCP ${mode} remains a tool failure despite a completed native turn`, async () => {
    const events = await run(mode);
    const ends = events.filter(e => e.kind === "tool_result");
    expect(ends).toHaveLength(1);
    expect(ends[0].callId).toBe("controlled-call");
    expect(ends[0].toolError).toBe(true);
  });
}

test("existing shell notification pair remains an independent positive control", async () => {
  const events = await run("shell");
  expect(events.filter(e => e.kind === "tool_use")).toHaveLength(1);
  const end = events.find(e => e.kind === "tool_result");
  expect(end?.callId).toBe("controlled-call");
  expect(end?.toolOutput).toBe("CONTROLLED_PUBLIC_RESULT");
  expect(end?.toolError).toBe(false);
});
