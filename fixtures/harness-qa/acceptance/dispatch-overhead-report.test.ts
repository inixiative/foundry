import { expect, test } from "bun:test";
import { timingSummary } from "../../../scripts/measure-dispatch-overhead";

test("timing report measures first execution boundary without summing overlapping stages", () => {
  const result = timingSummary({ id: "trace", messageId: "turn", startedAt: 100, durationMs: 500,
    spans: [
      { kind: "route", name: "route", startedAt: 110, durationMs: 40, output: { confidence: 0, reasoning: "fallback: CONTROLLED_PRIVATE_DETAIL" } },
      { kind: "classify", name: "classify", startedAt: 100, durationMs: 50 },
      { kind: "execute", name: "execute", startedAt: 160, durationMs: 400 },
    ] });
  expect(result.preExecuteMs).toBe(60);
  expect(result.stages[0]!.fallbackExplicit).toBe(true);
  expect(result.stages[0]!.confidence).toBe(0);
  expect(JSON.stringify(result)).not.toContain("CONTROLLED_PRIVATE_DETAIL");
  expect(result.nativeParity).toBe("not established");
});

test("missing terminal timing or execution cannot become a zero-overhead result", () => {
  expect(() => timingSummary({ id: "trace", messageId: "turn", startedAt: 0, durationMs: 10, spans: [] })).toThrow();
  expect(() => timingSummary({ id: "trace", messageId: "turn", startedAt: 0, durationMs: NaN, spans: [{ kind: "execute", name: "execute", startedAt: 1 }] })).toThrow();
});
