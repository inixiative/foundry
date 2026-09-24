import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStack, EventStream, Harness, InterventionLog, Thread } from "@inixiative/foundry-core";
import { LocalSessionStore } from "../src/persistence/local-session-store";
import { registerRuntimeRoutes } from "../src/viewer/routes/runtime";
import { ConfigStore } from "../src/viewer/config";

// G6 history index: a bounded summary index with stable cursors that reaches the
// oldest record, plus lazily fetched owned turn detail. `/api/messages` is unchanged.

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

const HEAVY = "x".repeat(20_000);

function seedTurn(store: LocalSessionStore, thread: Thread, n: number, opts: { native?: boolean; fail?: boolean; leaveActive?: boolean } = {}) {
  const turnId = `t-${thread.id}-${String(n).padStart(3, "0")}`;
  const user = `question ${n} on ${thread.id}`;
  store.beginTurn(thread, turnId, user);
  if (opts.leaveActive) return turnId;
  const injection = { userMessage: user, blocks: [{ id: "conventions", kind: "domain-knowledge", source: "conventions", text: HEAVY, hash: "h", tokens: 5000 }],
    text: HEAVY, tokens: 5000, capturedAt: 1, threadId: thread.id, providerMessages: [{ role: "user", content: user }], layers: [] };
  const started = 1_700_000_000_000 + n * 1000;
  const trace = { id: `trace-${turnId}`, messageId: turnId, startedAt: started, endedAt: started + 10, durationMs: 10,
    root: { id: `s-${turnId}`, name: "ingress", kind: "ingress", threadId: thread.id, status: opts.fail ? "error" : "ok", input: user, annotations: { injection }, startedAt: started, endedAt: started + 10, durationMs: 10, children: [] },
    summary: { traceId: `trace-${turnId}`, messageId: turnId, totalDurationMs: 10, spanCount: 1, stages: [{ name: "ingress", kind: "ingress", status: "ok", durationMs: 10, depth: 0 }] } } as any;
  if (opts.fail) { store.failTurn(thread, turnId, "Provider failed", { trace, meta: { injection, executionOutcome: "failed", persistence: "committed" } }); return turnId; }
  // Production provenance shape (buildInjectionProvenance): small records, one per included layer.
  // Realistic production shape: an opaque provider transcript string rides along in the completion metadata.
  const meta: Record<string, unknown> = { injection, injectedLayers: [{ id: "conventions", hash: "h", tokens: 5000 }], executionOutcome: "completed", persistence: "committed", turnStatus: "completed",
    providerTranscript: "OPAQUE_TRANSCRIPT_NOT_FOR_INDEX_" + HEAVY,
    ...(opts.native ? { nativeHistory: [{ schema: 1, owner: { threadId: thread.id, projectId: thread.meta.projectId, generation: "fixture", messageId: turnId }, nativeOutcome: "completed", localOutcome: "resolved", kind: "result", content: HEAVY, observedAt: started }] } : {}) };
  store.completeTurn(thread, turnId, `answer ${n} ${opts.native ? "native" : ""}`, meta, trace);
  return turnId;
}

function setup(withStore = true) {
  const dir = mkdtempSync(join(tmpdir(), "foundry-history-index-"));
  cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
  const main = new Thread("main", new ContextStack(), { projectId: "p1" });
  const other = new Thread("other", new ContextStack(), { projectId: "p1" });
  const harness = new Harness(main);
  const localStore = withStore ? new LocalSessionStore(join(dir, "sessions.sqlite")) : null;
  if (localStore) cleanup.push(() => localStore.close());
  const app = new Hono();
  registerRuntimeRoutes(app, { harness, eventStream: new EventStream(), interventions: new InterventionLog(main.signals),
    db: null, configStore: new ConfigStore(dir), localStore });
  return { app, localStore, main, other };
}

function seedLong(store: LocalSessionStore, main: Thread, other: Thread) {
  for (let n = 1; n <= 40; n++) seedTurn(store, main, n, { native: n % 10 === 0 });
  seedTurn(store, main, 41, { fail: true });
  seedTurn(store, main, 42, { leaveActive: true });
  for (let n = 1; n <= 7; n++) seedTurn(store, other, n);
}

