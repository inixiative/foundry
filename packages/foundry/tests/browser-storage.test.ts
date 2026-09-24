import { expect, test } from "bun:test";
import { persistBrowserMessages, browserStorageNotice, updateTurnMessage, mergeMessageHistory } from "../src/viewer/ui/conversation-state.js";

const completed = { actor: "agent", turnId: "one", content: "completed output", output: "completed output",
  traceSnapshot: { root: { status: "ok" } }, meta: { executionOutcome: "completed", persistence: "failed" } };

for (const name of ["QuotaExceededError", "SecurityError"]) {
  test(`${name} retains unsaved output and prior storage, then a successful write clears volatile status`, () => {
    let disk = "prior browser history";
    const failed = persistBrowserMessages([completed], () => { throw new DOMException("Rejected", name); });
    expect(disk).toBe("prior browser history");
    expect(failed[0]).toMatchObject({ ...completed, browserStorage: { status: "volatile", error: name } });
    expect(browserStorageNotice(failed[0])).toContain("only in this tab");
    expect(browserStorageNotice(failed[0])).toContain("reload or close");
    expect(completed).not.toHaveProperty("browserStorage");
    const saved = persistBrowserMessages(failed, (value: string) => { disk = value; });
    expect(saved[0].browserStorage.status).toBe("saved");
    expect(browserStorageNotice(saved[0])).toBeNull();
    expect(JSON.parse(disk)[0]).toEqual(saved[0]);
    expect(saved[0].meta.persistence).toBe("failed"); // browser write is not a server commit
  });
}

test("serialization rejection leaves completed evidence accessible in memory without attempting a write", () => {
  const trace: any = { root: { status: "ok" } }; trace.self = trace;
  let writes = 0;
  const result = persistBrowserMessages([{ ...completed, traceSnapshot: trace }], () => { writes++; });
  expect(writes).toBe(0);
  expect(result[0].output).toBe(completed.output);
  expect(result[0].traceSnapshot).toBe(trace);
  expect(result[0].browserStorage.status).toBe("volatile");
  expect(browserStorageNotice(result[0])).toContain("only in this tab");
});

test("rejected optional browser cache does not claim a committed result was lost", () => {
  const failed = persistBrowserMessages([{ ...completed, meta: { executionOutcome: "completed", persistence: "committed" } }], () => { throw Error("blocked"); });
  expect(browserStorageNotice(failed[0])).toContain("saved on the server");
  expect(browserStorageNotice(failed[0])).not.toContain("only in this tab");
  expect(failed[0].meta.persistence).toBe("committed");
});

test("changing one message invalidates only its browser copy, including previously saved streamed text", () => {
  const saved = persistBrowserMessages([completed, { ...completed, turnId: "two" }], () => {});
  const changed = updateTurnMessage(saved, "two", { content: "later completed output" });
  const failed = persistBrowserMessages(changed, () => { throw Error("blocked"); });
  expect(failed[0]).toBe(saved[0]);
  expect(browserStorageNotice(failed[0])).toBeNull();
  expect(failed[1].browserStorage.status).toBe("volatile");
});

test("history reconciliation cannot mislabel a changed server record as browser-saved", () => {
  const local = persistBrowserMessages([completed], () => {});
  const merged = mergeMessageHistory(local, [{ ...completed, content: "journal record", meta: { persistence: "committed" } }]);
  const failed = persistBrowserMessages(merged, () => { throw Error("blocked"); });
  expect(failed[0].browserStorage.status).toBe("volatile");
  expect(browserStorageNotice(failed[0])).toContain("saved on the server");
  expect(failed[0].content).toBe("journal record");
});

test("a committed interruption does not make additional browser-only failure evidence durable", () => {
  const failed = persistBrowserMessages([{ actor: "agent", storage: "server", meta: {
    persistence: "committed", browserFailureEvidence: { partialOutput: "only observed here" },
  } }], () => { throw Error("blocked"); });
  expect(browserStorageNotice(failed[0])).toContain("Server record is saved");
  expect(browserStorageNotice(failed[0])).toContain("only in this tab");
});
