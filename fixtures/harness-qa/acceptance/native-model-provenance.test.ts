import { expect, test } from "bun:test";
import { SessionBackedProvider } from "../../../packages/foundry/src/providers/session-backed";
import type { SessionAdapter } from "../../../packages/foundry/src/providers/session-adapter";

function fixture(events: unknown[] = [], lookup: () => Promise<string | null> = async () => "controlled-binding") {
  let created = 0;
  const adapter: SessionAdapter = {
    runtime: "controlled",
    getExternalSessionId: lookup,
    async clearSession() { throw Error("No implicit binding replacement"); },
    async createSession() {
      created++;
      return { events, async start() {}, kill() {}, async send() {
        return { content: "Controlled", events, externalSessionId: "controlled-binding" };
      } } as unknown as Awaited<ReturnType<SessionAdapter["createSession"]>>;
    },
  };
  return { get created() { return created; }, provider: new SessionBackedProvider({ id: "claude-code", adapter, defaultModel: "fable" }) };
}

test("a model field in a tool or unknown event is not native configuration acknowledgment", async () => {
  for (const type of ["tool_use", "unrecognized-event"]) {
    const f = fixture([{ kind: "tool_use", timestamp: 1, raw: { type, model: "UNTRUSTED_MODEL_LABEL" } }]);
    const result = await f.provider.complete([{ role: "user", content: "Work" }], { threadId: "work" });
    expect((result.raw as { nativeModel?: string }).nativeModel).toBeUndefined();
  }
});

test("an emitted configuration for a different native binding cannot confirm this session model", async () => {
  const f = fixture([{ kind: "native_status", timestamp: 1, raw: {
    type: "system", subtype: "init", session_id: "foreign-binding", model: "FOREIGN_MODEL_LABEL",
  } }]);
  const result = await f.provider.complete([{ role: "user", content: "Work" }], { threadId: "work" });
  expect((result.raw as { nativeModel?: string }).nativeModel).toBeUndefined();
});

test("a failed binding lookup cannot become a fresh-session provenance claim", async () => {
  const f = fixture([], async () => { throw Error("CONTROLLED_STORE_UNAVAILABLE"); });
  let result: Awaited<ReturnType<SessionBackedProvider["complete"]>> | undefined;
  try { result = await f.provider.complete([{ role: "user", content: "Work" }], { threadId: "work" }); }
  catch (error) {
    expect(String(error)).toContain("CONTROLLED_STORE_UNAVAILABLE");
    expect(f.created).toBe(0);
    return;
  }
  // Failing closed or explicitly retaining unknown provenance is acceptable;
  // swallowing the error and declaring fresh is not.
  expect((result.raw as { profile: { persistedModelIdentity: string } }).profile.persistedModelIdentity).not.toBe("fresh-session");
});

test("matching emitted native configuration is distinct from the requested alias", async () => {
  const f = fixture([{ kind: "session_start", timestamp: 1, raw: {
    type: "system", subtype: "init", session_id: "controlled-binding", model: "claude-fable-5-1",
  } }]);
  const result = await f.provider.complete([{ role: "user", content: "Work" }], { threadId: "work" });
  expect(result.model).toBe("fable");
  expect((result.raw as { nativeModel?: string }).nativeModel).toBe("claude-fable-5-1");
});

test("a pending binding lookup does not expose a fresh-session profile before its result", async () => {
  let release!: (binding: string | null) => void;
  const lookup = new Promise<string | null>(resolve => { release = resolve; });
  const f = fixture([], () => lookup);
  const running = f.provider.complete([{ role: "user", content: "Work" }], { threadId: "work" });
  try {
    const profile = f.provider.warmProfile("work");
    expect(profile?.persistedModelIdentity).not.toBe("fresh-session");
    expect(f.created).toBe(0);
  } finally { release("controlled-binding"); await running; }
});