test("store index walks to the oldest record exactly once with repeatable cursors and no heavy detail", () => {
  const { localStore: store, main, other } = setup();
  seedLong(store!, main, other);
  const full = store!.messages("main", 10_000);
  expect(full.length).toBe(83); // 40 complete + failed (user+error) + active (user only)

  const seen: string[] = [];
  let page = store!.messageIndex("main", { limit: 25 });
  expect(page.messages.length).toBe(25);
  expect(page.hasMore).toBe(true); expect(page.oldestReached).toBe(false);
  expect(page.messages.at(-1)!.id).toBe(full.at(-1)!.id); // newest page first, ascending inside
  // Repeating the same request returns the identical page.
  expect(store!.messageIndex("main", { limit: 25 })).toEqual(page);
  let guard = 0;
  while (true) {
    for (const row of page.messages) seen.push(row.id);
    if (!page.hasMore) break;
    const before = page.nextBefore!;
    const again = store!.messageIndex("main", { limit: 25, before });
    expect(store!.messageIndex("main", { limit: 25, before })).toEqual(again);
    page = again;
    if (++guard > 10) throw new Error("pagination did not terminate");
  }
  expect(page.oldestReached).toBe(true);
  expect(seen.reverse().sort()).toEqual(full.map(m => m.id).sort());
  expect(new Set(seen).size).toBe(full.length);
  expect(seen[0]).toBe(full[0]!.id);

  for (const row of store!.messageIndex("main", { limit: 500 }).messages) {
    expect(JSON.stringify(row).length).toBeLessThan(2_000);
    expect(row.meta ? "injection" in row.meta : false).toBe(false);
    expect(row.meta ? "nativeHistory" in row.meta : false).toBe(false);
    expect(row.threadId).toBe("main");
  }
});

test("index summaries keep identity, semantic status and detail availability", () => {
  const { localStore: store, main, other } = setup();
  seedLong(store!, main, other);
  const rows = store!.messageIndex("main", { limit: 500 }).messages;
  const byTurn = (turn: string, actor: "user" | "agent") => rows.find(r => r.turnId === turn && r.actor === actor)!;
  const native = byTurn("t-main-010", "agent");
  expect(native.detail).toMatchObject({ injection: true, nativeHistory: 1, nativeTools: 0, trace: true });
  // Names of metadata that only the owned detail holds; never the payloads themselves.
  expect(native.detail.detailOnlyMeta).toEqual(expect.arrayContaining(["injection", "nativeHistory", "providerTranscript"]));
  expect(native.detail.detailOnlyMeta).not.toContain("turnStatus");
  expect(JSON.stringify(native)).not.toContain("OPAQUE_TRANSCRIPT_NOT_FOR_INDEX");
  expect(native.status).toMatchObject({ turn: "completed", persistence: "committed", executionOutcome: "completed", nativeOutcome: "completed" });
  expect(native.traceId).toBe("trace-t-main-010");
  expect(native.trace).toMatchObject({ totalDurationMs: 10 });
  // Layer provenance records are small and drive the per-message chips; they survive the index. Large objects do not.
  expect(native.meta).toMatchObject({ injectedLayers: [{ id: "conventions", hash: "h", tokens: 5000 }], turnStatus: "completed" });
  expect(native.meta && "injection" in native.meta).toBe(false);
  const plain = byTurn("t-main-011", "agent");
  expect(plain.detail).toMatchObject({ injection: true, nativeHistory: 0, nativeTools: 0, trace: true });
  const failed = byTurn("t-main-041", "agent");
  expect(failed.kind).toBe("error");
  expect(failed.status).toMatchObject({ turn: "failed", executionOutcome: "failed" });
  expect(failed.detail).toMatchObject({ injection: true, trace: true });
  const pending = byTurn("t-main-042", "user");
  expect(pending.status.turn).toBe("active");
  expect(rows.find(r => r.turnId === "t-main-042" && r.actor === "agent")).toBeUndefined();
  const user = byTurn("t-main-011", "user");
  expect(user.detail).toEqual({ injection: false, nativeHistory: 0, nativeTools: 0, trace: false, detailOnlyMeta: [] });
  expect(full(store!, "main", "t-main-010").meta?.nativeHistory).toHaveLength(1); // full history unchanged
});

function full(store: LocalSessionStore, thread: string, turn: string) {
  return store.messages(thread, 10_000).find(m => m.turnId === turn && m.actor === "agent")!;
}

test("appends during pagination never shift an already issued older page", () => {
  const { localStore: store, main, other } = setup();
  seedLong(store!, main, other);
  const first = store!.messageIndex("main", { limit: 10 });
  const second = store!.messageIndex("main", { limit: 10, before: first.nextBefore! });
  seedTurn(store!, main, 500);
  seedTurn(store!, main, 501);
  expect(store!.messageIndex("main", { limit: 10, before: first.nextBefore! })).toEqual(second);
  const newest = store!.messageIndex("main", { limit: 10 });
  expect(newest.messages.at(-1)!.turnId).toBe("t-main-501");
  expect(newest.messages.at(-1)!.seq).toBeGreaterThan(first.messages.at(-1)!.seq);
});

