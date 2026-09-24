import { expect, test } from "bun:test";
import { ClaudeCodeSession } from "../../../../agent-session/src";
import { projectNative } from "../../../packages/foundry/src/providers/native-evidence";

const tool = "mcp__foundry_controlled__foundry_memory";

// Synthetic documented public result blocks, not a claim about the old capture.
async function run(content: unknown) {
  let out!: ReadableStreamDefaultController<Uint8Array>, exit!: (code: number) => void;
  let closed = false, writes = 0;
  const emit = (v: unknown) => out.enqueue(new TextEncoder().encode(JSON.stringify(v) + "\n"));
  const proc = {
    stdout: new ReadableStream<Uint8Array>({ start(c) { out = c; } }),
    stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
    exited: new Promise<number>(resolve => { exit = resolve; }),
    kill() { if (!closed) { closed = true; out.close(); exit(143); } },
    stdin: { write(line: string) {
      if (JSON.parse(line).type !== "user") return;
      writes++;
      queueMicrotask(() => {
        emit({ type: "assistant", session_id: "reference-owner", message: { content: [
          { type: "tool_use", id: "discovery-call", name: "ToolSearch", input: { query: `select:${tool}` } },
        ] } });
        emit({ type: "user", session_id: "reference-owner", message: { content: [
          { type: "tool_result", tool_use_id: "discovery-call", content, is_error: false },
        ] } });
        emit({ type: "result", session_id: "reference-owner", uuid: "reference-turn", subtype: "success", is_error: false, result: "DONE" });
      });
    }, flush() {}, end() {} },
  };
  const session = new ClaudeCodeSession({ externalSessionId: "reference-owner", timeout: 1000, spawn: () => proc });
  try {
    await session.start(); const result = await session.send("Controlled discovery");
    expect(result.nativeOutcome).toBe("completed"); expect(writes).toBe(1);
    const end = result.events.find(e => e.kind === "tool_result");
    expect(end?.callId).toBe("discovery-call"); return end!;
  } finally { session.kill(); await proc.exited; }
}

test("Claude normalizer retains exact public tool references from a tool result", async () => {
  const event = await run([{ type: "tool_reference", tool_name: tool }]);
  expect(event).toMatchObject({ toolReferences: [tool], toolError: false });
});

test("provider projection retains detached public references without forwarding raw payload", () => {
  const references = [tool];
  const projected = projectNative({ kind: "tool_result", callId: "discovery-call", toolOutput: "", toolError: false,
    toolReferences: references, raw: { credentials: "PRIVATE_REFERENCE_PAYLOAD" } });
  references.push("foreign-tool");
  expect(projected).toMatchObject({ toolReferences: [tool] });
  expect(JSON.stringify(projected)).not.toContain("PRIVATE_REFERENCE_PAYLOAD");
  expect(JSON.stringify(projected)).not.toContain("foreign-tool");
});

test("unknown non-text result is explicitly omitted rather than indistinguishable from empty output", async () => {
  const event = await run([{ type: "image", data: "PRIVATE_IMAGE_BYTES" }]);
  const projected = projectNative(event);
  expect(projected.toolOutputOmitted).toBe(true);
  expect(JSON.stringify(projected)).not.toContain("PRIVATE_IMAGE_BYTES");
});

test("control: ordinary text results remain verbatim public output", async () => {
  const projected = projectNative(await run([{ type: "text", text: "CONTROLLED_PUBLIC_TEXT" }]));
  expect(projected.toolOutput).toBe("CONTROLLED_PUBLIC_TEXT");
  expect(projected.toolError).toBe(false);
});
