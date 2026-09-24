import { expect, test } from "bun:test";
import { SessionBackedProvider } from "../../../packages/foundry/src/providers/session-backed";
import { ClaudeCodeSessionAdapter, InMemoryExternalSessionStore } from "../../../packages/foundry/src/providers/session-adapter";

async function fixture(threadId: string, store: InMemoryExternalSessionStore) {
  const adapter = new ClaudeCodeSessionAdapter({ store, defaults: {
    spawn: () => { throw Error("Independent fixture forbids native processes"); },
  } });
  const create = adapter.createSession.bind(adapter);
  let actualResume: string | null = null;
  let sends = 0;
  // Keep real adapter construction and binding resolution. Only the native
  // process lifecycle is replaced; this fixture cannot spawn or alter real state.
  adapter.createSession = async opts => {
    const session = await create(opts);
    actualResume = session.externalSessionId ?? null;
    session.start = async () => {};
    session.send = async () => {
      sends++;
      return { content: "Controlled", events: [], externalSessionId: actualResume ?? "controlled-new-binding" };
    };
    return session;
  };
  const provider = new SessionBackedProvider({ id: "claude-code", adapter, defaultModel: "fable", defaultCwd: "/controlled/offline" });
  return { provider, threadId, get actualResume() { return actualResume; }, get sends() { return sends; } };
}

test("auxiliary fresh text-only profile does not claim it resumed preserved coding history", async () => {
  const store = new InMemoryExternalSessionStore();
  const threadId = "controlled:aux:domain:review";
  await store.save(threadId, "claude-code", "controlled-legacy-coding-binding");
  const f = await fixture(threadId, store);
  const result = await f.provider.complete([{ role: "user", content: "Review synthetic work" }], { threadId });
  const profile = (result.raw as { profile: { resumedBinding: string | null; persistedModelIdentity: string } }).profile;
  expect(f.actualResume).toBeNull();
  expect(profile.resumedBinding).toBe(f.actualResume);
  expect(profile.persistedModelIdentity).toBe("fresh-session");
  expect(await store.load(threadId, "claude-code")).toBe("controlled-legacy-coding-binding");
  expect(f.sends).toBe(1);
});

test("profile describes the actual binding consumed at construction or refuses a changed lookup", async () => {
  const store = new InMemoryExternalSessionStore();
  let loads = 0;
  store.load = async () => ++loads === 1 ? null : "controlled-resumed-binding";
  const f = await fixture("controlled-central", store);
  let result: Awaited<ReturnType<SessionBackedProvider["complete"]>>;
  try {
    result = await f.provider.complete([{ role: "user", content: "Synthetic work" }], { threadId: f.threadId });
  } catch {
    // Refusal before execution is a valid alternative to an authoritative
    // construction snapshot, but dispatch with contradictory provenance is not.
    expect(f.sends).toBe(0);
    return;
  }
  const profile = (result.raw as { profile: { resumedBinding: string | null; persistedModelIdentity: string } }).profile;
  expect(profile.resumedBinding).toBe(f.actualResume);
  expect(profile.persistedModelIdentity).toBe(f.actualResume ? "unknown" : "fresh-session");
  expect(f.sends).toBe(1);
});

test("stable central binding retains truthful requested-resume provenance", async () => {
  const store = new InMemoryExternalSessionStore();
  await store.save("controlled-central", "claude-code", "controlled-central-binding");
  const f = await fixture("controlled-central", store);
  const result = await f.provider.complete([{ role: "user", content: "Synthetic work" }], { threadId: f.threadId });
  const profile = (result.raw as { profile: { resumedBinding: string | null; persistedModelIdentity: string } }).profile;
  expect(f.actualResume).toBe("controlled-central-binding");
  expect(profile.resumedBinding).toBe(f.actualResume);
  expect(profile.persistedModelIdentity).toBe("unknown");
  expect(f.sends).toBe(1);
});
