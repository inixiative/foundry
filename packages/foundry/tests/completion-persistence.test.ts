import { expect, test } from "bun:test";
import { completionFixture } from "./helpers/completion-persistence-fixture";
import { mergeMessageHistory, readMessageStream } from "../src/viewer/ui/conversation-state.js";

for (const streaming of [false, true]) {
  test(`${streaming ? "SSE" : "HTTP"} completion commit failure preserves output, original error and browser reconciliation`, async () => {
    const fixture = await completionFixture();
    try {
      const first = fixture.make();
      const request = () => first.app.request(`/api/messages${streaming ? "/stream" : ""}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "unsaved", threadId: "main", message: "Complete once" }),
      });
      const response = await request();
      let body: any;
      if (streaming) {
        const events: any[] = [];
        await readMessageStream(response.body!, (event: any) => events.push(event));
        body = events.at(-1);
        expect(body.type).toBe("done");
        expect(events.some(event => event.type === "error")).toBe(false);
      } else { expect(response.status).toBe(500); body = await response.json(); }
      expect(first.failureWrites()).toBe(0);
      expect(body.output).toBe(fixture.output);
      expect(body.meta).toMatchObject({ executionOutcome: "completed", turnStatus: "completed-unsaved", persistence: "failed",
        persistenceError: "COMPLETION-COMMIT-ERROR", nativeOutcome: "unknown", deliveryAcknowledgment: "unavailable" });
      expect(body.meta.partialOutput).toBeUndefined();
      expect(body.meta.injection.providerMessages.at(-1).content).toBe("Complete once");
      expect(body.trace.stages[0].status).toBe("ok");
      expect(body.traceSnapshot.root.status).toBe("ok");
      expect(body.traceSnapshot.messageId).toBe("unsaved");
      expect(first.localStore!.turn("unsaved")?.status).toBe("active");
      expect(first.localStore!.messages("main")).toHaveLength(1);
      expect(first.localStore!.traceForTurn("unsaved")).toBeUndefined();
      expect((await request()).status).toBe(409);
      expect(fixture.calls()).toBe(1);
      const local = [{ actor: "agent", turnId: "unsaved", content: body.output, output: body.output,
        traceId: body.traceId, trace: body.trace, traceSnapshot: body.traceSnapshot, meta: body.meta, streaming: false, storage: "browser-only" }];
      const beforeReload = mergeMessageHistory(local, first.localStore!.messages("main"));
      expect(beforeReload.find((m: any) => m.actor === "agent").output).toBe(fixture.output);
      first.close();
      const second = fixture.make();
      const history = second.localStore!.messages("main");
      const merged = mergeMessageHistory(JSON.parse(JSON.stringify(beforeReload)), history);
      const completed = merged.find((m: any) => m.actor === "agent");
      expect(completed.output).toBe(fixture.output);
      expect(completed.content).toBe(fixture.output);
      expect(completed.meta.executionOutcome).toBe("completed");
      expect(completed.meta.persistence).toBe("failed");
      expect(completed.journalRecord.meta.turnStatus).toBe("interrupted");
      expect(completed.journalRecord.meta.nativeOutcome).toBe("unknown");
      expect(completed.storage).toBe("browser-only");
      expect(completed.traceId).toBeUndefined();
      expect(completed.browserTraceId).toBe(body.traceId);
      expect(completed.meta.injection).toEqual(body.meta.injection);
      expect(completed.traceSnapshot).toEqual(body.traceSnapshot);
      expect(mergeMessageHistory(merged, history)).toEqual(merged);
      expect(second.localStore!.turn("unsaved")?.status).toBe("interrupted");
      expect(fixture.calls()).toBe(1);
    } finally { fixture.close(); }
  });
}
