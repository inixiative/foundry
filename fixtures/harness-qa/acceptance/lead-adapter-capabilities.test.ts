import { expect, test } from "bun:test";
import { ClaudeCodeSessionAdapter, CodexSessionAdapter, InMemoryExternalSessionStore, type SessionAdapter } from "../../../packages/foundry/src/providers/session-adapter";
import { trackSessions, type TrackedSession } from "../../../scripts/owned-session-adapter";

for (const Adapter of [ClaudeCodeSessionAdapter, CodexSessionAdapter]) {
  test(`${Adapter.name} startup tracking retains construction and observation capabilities`, async () => {
    const store = new InMemoryExternalSessionStore();
    const adapter = new Adapter({ store });
    await store.save("owned", adapter.runtime, "controlled-existing-binding");
    const owned = new Set<TrackedSession>();
    const tracked = trackSessions(adapter, owned);
    const session = await tracked.createSession({ threadId: "owned", cwd: "/controlled", tools: true });
    // Construct only. Never start, send or spawn a real engine in this test.
    expect(owned.has(session)).toBe(true);
    expect(tracked.describeConstruction?.(session)).toEqual(adapter.describeConstruction(session));
    expect(tracked.observedConfiguration?.(session)).toEqual([]);
    expect(Object.isFrozen(tracked.observedConfiguration?.(session))).toBe(true);
    expect(tracked.releaseIdleSession).toBeTypeOf("function");
    expect(await tracked.getExternalSessionId("owned")).toBe("controlled-existing-binding");
  });
}

test("startup tracking preserves asynchronous release and method receiver", async () => {
  let finish!: (status: "released" | "unknown") => void;
  const held = new Promise<"released" | "unknown">(r => { finish = r; });
  const session = {} as TrackedSession;
  const adapter: SessionAdapter = {
    runtime: "controlled",
    async createSession() { expect(this).toBe(adapter); return session; },
    async getExternalSessionId() { return null; }, async clearSession() {},
    releaseIdleSession(value) { expect(this).toBe(adapter); expect(value).toBe(session); return held; },
  };
  const tracked = trackSessions(adapter, new Set());
  expect(await tracked.createSession({ threadId: "owned", cwd: "/controlled" })).toBe(session);
  expect(tracked.releaseIdleSession).toBeTypeOf("function");
  let settled = false;
  const pending = tracked.releaseIdleSession!(session).then(status => { settled = true; return status; });
  await Promise.resolve(); expect(settled).toBe(false);
  finish("released"); expect(await pending).toBe("released");
});

test("unsupported optional capabilities remain unavailable and failed construction is not tracked", async () => {
  const owned = new Set<TrackedSession>();
  const adapter: SessionAdapter = { runtime: "controlled", async createSession() { throw Error("controlled construction failure"); }, async getExternalSessionId() { return null; }, async clearSession() {} };
  const tracked = trackSessions(adapter, owned);
  expect(tracked.describeConstruction).toBeUndefined();
  expect(tracked.observedConfiguration).toBeUndefined();
  expect(tracked.releaseIdleSession).toBeUndefined();
  expect(tracked.bindSignals).toBeUndefined();
  await expect(tracked.createSession({ threadId: "owned", cwd: "/controlled" })).rejects.toThrow("controlled construction failure");
  expect(owned.size).toBe(0);
});

test("signal binding and session clearing retain the adapter receiver and arguments", async () => {
  const signals = {} as Parameters<NonNullable<SessionAdapter["bindSignals"]>>[1];
  let disposed = false;
  const adapter: SessionAdapter = {
    runtime: "controlled",
    async createSession() { throw Error("unused"); },
    async getExternalSessionId() { return null; },
    async clearSession(id) { expect(this).toBe(adapter); expect(id).toBe("owned"); },
    bindSignals(id, actual) {
      expect(this).toBe(adapter); expect(id).toBe("owned"); expect(actual).toBe(signals);
      return () => { disposed = true; };
    },
  };
  const tracked = trackSessions(adapter, new Set());
  const dispose = tracked.bindSignals!("owned", signals);
  expect(disposed).toBe(false); dispose(); expect(disposed).toBe(true);
  await tracked.clearSession("owned");
});
