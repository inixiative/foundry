import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ToolRegistry,
  type CompletionOpts,
  type CompletionResult,
  type Harness,
  type LLMMessage,
  type LLMProvider,
} from "@inixiative/foundry-core";
import { AIAssist } from "../src/viewer/ai-assist";
import { ConfigStore, createProject, defaultConfig } from "../src/viewer/config";
import {
  FoundrySelfChatStore,
  type SelfChatFocus,
} from "../src/viewer/foundry-self-chat";
import { registerControlRoutes } from "../src/viewer/routes/control";
import { ActionHandler } from "../src/viewer/actions";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

interface RecordedCall {
  messages: LLMMessage[];
  opts?: CompletionOpts;
}

function makeRecorderLLM(reply: string): {
  provider: LLMProvider;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const provider: LLMProvider = {
    id: "recorder",
    async complete(messages, opts): Promise<CompletionResult> {
      calls.push({ messages, opts });
      return {
        content: reply,
        model: opts?.model ?? "mock",
        tokens: { input: 100, output: 50 },
      };
    },
  };
  return { provider, calls };
}

function stubHarness(): Harness {
  return {
    thread: {
      agents: new Map(),
      stack: { layers: [] },
    },
  } as unknown as Harness;
}

function stubActions(harness: Harness): ActionHandler {
  return new ActionHandler({
    harness,
    eventStream: { push() {}, subscribe: () => () => {} } as any,
    interventions: { log: () => {} } as any,
  });
}

// ---------------------------------------------------------------------------
// FoundrySelfChatStore — disk persistence
// ---------------------------------------------------------------------------

