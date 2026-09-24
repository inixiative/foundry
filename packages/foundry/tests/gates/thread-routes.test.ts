import { expect, test } from "bun:test";
import { Hono } from "hono";
import { ContextStack, EventStream, Executor, Harness, InterventionLog } from "@inixiative/foundry-core";
import { ThreadFactory } from "../../src/agents/thread-factory";
import { ThreadRuntimeManager } from "../../src/agents/thread-runtime";
import { ProjectRegistry } from "../../src/agents/project";
import { registerRuntimeRoutes } from "../../src/viewer/routes/runtime";
import { ConfigStore, starterConfig } from "../../src/viewer/config";

function setup() {
  const stack = new ContextStack([]);
  const worker = new Executor({ id: "worker", stack, handler: async () => "done" });
  const events = new EventStream();
  const runtime = new ThreadRuntimeManager({ config: starterConfig("mock", "mock"), eventStream: events,
    llm: { id: "mock", complete: async () => ({ model: "mock", content: "{}" }) }, domains: [], log: () => {}, warn: () => {},
  });
  const factory = new ThreadFactory({ stack, agents: new Map([[worker.id, worker]]), runtime });
  const main = factory.create("main", { cwd: "/qa/harness" });
  const registry = new ProjectRegistry();
  const project = registry.register({ id: "project", path: "/qa/sample-project", label: "Sample project", tags: [], runtime: "claude-code" });
  const app = new Hono();
  registerRuntimeRoutes(app, { harness: new Harness(main), eventStream: events, interventions: new InterventionLog(main.signals),
    threadFactory: factory, projectRegistry: registry, db: null, configStore: new ConfigStore("/tmp/foundry-gate-unused-config") });
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { runtime, project, post };
}

test("G2: a project-created thread executes in that project's directory", async () => {
  const { runtime, project, post } = setup();
  try {
    const response = await post("/api/threads", { id: "created", projectId: project.id });
    expect(response.status).toBe(201);
    expect((await response.json()).meta.cwd).toBe(project.path);
    expect(project.threads.get("created")!.meta.cwd).toBe(project.path);
  } finally { runtime.disposeAll(); }
});

test("G2: an unknown project cannot create an unreachable runtime", async () => {
  const { runtime, post } = setup();
  try {
    const before = runtime.runtimes.size;
    const response = await post("/api/threads", { id: "orphan", projectId: "missing" });
    expect(response.status).toBe(404);
    expect(runtime.runtimes.size).toBe(before);
  } finally { runtime.disposeAll(); }
});

test("G2: duplicate creation returns a conflict without replacing a live thread", async () => {
  const { runtime, project, post } = setup();
  try {
    await post("/api/threads", { id: "same", projectId: project.id });
    const original = project.threads.get("same");
    const response = await post("/api/threads", { id: "same", projectId: project.id });
    expect(response.status).toBe(409);
    expect(project.threads.get("same")).toBe(original);
  } finally { runtime.disposeAll(); }
});

test("G2: fork of an unknown source creates no runtime", async () => {
  const { runtime, post } = setup();
  try {
    const before = runtime.runtimes.size;
    const response = await post("/api/threads/missing/fork", { copyCount: 1 });
    expect(response.status).toBe(404);
    expect(runtime.runtimes.size).toBe(before);
  } finally { runtime.disposeAll(); }
});
