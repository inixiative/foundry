import { expect, test } from "bun:test";
import { StreamBufferRegistry } from "../src/viewer/stream-buffer";
// @ts-expect-error Native browser JavaScript has no declaration file.
import { mergeLiveSnapshot, liveThreadStatus } from "../src/viewer/ui/live-state.js";
// @ts-expect-error Native browser JavaScript has no declaration file.
import { mergeMessageHistory } from "../src/viewer/ui/conversation-state.js";

test("durable observer answer outranks its earlier bounded watch projection", () => {
  const registry = new StreamBufferRegistry();
  const buffer = registry.open("turn-A", "thread-A", "project-A");
  buffer.append("EARLIER_RUNNING_PREVIEW");
  const active = { buffers: registry.forThread("thread-A") };
  const output = "FULL_DURABLE_START:" + "x".repeat(40_000) + ":FULL_DURABLE_END";
  const meta = { executionOutcome: "completed", turnStatus: "completed", persistence: "committed" };
  buffer.complete({ content: output, meta });
  const bounded = { buffers: registry.forThread("thread-A") };
  const watched = mergeLiveSnapshot([], bounded);
  expect(watched[0].terminalSource).toBe("watch");
  expect(watched[0].content.length).toBeLessThan(output.length);

  const durable = {
    id: "journal-message-A",
    actor: "agent",
    threadId: "thread-A",
    turnId: "turn-A",
    content: output,
    seq: 2,
    meta,
  };
  const recovered = mergeMessageHistory(watched, [durable]);
  expect(recovered[0].content).toBe(output);
  expect(mergeLiveSnapshot(recovered, bounded)[0].content).toBe(output);
  const stale = mergeLiveSnapshot(recovered, active);
  expect(stale[0].content).toBe(output);
  expect(stale[0].streaming).toBe(false);
  expect(liveThreadStatus(stale)).not.toBe("active");
});
