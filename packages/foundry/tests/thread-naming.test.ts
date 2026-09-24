import { expect, test } from "bun:test";
import { Hono } from "hono";
import { ContextStack, EventStream, Executor, Harness, InterventionLog, Thread,
  type CompletionOpts, type LLMMessage, type LLMProvider } from "@inixiative/foundry-core";
import { registerRuntimeRoutes } from "../src/viewer/routes/runtime";
import { ConfigStore } from "../src/viewer/config";

function setup(id: string, description: string, complete: LLMProvider["complete"]) {
  const stack = new ContextStack();
  const thread = new Thread(id, stack, { description, cwd: "/qa/project" });
  thread.register(new Executor({ id: "worker", stack, handler: async () => "done" }));
  const harness = new Harness(thread);
  harness.setDefaultExecutor("worker");
  const app = new Hono();
  registerRuntimeRoutes(app, { harness, eventStream: new EventStream(),
    interventions: new InterventionLog(thread.signals), configStore: new ConfigStore("/tmp/unused-naming-config"),
    namingProvider: { id: "namer", complete } });
  const send = async () => {
    const response = await app.request("/api/messages", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Implement the requested change", threadId: id }) });
    expect(response.status).toBe(200);
    await Bun.sleep(1);
  };
  return { thread, send };
}

test("naming preserves an existing human title after startup", async () => {
  let calls = 0;
  const { thread, send } = setup("human-title", "My ongoing architecture work", async () => {
    calls++; return { model: "mock", content: '{"title":"Replacement"}' };
  });
  await send();
  expect(calls).toBe(0);
  expect(thread.meta.description).toBe("My ongoing architecture work");
});

test("naming an untitled thread has an isolated text-only auxiliary identity", async () => {
  let options: CompletionOpts | undefined;
  let input: LLMMessage[] = [];
  const { thread, send } = setup("unnamed", "", async (messages, opts) => {
    input = messages; options = opts; return { model: "mock", content: '{"title":"Implement requested change"}' };
  });
  await send();
  expect(options).toMatchObject({ threadId: "unnamed:aux:naming", cwd: "/qa/project", tools: false, maxTurns: 1 });
  expect(input[0].content).toContain("JSON");
  expect(thread.meta.description).toBe("Implement requested change");
});

test("a late generated title cannot overwrite a human rename", async () => {
  let finish!: (value: { model: string; content: string }) => void;
  const { thread, send } = setup("rename-race", "", () => new Promise(resolve => { finish = resolve; }));
  await send();
  thread.describe("Human renamed this");
  finish({ model: "mock", content: '{"title":"Generated title"}' });
  await Bun.sleep(1);
  expect(thread.meta.description).toBe("Human renamed this");
});

test("thread object replacement does not inherit another object's naming state", async () => {
  let calls = 0;
  const complete: LLMProvider["complete"] = async () => {
    calls++; return { model: "mock", content: '{"title":"Generated title"}' };
  };
  const first = setup("restored-id", "", complete);
  await first.send();
  first.thread.dispose();
  const restored = setup("restored-id", "", complete);
  await restored.send();
  expect(calls).toBe(2);
  expect(restored.thread.meta.description).toBe("Generated title");
});

test("failed naming remains retryable without retaining an in-flight marker", async () => {
  let calls = 0;
  const { thread, send } = setup("naming-retry", "", async () => {
    if (++calls === 1) throw new Error("temporary provider failure");
    return { model: "mock", content: '{"title":"Recovered title"}' };
  });
  await send();
  await send();
  expect(calls).toBe(2);
  expect(thread.meta.description).toBe("Recovered title");
});

test("a naming completion does not mutate a disposed thread", async () => {
  let finish!: (value: { model: string; content: string }) => void;
  const { thread, send } = setup("disposed-name", "", () => new Promise(resolve => { finish = resolve; }));
  await send();
  thread.dispose();
  finish({ model: "mock", content: '{"title":"Too late"}' });
  await Bun.sleep(1);
  expect(thread.meta.description).toBe("");
});
