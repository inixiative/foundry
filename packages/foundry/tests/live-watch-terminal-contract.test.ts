import { expect, test } from "bun:test";
import { StreamBufferRegistry } from "../src/viewer/stream-buffer";
// Exercise the browser's actual projection and sender terminal conversion.
// @ts-expect-error Native browser JavaScript has no declaration file.
import { mergeLiveSnapshot, liveThreadStatus } from "../src/viewer/ui/live-state.js";
// @ts-expect-error Native browser JavaScript has no declaration file.
import { terminalMessagePatch } from "../src/viewer/ui/conversation-state.js";

function runningSnapshot() {
  const registry = new StreamBufferRegistry();
  const buffer = registry.open("owned-turn", "thread-A", "project-A");
  buffer.append("EARLIER_RUNNING_PREVIEW");
  return {
    buffer,
    snapshot: { buffers: registry.forThread("thread-A") },
    current: () => ({ buffers: registry.forThread("thread-A") }),
  };
}

test("stale active snapshot cannot revive or truncate the sender's unsaved completed answer", () => {
  const fixture = runningSnapshot();
  const output = "OWNED_FULL_OUTPUT_START:" + "x".repeat(40_000) + ":OWNED_FULL_OUTPUT_END";
  const event = {
    type: "done",
    id: "owned-turn",
    output,
    content: output,
    meta: {
      turnStatus: "failed",
      executionOutcome: "completed",
      persistence: "failed",
      injection: { providerMessages: [{ role: "user", content: "OWNED_INPUT" }] },
    },
    traceSnapshot: { original: "OWNED_TRACE" },
  };
  const full = {
    actor: "agent",
    threadId: "thread-A",
    turnId: "owned-turn",
    ...terminalMessagePatch(event),
  };

  // This is the production store's order: the SSE terminal is applied before
  // its latest already-cached watch snapshot is merged by _persistLocal.
  const afterStale = mergeLiveSnapshot([full], fixture.snapshot);
  expect(afterStale).toHaveLength(1);
  expect(afterStale[0].content).toBe(output);
  expect(afterStale[0].streaming).toBe(false);
  expect(afterStale[0].meta.injection).toEqual(event.meta.injection);
  expect(afterStale[0].traceSnapshot).toEqual(event.traceSnapshot);
  expect(liveThreadStatus(afterStale)).not.toBe("active");

  // The later watch response is deliberately bounded; it cannot substitute
  // for the full terminal evidence that this sending browser already received.
  fixture.buffer.complete(event);
  const afterGrace = mergeLiveSnapshot(afterStale, fixture.current());
  expect(afterGrace[0].content).toBe(output);
  expect(afterGrace[0].output).toBe(output);
  expect(afterGrace[0].streaming).toBe(false);
  expect(afterGrace[0].meta.persistence).toBe("failed");
});

test("stale active snapshot cannot erase a sender's terminal failure presentation", () => {
  const fixture = runningSnapshot();
  const event = {
    type: "error",
    id: "owned-turn",
    error: "ORIGINAL_OWNED_FAILURE",
    meta: {
      turnStatus: "failed",
      executionOutcome: "failed",
      persistence: "failed",
      nativeOutcome: "failed",
      browserFailureEvidence: { partialOutput: "OWNED_PARTIAL" },
    },
  };
  const full = {
    actor: "agent",
    threadId: "thread-A",
    turnId: "owned-turn",
    ...terminalMessagePatch(event),
  };
  const merged = mergeLiveSnapshot([full], fixture.snapshot);
  expect(merged[0].content).toBe(event.error);
  expect(merged[0].streaming).toBe(false);
  expect(merged[0].error).toBe(true);
  expect(merged[0].meta.browserFailureEvidence).toEqual(event.meta.browserFailureEvidence);
  expect(liveThreadStatus(merged)).not.toBe("active");
});
