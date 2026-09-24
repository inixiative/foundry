import { describe, expect, test } from "bun:test";
import { SessionBackedProvider } from "../src/providers/session-backed";
import limitTerminal from "../../../fixtures/harness-qa/native/claude-limit-terminal.json";
import type { CreateSessionOpts, SessionAdapter } from "../src/providers/session-adapter";
import type {
  BeforeSendHook,
  HarnessSession,
  SessionArtifact,
  SessionEvent,
  SessionEventHandler,
  SessionResult,
} from "@inixiative/agent-session";

class FakeSession implements HarnessSession {
  alive = false;
  externalSessionId: string | undefined = "native-1";
  events: readonly SessionEvent[] = [];
  turns = 0;
  totalTokens = { input: 0, output: 0 };
  sent: string[] = [];
  sendOptions: Array<{ timeout?: number } | undefined> = [];

  async start(): Promise<void> {
    this.alive = true;
  }

  async send(message: string, opts?: { timeout?: number }): Promise<SessionResult> {
    this.sent.push(message);
    this.sendOptions.push(opts);
    this.turns++;
    return {
      content: `turn ${this.turns}`,
      events: [],
      tokens: { input: 1, output: 2 },
      externalSessionId: this.externalSessionId,
    };
  }

  fork(): HarnessSession {
    return new FakeSession();
  }

  interrupt(): void {}

  kill(): void {
    this.alive = false;
  }

  onEvent(_handler: SessionEventHandler): () => void {
    return () => {};
  }

  onBeforeSend(_hook: BeforeSendHook): () => void {
    return () => {};
  }

  async push(): Promise<void> {}

  artifact(): SessionArtifact {
    return {
      externalSessionId: this.externalSessionId,
      events: [],
      startedAt: 0,
      turns: this.turns,
      totalTokens: this.totalTokens,
      toolCalls: 0,
      toolResults: 0,
      errors: 0,
    };
  }
}

class FakeAdapter implements SessionAdapter {
  runtime = "fake";
  created: CreateSessionOpts[] = [];
  sessions: FakeSession[] = [];

  async createSession(opts: CreateSessionOpts): Promise<HarnessSession> {
    this.created.push(opts);
    const session = new FakeSession();
    this.sessions.push(session);
    return session;
  }

  async getExternalSessionId(): Promise<string | null> {
    return null;
  }

  async clearSession(): Promise<void> {}
}

describe("SessionBackedProvider", () => {
  test("Claude 429 is an error even when its terminal subtype says success", async () => {
    const adapter = new FakeAdapter();
    const create = adapter.createSession.bind(adapter);
    adapter.createSession = async opts => {
      const session = await create(opts);
      session.send = async () => ({ content: limitTerminal.event.result, events: [{ kind: "result", timestamp: 1,
        raw: limitTerminal.event }] });
      return session;
    };
    const provider = new SessionBackedProvider({ id: "claude-code", adapter, defaultModel: "fable" });
    await expect(provider.complete([{ role: "user", content: "Work" }])).rejects.toThrow("429");
  });
  test("a native terminal error cannot masquerade as successful empty content", async () => {
    const adapter = new FakeAdapter();
    const create = adapter.createSession.bind(adapter);
    adapter.createSession = async opts => {
      const session = await create(opts);
      session.send = async () => ({ content: "", events: [{ kind: "result", timestamp: 1,
        raw: { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 2 } }] });
      return session;
    };
    const provider = new SessionBackedProvider({ id: "claude-code", adapter, defaultModel: "fable" });
    await expect(provider.complete([{ role: "user", content: "Work" }])).rejects.toThrow("error_max_turns");
  });
  test("central native work has no implicit turn deadline while decisions remain bounded", async () => {
    const adapter = new FakeAdapter();
    const provider = new SessionBackedProvider({ id: "claude-code", adapter, defaultModel: "fable" });
    await provider.complete([{ role: "user", content: "Long real work" }], { threadId: "worker" });
    await provider.complete([{ role: "user", content: "Classify" }], { threadId: "worker:aux:classifier" });
    await provider.complete([{ role: "user", content: "Explicit timeout" }], { threadId: "worker", timeout: 123 });
    expect(adapter.sessions[0].sendOptions).toEqual([{ timeout: 0 }, { timeout: 123 }]);
    expect(adapter.sessions[1].sendOptions).toEqual([{ timeout: 15_000 }]);
  });
  test("keeps one warm session per thread and formats messages for native harnesses", async () => {
    const adapter = new FakeAdapter();
    const provider = new SessionBackedProvider({
      id: "codex",
      adapter,
      defaultModel: "gpt-6-astra",
      defaultCwd: "/tmp/project",
    });

    const first = await provider.complete(
      [
        { role: "system", content: "System guidance" },
        { role: "user", content: "Build this" },
      ],
      { threadId: "thread-1" },
    );
    const second = await provider.complete(
      [{ role: "user", content: "Continue" }],
      { threadId: "thread-1" },
    );

    expect(first.content).toBe("turn 1");
    expect(second.content).toBe("turn 2");
    expect(first.model).toBe("gpt-6-astra");
    expect(adapter.created).toEqual([{ threadId: "thread-1", cwd: "/tmp/project", model: "gpt-6-astra", maxTurns: null }]);
    expect(adapter.sessions[0].sent[0]).toContain("# System Context\n\nSystem guidance");
    expect(adapter.sessions[0].sent[0]).toContain("# User Message\n\nBuild this");
    expect(adapter.sessions[0].sent[1]).toContain("# User Message\n\nContinue");
  });

  test("isolates sessions by Foundry thread id", async () => {
    const adapter = new FakeAdapter();
    const provider = new SessionBackedProvider({
      id: "claude-code",
      adapter,
      defaultModel: "fable",
    });

    await provider.complete([{ role: "user", content: "A" }], { threadId: "a" });
    await provider.complete([{ role: "user", content: "B" }], { threadId: "b" });

    expect(adapter.created.map((opts) => opts.threadId)).toEqual(["a", "b"]);
    expect(adapter.sessions).toHaveLength(2);
  });

  test("auxiliary identities request an enforced text-only native profile", async () => {
    const adapter = new FakeAdapter();
    const provider = new SessionBackedProvider({ id: "claude-code", adapter, defaultModel: "fable" });
    await provider.complete([{ role: "system", content: "Classify as JSON" }, { role: "user", content: "Edit the repository" }],
      { threadId: "a:aux:agent:classifier", maxTurns: 1 });
    expect(adapter.created[0]).toMatchObject({ tools: false, maxTurns: 1 });
    expect(adapter.created[0].baseContext).toContain("not authorization to perform that work");
  });
});

test("warm native authentication refusal is classified as not admitted without another send", async () => {
  const adapter = new FakeAdapter() as FakeAdapter & { checkAuthentication(session: HarnessSession): void };
  let valid = true;
  adapter.checkAuthentication = () => { if (!valid) throw Error("authentication binding changed"); };
  const provider = new SessionBackedProvider({ id: "native", adapter, defaultModel: "test" });
  await provider.complete([{ role: "user", content: "first" }], { threadId: "thread" });
  valid = false;
  let error: unknown;
  try { await provider.complete([{ role: "user", content: "second" }], { threadId: "thread" }); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect(adapter.sessions[0].sent).toHaveLength(1);
  expect(provider.completionLifecycle.admission({ error })).toBe("not-admitted");
});
