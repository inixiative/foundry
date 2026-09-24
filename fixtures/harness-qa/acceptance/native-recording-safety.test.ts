import { expect, test } from "bun:test";
import { FrameRecorder, Sanitizer } from "../../../../agent-session/scripts/s0/sanitize";

test("native recorder does not persist untyped numeric payloads under content arrays", () => {
  const cleaned = new Sanitizer().clean({ type: "assistant", content: [987654321], usage: { input_tokens: 7 } });
  expect(JSON.stringify(cleaned)).not.toContain("987654321");
  expect((cleaned as any).usage.input_tokens).toBe(7);
});

test("analysis phase is omitted even when its envelope lacks a type discriminator", () => {
  const cleaned = new Sanitizer().clean({ role: "assistant", phase: "analysis", content: "S0_SENTINEL_OK private analysis" });
  expect(JSON.stringify(cleaned)).not.toContain("S0_SENTINEL_OK");
  expect(JSON.stringify(cleaned)).toContain("reasoning");
});

test("frame provenance begins in the actual chunk after an exact newline boundary", () => {
  const recorder = new FrameRecorder(new Sanitizer());
  const bytes = new TextEncoder();
  recorder.chunk(bytes.encode('{"type":"system","subtype":"init"}\n'));
  recorder.chunk(bytes.encode('{"type":"result","subtype":"success","is_error":false}\n'));
  recorder.end();
  expect(recorder.frames).toHaveLength(2);
  expect(recorder.frames[0]).toMatchObject({ firstChunk: 0, lastChunk: 0 });
  expect(recorder.frames[1]).toMatchObject({ firstChunk: 1, lastChunk: 1 });
});
