import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { ContextStack, EventStream, Harness, InterventionLog, type LLMProvider } from "@inixiative/foundry-core";
import { buildAgents, buildLayers, ThreadFactory } from "../src/agents/thread-factory";
import { ThreadRuntimeManager } from "../src/agents/thread-runtime";
import { ProjectRegistry } from "../src/agents/project";
import { ConfigStore, starterConfig } from "../src/viewer/config";
import { registerRuntimeRoutes } from "../src/viewer/routes/runtime";
import { withStreams } from "./helpers/data-stream";

for (const operation of ["create", "fork"] as const) {
  test(`HTTP ${operation} resolves saved project experts before runtime ownership is captured`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "foundry-project-route-"));
    let runtime: ThreadRuntimeManager | undefined;
    try {
      const config = starterConfig("controlled", "controlled");
      config.layers = {
        reference: { id: "reference", domain: "compatibility", segment: "domain-knowledge",
          prompt: "Compatibility evidence", writers: ["expert"], sourceIds: [], staleness: 0, enabled: true },
      };
      config.agents = {
        worker: { id: "worker", kind: "executor", prompt: "Implement", provider: "controlled",
          model: "controlled", visibleLayers: [], peers: [], maxDepth: 1, enabled: true },
        expert: { id: "expert", kind: "decider", flowRole: "domain-advising", domain: "compatibility",
          prompt: "Global expert", provider: "controlled", model: "controlled", tools: false,
          visibleLayers: ["reference"], ownedLayers: ["reference"], peers: [], maxDepth: 1, enabled: true },
      };
      config.projects.P = { id: "P", path: dir, agents: { expert: { enabled: false } },
        layers: { reference: { enabled: false } } };
      const store = new ConfigStore(dir);
      await store.save(config);
      const saved = await new ConfigStore(dir).load();
      let calls = 0;
      const llm: LLMProvider = { id: "controlled", async complete() {
        calls++;
        throw Error("Creating a thread must not call a model");
      } };
      const events = new EventStream();
      const layerDeps = { sourceResolver: () => null };
      const stack = new ContextStack(buildLayers(saved, layerDeps));
      const agentDeps = { provider: llm };
      runtime = new ThreadRuntimeManager({ config: saved, llm, eventStream: events, log() {}, warn() {} });
      const capturedOwner = (id: string) => Reflect.get(runtime!.get(id)!, "owner") as Readonly<{ projectId?: string }>;
      const factory = new ThreadFactory({ stack, agents: buildAgents(saved, stack, agentDeps), runtime,
        configuration: { config: saved, layers: layerDeps, agents: agentDeps } });
      const main = factory.create("main");
      expect([...runtime.get(main.id)!.domainLibrarians.keys()]).toEqual(["compatibility"]);
      const registry = new ProjectRegistry();
      const project = registry.register({ id: "P", path: dir, label: "Project", tags: [], runtime: "claude-code" });
      const source = factory.create("source", { projectId: project.id, cwd: dir });
      project.addThread(source);
      expect(capturedOwner(source.id).projectId).toBe(project.id);
      expect(runtime.get(source.id)!.domainLibrarians.size).toBe(0);
      const app = new Hono();
      registerRuntimeRoutes(app, withStreams({ harness: new Harness(main), eventStream: events,
        interventions: new InterventionLog(main.signals), threadFactory: factory,
        projectRegistry: registry, db: null, configStore: store }));
      const response = await app.request(operation === "create" ? "/api/threads" : "/api/threads/source/fork", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(operation === "create" ? { id: "created", projectId: project.id } : { copyCount: 1 }),
      });
      expect(response.status).toBe(201);
      const body = await response.json() as { threadId: string };
      const thread = project.threads.get(body.threadId)!;
      expect(thread.meta.projectId).toBe(project.id);
      const owned = runtime.get(thread.id)!;
      expect({ projectId: capturedOwner(thread.id).projectId, experts: [...owned.domainLibrarians.keys()] })
        .toEqual({ projectId: project.id, experts: [] });
      expect(thread.stack.getLayer("reference")).toBeUndefined();
      expect(calls).toBe(0);
    } finally {
      runtime?.disposeAll();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
