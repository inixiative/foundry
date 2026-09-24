import { expect, test } from "bun:test";
import * as inspection from "../src/viewer/ui/inspector-data.js";
import { mergeMessageHistory } from "../src/viewer/ui/conversation-state.js";

test("historical failure inspection does not substitute auxiliary input for unavailable executor input", () => {
  const auxiliary = { userMessage: "auxiliary request" };
  const trace = { root: { annotations: { failure: { inputEvidence: "unavailable" } }, children: [
    { kind: "enrich", annotations: { injection: auxiliary } }, { kind: "execute", status: "error" },
  ] } };
  expect(inspection.traceInjection(trace)).toBeUndefined();
});

test("historical inspection selects the final execute stage rather than earlier helper evidence", () => {
  const final = { userMessage: "final executor" };
  const trace = { root: { children: [
    { kind: "enrich", annotations: { injection: { userMessage: "helper" } } },
    { kind: "execute", annotations: { injection: { userMessage: "earlier executor" } } },
    { kind: "execute", annotations: { injection: final } },
  ] } };
  expect(inspection.traceInjection(trace)).toEqual(final);
});

test("failure presentation distinguishes saved partials, prepared input and unknown delivery", () => {
  const view = inspection.failurePresentation({ turnStatus: "failed", persistence: "committed", partialOutput: "partial",
    inputEvidence: "provider-boundary-recorded", deliveryAcknowledgment: "unavailable", nativeOutcome: "unknown" });
  expect(view.partialOutput).toBe("partial");
  expect(view.notices.join(" ")).toContain("Failure saved to local journal");
  expect(view.notices.join(" ")).toContain("delivery acknowledgment unavailable");
  expect(view.notices.join(" ")).toContain("Native outcome unknown");
  const prepared = inspection.failurePresentation({ turnStatus: "failed", persistence: "unavailable", inputEvidence: "prepared-only" });
  expect(prepared.notices.join(" ")).toContain("provider boundary not recorded");
  expect(prepared.notices.join(" ")).not.toContain("saved to local journal");
});

test("unsaved browser evidence remains visible and separate after interruption history reconciliation", () => {
  const meta = { turnStatus: "failed", persistence: "failed", persistenceError: "disk full", partialOutput: "only in browser",
    injection: { userMessage: "browser input" }, inputEvidence: "provider-boundary-recorded" };
  const local = [{ actor: "agent", turnId: "lost", meta, traceId: "volatile-trace" }];
  const server = [{ actor: "agent", turnId: "lost", meta: { turnStatus: "interrupted", inputEvidence: "unavailable", persistence: "committed" } }];
  const merged = mergeMessageHistory(local, server);
  expect(mergeMessageHistory(merged, server)).toEqual(merged);
  const live = inspection.failurePresentation(meta);
  expect(live.notices.join(" ")).toContain("Failure was not saved to local journal: disk full");
  const recovered = inspection.failurePresentation(merged[0].meta);
  expect(recovered.partialOutput).toBe("only in browser");
  expect(recovered.notices.join(" ")).toContain("Browser-only failure evidence");
  expect(recovered.notices.join(" ")).toContain("Input unavailable");
  expect(recovered.browserEvidence.injection.userMessage).toBe("browser input");
  expect(merged[0].traceId).toBeUndefined();
});

test("browser partials survive a server interruption even when no terminal failure event arrived", () => {
  const local = [{ actor: "agent", turnId: "crash", content: "partial before crash", streaming: true }];
  const server = [{ actor: "agent", turnId: "crash", content: "Foundry restarted", meta: {
    turnStatus: "interrupted", persistence: "committed", inputEvidence: "unavailable", nativeOutcome: "unknown",
  } }];
  const merged = mergeMessageHistory(local, server);
  expect(merged[0].content).toBe("Foundry restarted");
  expect(inspection.failurePresentation(merged[0].meta).partialOutput).toBe("partial before crash");
  expect(merged[0].meta.browserFailureEvidence).toMatchObject({ partialOutput: "partial before crash", persistence: "browser-only" });
  expect(mergeMessageHistory(merged, server)).toEqual(merged);
});
