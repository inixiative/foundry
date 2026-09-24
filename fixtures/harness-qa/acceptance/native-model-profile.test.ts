import { expect, test } from "bun:test";
import { SessionBackedProvider } from "../../../packages/foundry/src/providers/session-backed";
import type { CreateSessionOpts, SessionAdapter } from "../../../packages/foundry/src/providers/session-adapter";

function fixture() {
  const created: CreateSessionOpts[] = [];
  const sent: string[] = [];
  const adapter: SessionAdapter = {
    runtime: "controlled-native",
    async createSession(opts) {
      created.push(structuredClone(opts));
      return {
        async start() {},
        async send(message: string) {
          sent.push(message);
          return { content: "controlled", events: [], externalSessionId: "controlled-binding" };
        },
        kill() {},
      } as unknown as Awaited<ReturnType<SessionAdapter["createSession"]>>;
    },
    async getExternalSessionId() { return "controlled-binding"; },
    async clearSession() { throw Error("Binding must not be cleared implicitly"); },
  };
  return { created, sent, provider: new SessionBackedProvider({ id: "claude-code", adapter, defaultModel: "fable" }) };
}

test("the default model reaches native session creation explicitly", async () => {
  const f = fixture();
  await f.provider.complete([{ role: "user", content: "Work" }], { threadId: "work" });
  expect(f.created).toHaveLength(1);
  expect(f.created[0]).toMatchObject({ model: "fable" });
});

test("an explicit auxiliary model reaches native creation with text-only restrictions", async () => {
  const f = fixture();
  await f.provider.complete([{ role: "user", content: "Classify" }], { threadId: "work:aux:classifier", model: "haiku" });
  expect(f.created).toHaveLength(1);
  expect(f.created[0]).toMatchObject({ model: "haiku", tools: false, maxTurns: 1 });
});

test("a changed model on a warm native thread is rejected before sending or replacing its binding", async () => {
  const f = fixture();
  await f.provider.complete([{ role: "user", content: "First" }], { threadId: "work", model: "fable" });
  await expect(f.provider.complete([{ role: "user", content: "Second" }], { threadId: "work", model: "haiku" }))
    .rejects.toThrow(/model|profile/i);
  expect(f.created).toHaveLength(1);
  expect(f.sent).toHaveLength(1);
});

test("an unchanged explicit/default model reuses its warm native session", async () => {
  const f = fixture();
  await f.provider.complete([{ role: "user", content: "First" }], { threadId: "work" });
  await f.provider.complete([{ role: "user", content: "Second" }], { threadId: "work", model: "fable" });
  expect(f.created).toHaveLength(1);
  expect(f.sent).toHaveLength(2);
});
