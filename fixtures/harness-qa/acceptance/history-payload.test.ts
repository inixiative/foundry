import { expect, test } from "bun:test";
import { historyPayloadMetrics } from "../../../scripts/measure-history-payload";

test("history metrics count metadata without retaining message or tool content", () => {
  const payload = { messages: [{ content: "PRIVATE_MESSAGE", meta: { injection: "PRIVATE_CONTEXT" } }],
    nativeTools: [{ result: "PRIVATE_TOOL" }] };
  const metrics = historyPayloadMetrics(payload);
  expect(metrics.messages).toBe(1);
  expect(metrics.serializedRowsBytes).toBe(Buffer.byteLength(JSON.stringify(payload.messages)));
  expect(metrics.fieldValueBytes.meta).toBe(Buffer.byteLength(JSON.stringify(payload.messages[0].meta)));
  expect(metrics.nativeToolRecords).toBe(1);
  expect(JSON.stringify(metrics)).not.toContain("PRIVATE_");
});

test("history metrics preserve unknown tool evidence and distinguish an empty history", () => {
  const metrics = historyPayloadMetrics({ messages: [], hasMore: false });
  expect(metrics.messages).toBe(0);
  expect(metrics.maxRowBytes).toBeNull();
  expect(metrics.nativeToolRecords).toBeNull();
  expect(metrics.nativeToolsBytes).toBeNull();
  expect(metrics.paginationAdvertised).toBe(true);
});

test("history metrics refuse malformed data rather than reporting an empty success", () => {
  for (const invalid of [{ error: "unavailable" }, { messages: [null] }, { messages: [], nativeTools: {} }])
    expect(() => historyPayloadMetrics(invalid)).toThrow();
});
