import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStack, Thread } from "@inixiative/foundry-core";
import { LocalSessionStore } from "../src/persistence/local-session-store";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "foundry-local-store-"));
  cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
  const path = join(dir, "sessions.sqlite");
  const a = new Thread("a", new ContextStack(), { projectId: "P", description: "Human title", tags: ["qa"] });
  const b = new Thread("b", new ContextStack(), { projectId: "Q" });
  return { path, a, b };
}
const trace = (id: string) => ({ id: `trace-${id}`, messageId: id, startedAt: 1, root: {}, summary: { id: `trace-${id}` }, spans: [] });

test("local journal survives reopen with exact response/artifact and thread scope", () => {
  const { path, a, b } = setup();
  const store = new LocalSessionStore(path);
  store.beginTurn(a, "turn-a", "private input A");
  const meta = { injection: { providerMessages: [{ role: "user", content: "private input A" }] } };
  store.completeTurn(a, "turn-a", "output A", meta, trace("turn-a"));
  store.beginTurn(b, "turn-b", "private input B");
  store.failTurn(b, "turn-b", "provider failed");
  meta.injection.providerMessages[0].content = "mutated later";
  store.close();
  const reopened = new LocalSessionStore(path);
  cleanup.push(() => reopened.close());
  expect(reopened.messages(a.id).map(m => m.content)).toEqual(["private input A", "output A"]);
  expect(JSON.stringify(reopened.messages(a.id))).not.toContain("private input B");
  expect(JSON.stringify(reopened.messages(a.id))).not.toContain("mutated later");
  expect(reopened.trace("trace-turn-a")).toEqual(trace("turn-a"));
  expect(reopened.threads().find(t => t.id === a.id)?.meta).toMatchObject({ description: "Human title", tags: ["qa"], projectId: "P" });
});

test("duplicate acceptance cannot execute another logical turn or overwrite evidence", () => {
  const { path, a, b } = setup();
  const store = new LocalSessionStore(path); cleanup.push(() => store.close());
  store.beginTurn(a, "turn", "original");
  expect(() => store.beginTurn(b, "turn", "replacement")).toThrow("already accepted");
  store.completeTurn(a, "turn", "done", {}, trace("turn"));
  expect(() => store.completeTurn(a, "turn", "changed", {}, trace("turn"))).toThrow("not active");
  expect(store.messages(a.id).map(m => m.content)).toEqual(["original", "done"]);
  expect(store.threads().some(t => t.id === b.id)).toBe(false);
});

test("response serialization failure rolls back the trace and leaves acceptance recoverable", () => {
  const { path, a } = setup();
  const store = new LocalSessionStore(path); cleanup.push(() => store.close());
  store.beginTurn(a, "turn", "original");
  const circular: Record<string, unknown> = {}; circular.self = circular;
  expect(() => store.completeTurn(a, "turn", "done", circular, trace("turn"))).toThrow();
  expect(store.trace("trace-turn")).toBeUndefined();
  expect(store.messages(a.id)).toHaveLength(1);
  expect(store.turn("turn")?.status).toBe("active");
});

test("failed response and trace commit atomically, validate ownership and preserve partial output", () => {
  const { path, a, b } = setup();
  const store = new LocalSessionStore(path); cleanup.push(() => store.close());
  store.beginTurn(a, "failed", "input A");
  const circular: Record<string, unknown> = {}; circular.self = circular;
  expect(() => store.failTurn(a, "failed", "failed", { trace: trace("failed"), meta: circular })).toThrow();
  expect(store.traceForTurn("failed")).toBeUndefined();
  expect(store.turn("failed")?.status).toBe("active");
  expect(store.messages(a.id)).toHaveLength(1);
  expect(() => store.failTurn(b, "failed", "wrong owner", { trace: trace("failed") })).toThrow("not active");
  expect(() => store.failTurn(a, "failed", "wrong turn", { trace: trace("other") })).toThrow("this turn");
  store.failTurn(a, "failed", "Provider failed", { trace: trace("failed"), meta: { partialOutput: "unconfirmed partial" } });
  expect(store.traceForTurn("failed")).toEqual(trace("failed"));
  expect(store.messages(a.id).at(-1)).toMatchObject({ traceId: "trace-failed", kind: "error",
    meta: { partialOutput: "unconfirmed partial", turnStatus: "failed" } });
  expect(() => store.failTurn(a, "failed", "overwrite")).toThrow("not active");
});

test("restart recovery is explicit, idempotent and never invents native completion", () => {
  const { path, a } = setup();
  const store = new LocalSessionStore(path);
  store.beginTurn(a, "unfinished", "working input"); store.close();
  const reopened = new LocalSessionStore(path); cleanup.push(() => reopened.close());
  expect(reopened.recoverInterrupted()).toBe(1);
  expect(reopened.recoverInterrupted()).toBe(0);
  expect(reopened.turn("unfinished")?.status).toBe("interrupted");
  expect(reopened.messages(a.id).at(-1)).toMatchObject({ kind: "error", meta: { turnStatus: "interrupted" } });
  expect(reopened.messages(a.id).at(-1)?.content).toContain("Native work may have continued");
  expect(reopened.threads().find(t => t.id === a.id)?.meta.status).toBe("waiting");
  expect(reopened.traces()).toEqual([]);
});

test("a second viewer cannot recover turns owned by a live store", () => {
  const { path, a } = setup();
  const store = new LocalSessionStore(path); cleanup.push(() => store.close());
  store.beginTurn(a, "active-turn", "still running");
  expect(() => { const competing = new LocalSessionStore(path); competing.close(); }).toThrow();
  expect(store.turn("active-turn")?.status).toBe("active");
});