describe("FoundrySelfChatStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foundry-self-chat-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("load() on missing file yields empty array", async () => {
    const store = new FoundrySelfChatStore(join(dir, "chat.json"));
    await store.load();
    expect(store.messages).toEqual([]);
  });

  test("append() persists and survives reload", async () => {
    const path = join(dir, "chat.json");
    const store = new FoundrySelfChatStore(path);
    await store.append({ role: "user", content: "hello", ts: 1 });
    await store.append({ role: "assistant", content: "hi", ts: 2 });

    const reloaded = new FoundrySelfChatStore(path);
    await reloaded.load();
    expect(reloaded.messages.length).toBe(2);
    expect(reloaded.messages[0].content).toBe("hello");
    expect(reloaded.messages[1].role).toBe("assistant");
  });

  test("append() creates parent directory if missing", async () => {
    const store = new FoundrySelfChatStore(join(dir, "nested", "deep", "chat.json"));
    await store.append({ role: "user", content: "first", ts: 1 });
    expect(store.messages[0].content).toBe("first");
  });

  test("clear() resets to empty and persists", async () => {
    const path = join(dir, "chat.json");
    const store = new FoundrySelfChatStore(path);
    await store.append({ role: "user", content: "a", ts: 1 });
    await store.append({ role: "user", content: "b", ts: 2 });
    await store.clear();
    expect(store.messages).toEqual([]);

    const reloaded = new FoundrySelfChatStore(path);
    await reloaded.load();
    expect(reloaded.messages).toEqual([]);
  });

  test("preserves insertion order", async () => {
    const store = new FoundrySelfChatStore(join(dir, "chat.json"));
    for (let i = 0; i < 10; i++) {
      await store.append({ role: "user", content: `m${i}`, ts: i });
    }
    expect(store.messages.map((m) => m.content)).toEqual(
      Array.from({ length: 10 }, (_, i) => `m${i}`),
    );
  });

  test("tolerates corrupt JSON by starting empty", async () => {
    const path = join(dir, "chat.json");
    writeFileSync(path, "not valid json{{{");
    const store = new FoundrySelfChatStore(path);
    await store.load();
    expect(store.messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AIAssist.chat() — focus framing + history passing
// ---------------------------------------------------------------------------

describe("AIAssist.chat()", () => {
  test("system prompt names default executor model", async () => {
    const { provider, calls } = makeRecorderLLM("ok");
    const assist = new AIAssist(provider, "claude-sonnet-4-6");
    const cfg = defaultConfig();
    cfg.defaults.provider = "anthropic";
    cfg.defaults.model = "claude-sonnet-4-6";

    await assist.chat(cfg, [], "hi", {});

    const system = calls[0].messages.find((m) => m.role === "system")!;
    expect(system.content).toContain("anthropic/claude-sonnet-4-6");
  });

  test("user message carries [viewing: ...] header when focus is set", async () => {
    const { provider, calls } = makeRecorderLLM("ok");
    const assist = new AIAssist(provider);

    const focus: SelfChatFocus = {
      scope: "project",
      projectId: "proj1",
      tab: "sources",
      focusKind: "source",
      focusId: "sys-prompt",
    };
    await assist.chat(defaultConfig(), [], "please help", focus);

    const user = calls[0].messages[calls[0].messages.length - 1];
    expect(user.role).toBe("user");
    expect(user.content).toContain("[viewing:");
    expect(user.content).toContain("scope=project");
    expect(user.content).toContain("project=proj1");
    expect(user.content).toContain("tab=sources");
    expect(user.content).toContain("focus=source:sys-prompt");
    expect(user.content).toContain("please help");
  });

  test("no header when focus is empty", async () => {
    const { provider, calls } = makeRecorderLLM("ok");
    const assist = new AIAssist(provider);

    await assist.chat(defaultConfig(), [], "plain", {});
    const user = calls[0].messages[calls[0].messages.length - 1];
    expect(user.content).toBe("plain");
  });

  test("passes history (user/assistant) in order and strips system roles", async () => {
    const { provider, calls } = makeRecorderLLM("ok");
    const assist = new AIAssist(provider);

    const history = [
      { role: "user" as const, content: "turn1", ts: 1 },
      { role: "assistant" as const, content: "reply1", ts: 2 },
      { role: "system" as const, content: "error happened", ts: 3 },
      { role: "user" as const, content: "turn2", ts: 4 },
      { role: "assistant" as const, content: "reply2", ts: 5 },
    ];

    await assist.chat(defaultConfig(), history, "now", {});

    const msgs = calls[0].messages;
    // system prompt + 4 history turns (system-role filtered) + current user
    expect(msgs.length).toBe(6);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].content).toBe("turn1");
    expect(msgs[2].content).toBe("reply1");
    expect(msgs[3].content).toBe("turn2");
    expect(msgs[4].content).toBe("reply2");
    expect(msgs[5].content).toBe("now");
  });

  test("focus detail embeds focused config object as JSON", async () => {
    const { provider, calls } = makeRecorderLLM("ok");
    const assist = new AIAssist(provider);

    const cfg = defaultConfig();
    cfg.projects["myproj"] = {
      id: "myproj",
      path: "/tmp/fake",
      label: "My Project",
      sources: {
        "sys-prompt": {
          id: "sys-prompt",
          type: "inline",
          uri: "You are a helpful assistant.",
          enabled: true,
        },
      },
    } as any;

    await assist.chat(cfg, [], "help", {
      scope: "project",
      projectId: "myproj",
      focusKind: "source",
      focusId: "sys-prompt",
    });

    const system = calls[0].messages.find((m) => m.role === "system")!;
    expect(system.content).toContain("Active project: My Project");
    expect(system.content).toContain("currently looking at");
    expect(system.content).toContain("sys-prompt");
    expect(system.content).toContain("helpful assistant");
  });

  test("returns reply + tokens from provider", async () => {
    const { provider } = makeRecorderLLM("here is the answer");
    const assist = new AIAssist(provider);

    const result = await assist.chat(defaultConfig(), [], "q", {});
    expect(result.reply).toBe("here is the answer");
    expect(result.tokens).toEqual({ input: 100, output: 50 });
  });

  test("routes through tool-use loop when tools are provided", async () => {
    // Scripted provider: first turn requests a tool call, second turn returns text.
    const replies: CompletionResult[] = [
      {
        content: "",
        model: "mock",
        tokens: { input: 10, output: 5 },
        toolCalls: [
          { id: "t1", name: "mock_exec", input: { command: "ls" } },
        ],
      },
      {
        content: "saw the files — here is the summary",
        model: "mock",
        tokens: { input: 20, output: 10 },
      },
    ];
    let turn = 0;
    const captured: Array<{ messages: LLMMessage[]; opts?: CompletionOpts }> = [];
    const provider: LLMProvider = {
      id: "scripted",
      async complete(messages, opts) {
        captured.push({ messages, opts });
        return replies[turn++] ?? replies[replies.length - 1];
      },
    };

    // Minimal shell-kind tool: the toolUseLoop dispatches "mock_exec" → tool.exec().
    const tool = {
      id: "mock",
      kind: "shell" as const,
      capability: "shell:exec" as const,
      async exec(cmd: string) {
        return { ok: true, summary: `ran: ${cmd}`, data: { stdout: "file1\nfile2" } };
      },
    };
    const tools = new ToolRegistry();
    tools.register(tool as any, "mock shell");

    const toolCalls: Array<{ name: string; result: string }> = [];
    const assist = new AIAssist(provider);
    const result = await assist.chat(defaultConfig(), [], "list the files", {}, {
      tools,
      onToolCall: (name, _input, r) => toolCalls.push({ name, result: r }),
    });

    expect(turn).toBe(2); // two provider calls: tool-call turn + final-text turn
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].name).toBe("mock_exec");
    expect(result.reply).toBe("saw the files — here is the summary");

    // System prompt mentions tool availability
    const sys = captured[0].messages.find((m) => m.role === "system")!;
    expect(sys.content).toContain("tool surface");

    // Second provider call sees the assistant tool-call turn and the tool-result user turn.
    const secondMsgs = captured[1].messages;
    expect(secondMsgs.some((m) => m.role === "user" && m.content.includes("file1"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Control routes — /api/browse, /api/files, /api/self-chat
// ---------------------------------------------------------------------------

describe("control routes", () => {
  let configDir: string;
  let projectDir: string;
  let configStore: ConfigStore;
  let app: Hono;
  let llmReply: string;
  let aiAssist: AIAssist;
  let recorder: { provider: LLMProvider; calls: RecordedCall[] };

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "foundry-cfg-"));
    projectDir = mkdtempSync(join(tmpdir(), "foundry-proj-"));

    configStore = new ConfigStore(configDir);
    await configStore.load();
    const project = createProject(projectDir, { label: "Test" });
    await configStore.patch("projects", { [project.id]: project });

    llmReply = "pretend assistant reply";
    recorder = makeRecorderLLM(llmReply);
    aiAssist = new AIAssist(recorder.provider);

    const harness = stubHarness();
    app = new Hono();
    registerControlRoutes(app, {
      harness,
      actions: stubActions(harness),
      configStore,
      aiAssist,
      analyticsStore: null,
      actionQueue: null,
      tunnelHolder: { tunnel: null },
      port: 4400,
      selfChatDir: configDir,
    });
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  // -- /api/browse --

  test("GET /api/browse?files=1 includes files in response", async () => {
    writeFileSync(join(projectDir, "a.md"), "a");
    writeFileSync(join(projectDir, "b.md"), "b");
    mkdirSync(join(projectDir, "sub"));

    const res = await app.fetch(
      new Request(
        `http://test/api/browse?path=${encodeURIComponent(projectDir)}&files=1`,
      ),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.files).toContain("a.md");
    expect(data.files).toContain("b.md");
    expect(data.dirs).toContain("sub");
  });

  test("GET /api/browse without files=1 omits files", async () => {
    writeFileSync(join(projectDir, "a.md"), "a");
    const res = await app.fetch(
      new Request(`http://test/api/browse?path=${encodeURIComponent(projectDir)}`),
    );
    const data = await res.json();
    expect(data.files).toEqual([]);
  });

  // -- /api/files read/write --

  test("GET /api/files returns content for allowed path", async () => {
    const target = join(projectDir, "doc.md");
    writeFileSync(target, "hello\nworld");
    const res = await app.fetch(
      new Request(`http://test/api/files?path=${encodeURIComponent(target)}`),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.content).toBe("hello\nworld");
    expect(data.size).toBeGreaterThan(0);
    expect(data.path).toBe(resolve(target));
  });

  test("GET /api/files rejects path outside allowed roots with 403", async () => {
    const outside = mkdtempSync(join(tmpdir(), "foundry-outside-"));
    try {
      const target = join(outside, "secret.md");
      writeFileSync(target, "nope");
      const res = await app.fetch(
        new Request(`http://test/api/files?path=${encodeURIComponent(target)}`),
      );
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toContain("outside allowed roots");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("GET /api/files with missing path query returns 400", async () => {
    const res = await app.fetch(new Request("http://test/api/files"));
    expect(res.status).toBe(400);
  });

  test("PUT /api/files writes content and round-trips", async () => {
    const target = join(projectDir, "nested", "new.md");
    const writeRes = await app.fetch(
      new Request("http://test/api/files", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target, content: "written content" }),
      }),
    );
    expect(writeRes.status).toBe(200);
    const writeData = await writeRes.json();
    expect(writeData.ok).toBe(true);

    const readRes = await app.fetch(
      new Request(`http://test/api/files?path=${encodeURIComponent(target)}`),
    );
    const readData = await readRes.json();
    expect(readData.content).toBe("written content");
  });

  test("PUT /api/files rejects path outside allowed roots", async () => {
    const outside = mkdtempSync(join(tmpdir(), "foundry-outside-"));
    try {
      const target = join(outside, "evil.md");
      const res = await app.fetch(
        new Request("http://test/api/files", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: target, content: "x" }),
        }),
      );
      expect(res.status).toBe(403);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("PUT /api/files rejects oversized content", async () => {
    const target = join(projectDir, "big.md");
    const huge = "x".repeat(2_000_001);
    const res = await app.fetch(
      new Request("http://test/api/files", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target, content: huge }),
      }),
    );
    expect(res.status).toBe(400);
  });

  // -- /api/self-chat --

  test("GET /api/self-chat returns empty initially", async () => {
    const res = await app.fetch(new Request("http://test/api/self-chat"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.messages).toEqual([]);
  });

  test("POST /api/self-chat appends user + assistant turns", async () => {
    const res = await app.fetch(
      new Request("http://test/api/self-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello", focus: { scope: "global" } }),
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.messages.length).toBe(2);
    expect(data.messages[0].role).toBe("user");
    expect(data.messages[0].content).toBe("hello");
    expect(data.messages[1].role).toBe("assistant");
    expect(data.messages[1].content).toBe(llmReply);
    expect(data.messages[1].tokens).toEqual({ input: 100, output: 50 });
  });

  test("POST /api/self-chat passes focus into the LLM call", async () => {
    await app.fetch(
      new Request("http://test/api/self-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "configure this",
          focus: { scope: "project", projectId: "x", focusKind: "agent", focusId: "executor" },
        }),
      }),
    );
    expect(recorder.calls.length).toBe(1);
    const user = recorder.calls[0].messages[recorder.calls[0].messages.length - 1];
    expect(user.content).toContain("[viewing:");
    expect(user.content).toContain("focus=agent:executor");
    expect(user.content).toContain("configure this");
  });

  test("POST /api/self-chat rejects empty text with 400", async () => {
    const res = await app.fetch(
      new Request("http://test/api/self-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "   " }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("DELETE /api/self-chat clears history", async () => {
    await app.fetch(
      new Request("http://test/api/self-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      }),
    );

    const clearRes = await app.fetch(
      new Request("http://test/api/self-chat", { method: "DELETE" }),
    );
    expect(clearRes.status).toBe(200);
    const data = await clearRes.json();
    expect(data.messages).toEqual([]);

    const afterRes = await app.fetch(new Request("http://test/api/self-chat"));
    expect((await afterRes.json()).messages).toEqual([]);
  });

  test("POST /api/self-chat with assistTools routes through tool-use loop", async () => {
    // Rebuild the app with a scripted provider + real ToolRegistry.
    rmSync(join(configDir, "foundry-self-chat.json"), { force: true });

    const toolReplies: CompletionResult[] = [
      {
        content: "",
        model: "mock",
        tokens: { input: 5, output: 2 },
        toolCalls: [{ id: "t1", name: "mock_exec", input: { command: "pwd" } }],
      },
      { content: "done", model: "mock", tokens: { input: 5, output: 3 } },
    ];
    let t = 0;
    const scriptedProvider: LLMProvider = {
      id: "scripted",
      async complete() {
        return toolReplies[t++] ?? toolReplies[toolReplies.length - 1];
      },
    };

    const dispatched: string[] = [];
    const tool = {
      id: "mock",
      kind: "shell" as const,
      capability: "shell:exec" as const,
      async exec(cmd: string) {
        dispatched.push(cmd);
        return { ok: true, summary: `ok: ${cmd}` };
      },
    };
    const tools = new ToolRegistry();
    tools.register(tool as any, "mock shell");

    const scriptedAssist = new AIAssist(scriptedProvider);
    const harness = stubHarness();
    const scriptedApp = new Hono();
    registerControlRoutes(scriptedApp, {
      harness,
      actions: stubActions(harness),
      configStore,
      aiAssist: scriptedAssist,
      analyticsStore: null,
      actionQueue: null,
      tunnelHolder: { tunnel: null },
      port: 4400,
      selfChatDir: configDir,
      assistTools: tools,
    });

    const res = await scriptedApp.fetch(
      new Request("http://test/api/self-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "where am I?" }),
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.messages.length).toBe(2);
    expect(data.messages[1].content).toBe("done");
    expect(dispatched).toEqual(["pwd"]);
  });

  test("POST /api/self-chat includes prior history on subsequent turn", async () => {
    await app.fetch(
      new Request("http://test/api/self-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "first" }),
      }),
    );
    await app.fetch(
      new Request("http://test/api/self-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "second" }),
      }),
    );

    // Second call's messages should include first user + assistant turns as history
    const secondCall = recorder.calls[1];
    const contents = secondCall.messages.map((m) => m.content);
    expect(contents.some((c) => c.includes("first"))).toBe(true);
    expect(contents.some((c) => c === llmReply)).toBe(true);
    expect(contents.some((c) => c.includes("second"))).toBe(true);
  });
});