test("turn detail returns the full owned rows, trace, recorded injection and native evidence", () => {
  const { localStore: store, main, other } = setup();
  seedLong(store!, main, other);
  const detail = store!.turnDetail("main", "t-main-010")!;
  expect(detail.turn?.status).toBe("completed");
  expect(detail.messages.map(m => m.actor)).toEqual(["user", "agent"]);
  expect(detail.trace?.id).toBe("trace-t-main-010");
  expect((detail.injection as { text: string }).text).toBe(HEAVY);
  expect(detail.nativeHistory).toHaveLength(1);
  expect(detail.nativeTools).toEqual([]);
  expect(store!.turnDetail("other", "t-main-010")).toBeUndefined();
  expect(store!.turnDetail("main", "missing")).toBeUndefined();
  const pending = store!.turnDetail("main", "t-main-042")!;
  expect(pending.turn?.status).toBe("active"); expect(pending.trace).toBeNull(); expect(pending.injection).toBeNull();
});

test("history route pages with opaque cursors and refuses malformed or cross-thread cursors", async () => {
  const { app, localStore: store, main, other } = setup();
  seedLong(store!, main, other);
  const first = await app.request("/api/threads/main/history?limit=30");
  expect(first.status).toBe(200);
  const body = await first.json();
  expect(body.threadId).toBe("main"); expect(body.source).toBe("journal");
  expect(body.messages).toHaveLength(30); expect(body.hasMore).toBe(true); expect(body.oldestReached).toBe(false);
  expect(typeof body.nextCursor).toBe("string");
  expect(JSON.stringify(body).length).toBeLessThan(60_000);
  for (const row of body.messages) expect(row.meta?.injection).toBeUndefined();

  const ids: string[] = body.messages.map((m: { id: string }) => m.id);
  let cursor = body.nextCursor, pages = 1;
  while (cursor) {
    const res = await app.request(`/api/threads/main/history?limit=30&before=${encodeURIComponent(cursor)}`);
    expect(res.status).toBe(200);
    const page = await res.json();
    ids.push(...page.messages.map((m: { id: string }) => m.id));
    cursor = page.nextCursor; pages++;
    if (!page.hasMore) expect(page.oldestReached).toBe(true);
  }
  expect(pages).toBe(3);
  expect(new Set(ids).size).toBe(83);
  expect(ids.sort()).toEqual(store!.messages("main", 10_000).map(m => m.id).sort());

  const otherFirst = await (await app.request("/api/threads/other/history?limit=5")).json();
  expect(otherFirst.messages.every((m: { threadId: string }) => m.threadId === "other")).toBe(true);
  const cross = await app.request(`/api/threads/main/history?before=${encodeURIComponent(otherFirst.nextCursor)}`);
  expect(cross.status).toBe(400);
  expect((await cross.json()).error).toMatch(/cursor/);
  expect((await app.request("/api/threads/main/history?before=not-a-cursor")).status).toBe(400);
  expect((await app.request("/api/threads/main/history?limit=0")).status).toBe(400);
  expect((await app.request("/api/threads/main/history?limit=501")).status).toBe(400);
  const empty = await (await app.request("/api/threads/unknown/history")).json();
  expect(empty.messages).toEqual([]); expect(empty.oldestReached).toBe(true); expect(empty.hasMore).toBe(false);
});

test("detail route and unchanged full-history route", async () => {
  const { app, localStore: store, main, other } = setup();
  seedLong(store!, main, other);
  const detail = await app.request("/api/threads/main/turns/t-main-010/detail");
  expect(detail.status).toBe(200);
  const body = await detail.json();
  expect(body.turnId).toBe("t-main-010"); expect(body.trace.id).toBe("trace-t-main-010");
  expect(body.injection.text).toBe(HEAVY); expect(body.nativeHistory).toHaveLength(1);
  expect(body.artifacts.map((a: { kind: string }) => a.kind)).toEqual(expect.arrayContaining(["trace", "turn-detail", "injection", "native-event"]));
  expect(body.artifacts.find((a: { kind: string }) => a.kind === "trace").href).toBe("/api/traces/trace-t-main-010");
  expect((await app.request("/api/threads/other/turns/t-main-010/detail")).status).toBe(404);
  expect((await app.request("/api/threads/main/turns/nope/detail")).status).toBe(404);

  const legacy = await (await app.request("/api/messages?threadId=main&limit=1000")).json();
  expect(legacy.messages).toHaveLength(83);
  const nativeRow = legacy.messages.find((m: { turnId: string; actor: string }) => m.turnId === "t-main-010" && m.actor === "agent");
  expect(nativeRow.meta.injection.text).toBe(HEAVY); expect(nativeRow.meta.nativeHistory).toHaveLength(1);
});

test("without a journal the index and detail routes fail explicitly instead of claiming empty history", async () => {
  const { app } = setup(false);
  const index = await app.request("/api/threads/main/history");
  expect(index.status).toBe(503);
  expect((await index.json()).error).toMatch(/journal|unavailable/);
  expect((await app.request("/api/threads/main/turns/x/detail")).status).toBe(503);
});
