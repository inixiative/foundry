import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStack, EventStream, Harness, InterventionLog, type LLMProvider } from "@inixiative/foundry-core";
import { buildAgents, ThreadFactory } from "../../src/agents/thread-factory";
import { ConfigStore, starterConfig } from "../../src/viewer/config";
import { createViewer } from "../../src/viewer/server";

export async function completionFixture() {
  const dir = mkdtempSync(join(tmpdir(), "foundry-completion-persistence-"));
  const output = "COMPLETED-OUTPUT: the executor finished this work once.";
  let calls = 0;
  const inputs: unknown[] = [];
  const provider: LLMProvider = { id: "mock",
    complete: async messages => { calls++; inputs.push(messages.at(-1)?.content); return { content: output, model: "mock" }; },
    stream: async function* (messages) { calls++; inputs.push(messages.at(-1)?.content); yield { type: "text", text: output }; },
  };
  const config = starterConfig("mock", "mock");
  config.setupComplete = true;
  config.agents = { worker: { id: "worker", kind: "executor", provider: "mock", model: "mock", prompt: "Execute",
    temperature: 0, maxTokens: 256, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
  const configStore = new ConfigStore(dir); await configStore.save(config);
  const runtimes: Array<{ close: () => void }> = [];
  const make = () => {
    const stack = new ContextStack();
    const factory = new ThreadFactory({ stack, agents: buildAgents(config, stack, { provider }) });
    const thread = factory.create("main");
    const harness = new Harness(thread); harness.setDefaultExecutor("worker");
    const viewer = createViewer({ harness, eventStream: new EventStream(), interventions: new InterventionLog(thread.signals),
      configStore, configDir: dir, threadFactory: factory });
    const sql = (viewer.localStore as unknown as { db: Database }).db;
    // Abort the response insert after the successful trace insert: exercise rollback.
    sql.exec(`CREATE TEMP TRIGGER reject_completed_message BEFORE INSERT ON session_messages
      WHEN NEW.actor = 'agent' BEGIN SELECT RAISE(ABORT, 'COMPLETION-COMMIT-ERROR'); END`);
    let failureWrites = 0;
    viewer.localStore!.failTurn = () => { failureWrites++; throw new Error("MUST-NOT-TRY-SECOND-WRITE"); };
    let closed = false;
    const close = () => {
      if (closed) return; closed = true;
      viewer.localStore!.close(); for (const t of viewer.directory.all()) t.dispose();
    };
    const runtime = { ...viewer, thread, harness, failureWrites: () => failureWrites, close };
    runtimes.push(runtime);
    return runtime;
  };
  return { make, output, calls: () => calls, inputs: () => [...inputs], close: () => {
    for (const runtime of runtimes) runtime.close();
    rmSync(dir, { force: true, recursive: true });
  } };
}
