import { Database } from "bun:sqlite";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { ContextLayer, ContextStack, EventStream, Harness, InterventionLog, ToolRegistry,
  type CompletionOpts, type LLMMessage, type LLMProvider, type ScriptTool, type ScriptResult, type Signal, type ToolResult } from "@inixiative/foundry-core";
import { ThreadFactory, buildAgents } from "../../src/agents/thread-factory";
import { ThreadRuntimeManager, type LearningConfig } from "../../src/agents/thread-runtime";
import { ConfigStore, starterConfig } from "../../src/viewer/config";
import { createViewer } from "../../src/viewer/server";
import { ProjectRegistry } from "../../src/agents/project";

export const domains = ["architecture", "testing"] as const;
export type Domain = typeof domains[number];
export const instructions = (d: Domain) => `INSTRUCTIONS_${d}: assess only your expert interpretation; preserve compatibility.`;
export const domainKnowledge = (d: Domain) => d === "architecture"
  ? "DOMAIN_ARCH: prefer additive schema evolution and maintain old readers."
  : "DOMAIN_TEST: verify legacy projections with an executable regression.";
export const interpretation = (thread: string, d: Domain) => d === "architecture"
  ? `ARCH_${thread}: preserve display_name alias while adding preferred_name; expand before contract.`
  : `TEST_${thread}: retain a display_name projection regression when preferred_name is populated.`;
export const privateReason = (thread: string, d: Domain) => `PRIVATE_${thread}_${d}_RATIONALE`;
export const abstain = JSON.stringify({ decision: "abstain", reason: "No additional owned interpretation." });
export const learned = (thread: string, d: Domain) => JSON.stringify({ decision: "learn", knowledge: interpretation(thread, d),
  facts: [interpretation(thread, d)], reason: privateReason(thread, d) });

export interface Call { phase: "pre" | "post" | "route" | "central"; thread: string; domain?: Domain;
  messages: LLMMessage[]; options: Pick<CompletionOpts, "threadId" | "model" | "maxTokens" | "tools" | "timeout" | "maxTurns">; response?: string }
export function gate<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
export async function bounded<T>(promise: Promise<T>, label: string, ms = 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`M0 observation deadline: ${label}`)), ms); })]); }
  finally { clearTimeout(timer); }
}
export async function until(predicate: () => boolean, label: string, ms = 1500) {
  const deadline = performance.now() + ms;
  while (!predicate()) { if (performance.now() >= deadline) throw Error(`M0 observation deadline: ${label}`); await Bun.sleep(1); }
}
export interface ScenarioOptions { learning?: LearningConfig; review?: (call: Call) => string | Promise<string>; failExecutor?: boolean }

/** No model calls. Production factory, tool loop, HTTP dispatch, runtime and SQLite;
 * only reviewer/central model answers and the finite fixture migration tool are controlled. */
export async function m0Scenario(options: ScenarioOptions = {}) {
  const parent = process.env.FOUNDRY_M0_OUTPUT_DIR ?? join(process.cwd(), ".foundry/qa");
  await mkdir(parent, { recursive: true }); const dir = await mkdtemp(join(parent, "m0-domain-loop-"));
  const calls: Call[] = [], signals: Array<{ thread: string; signal: Signal }> = [], turns: unknown[] = [], checkpoints: unknown[] = [];
  const closers: Array<() => void> = []; const releases: Array<() => void> = [];
  let active: Awaited<ReturnType<typeof construct>>;
  async function construct() {
    const config = starterConfig("controlled", "controlled"); config.setupComplete = true;
    const projects = new ProjectRegistry();
    for (const id of ["P", "Q"]) { const path = join(dir, id); await mkdir(path, { recursive: true });
      config.projects[id] = { id, path }; projects.register({ id, path, label: id, tags: [], runtime: "claude-code" }); }
    config.agents = { worker: { id: "worker", kind: "executor", provider: "controlled", model: "controlled", prompt: "Perform the requested bounded migration.",
      temperature: 0, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
    const stack = new ContextStack(domains.map(d => { const layer = new ContextLayer({ id: d, prompt: instructions(d), segment: "domain-knowledge" }); layer.set(domainKnowledge(d)); return layer; }));
    const tools = new ToolRegistry();
    const sql = new Database(join(dir, "migration.sqlite"));
    sql.exec("CREATE TABLE IF NOT EXISTS people (thread TEXT PRIMARY KEY, display_name TEXT NOT NULL)");
    const migration: ScriptTool = { id: "migration", kind: "script", capability: "data:write",
      async evaluate<T>(code: string): Promise<ToolResult<ScriptResult<T>>> {
        if (!/^migrate:(a|b|outside)$/.test(code)) throw Error("Unapproved fixture operation");
        const thread = code.slice(8); sql.query("INSERT OR IGNORE INTO people(thread,display_name) VALUES (?, 'Ada')").run(thread);
        const columns = sql.query("PRAGMA table_info(people)").all() as { name: string }[];
        if (!columns.some(c => c.name === "preferred_name")) sql.exec("ALTER TABLE people ADD COLUMN preferred_name TEXT");
        sql.query("UPDATE people SET preferred_name=display_name WHERE thread=?").run(thread);
        const row = sql.query("SELECT display_name,preferred_name FROM people WHERE thread=?").get(thread) as { display_name: string; preferred_name: string };
        if (row.display_name !== "Ada" || row.preferred_name !== "Ada") throw Error("Legacy-read regression failed");
        const observation = `MIGRATION_APPLIED owner=${thread}; legacy display_name=Ada; preferred_name=Ada; legacy-read=PASS`;
        return { ok: true, data: { result: { ...row, observation } as T, logs: [], durationMs: 0 }, summary: observation };
      } };
    tools.register(migration, "Finite controlled additive SQLite migration and legacy-read regression; no arbitrary evaluation");
    const copyCall = (phase: Call["phase"], messages: LLMMessage[], opts: CompletionOpts = {}, domain?: Domain): Call => {
      const call: Call = { phase, thread: opts.threadId?.split(":aux:")[0] ?? "missing", domain,
        messages: structuredClone(messages), options: { threadId: opts.threadId, model: opts.model, maxTokens: opts.maxTokens, tools: opts.tools, timeout: opts.timeout, maxTurns: opts.maxTurns } };
      calls.push(call); return call;
    };
    const provider: LLMProvider = { id: "controlled", async complete(messages, opts = {}) {
      const call = copyCall("central", messages, opts);
      if (options.failExecutor) throw Error("CONTROLLED_EXECUTOR_FAILURE");
      const user = messages.find(m => m.role === "user")?.content ?? "";
      const toolReply = messages.findLast(m => m.role === "user" && m.content.startsWith("[Tool Result "));
      if (user === "Perform the migration" && !toolReply) return { model: "controlled", content: "", toolCalls: [
        { id: `migration-${opts.threadId}`, name: "migration_evaluate", input: { code: `migrate:${opts.threadId}` } }] };
      const result = toolReply?.content ?? "CONTINUED_WITHOUT_REPEATING_MIGRATION";
      call.response = result; return { model: "controlled", content: result };
    } };
    const llm: LLMProvider = { id: "controlled-domain", async complete(messages, opts = {}) {
      const id = opts.threadId ?? ""; const domain = domains.find(d => id.endsWith(`:domain:${d}`));
      const phase = id.endsWith(":cartographer") ? "route" : id.includes(":review:") ? "post" : "pre";
      const call = copyCall(phase, messages, opts, domain);
      let content: string;
      if (phase === "route") content = JSON.stringify({ domains, layers: domains, confidence: 1 });
      else if (!domain) throw Error("Unowned expert request");
      else if (phase === "pre") content = JSON.stringify({ layers: [domain], snippets: [`${domain} guidance: ${domainKnowledge(domain)}`], confidence: 1 });
      else if (options.review) content = await options.review(call);
      else content = messages.some(m => m.content.includes("MIGRATION_APPLIED")) ? learned(call.thread, domain) : abstain;
      call.response = content; return { model: "controlled", content };
    } };
    const events = new EventStream();
    const manager = new ThreadRuntimeManager({ config, llm, eventStream: events, log() {}, warn() {},
      learning: { timeoutMs: 10, hardTimeoutMs: 1000, ...options.learning },
      domains: domains.map(d => ({ domain: d, layerId: d, guardTriggers: [], advisePrompt: `${instructions(d)} Advise with JSON layers/snippets/confidence.`,
        reviewPrompt: `${instructions(d)} You are the ${d} reviewer. Review actual completion evidence and replace only your thread interpretation with JSON decision/knowledge/facts/reason.` })) });
    const detach = manager.addSignalSink((signal, owner) => { signals.push({ thread: owner.threadId ?? "missing", signal: structuredClone(signal) }); });
    const factory = new ThreadFactory({ stack, runtime: manager, agents: buildAgents(config, stack, { provider, tools }) });
    const main = factory.create("a", { projectId: "P", cwd: join(dir, "P") }); projects.get("P")!.addThread(main);
    const harness = new Harness(main); harness.setDefaultExecutor("worker");
    const configStore = new ConfigStore(dir); await configStore.save(config);
    const viewer = createViewer({ harness, eventStream: events, interventions: new InterventionLog(main.signals), configStore, configDir: dir, threadFactory: factory, projectRegistry: projects });
    for (const [id, projectId] of [["b", "P"], ["outside", "Q"]]) if (!manager.get(id)) {
      const thread = factory.create(id, { projectId, cwd: join(dir, projectId) }); projects.get(projectId)!.addThread(thread); viewer.directory.add(thread); }
    let closed = false; const close = () => { if (closed) return; closed = true; manager.disposeAll(); detach(); viewer.localStore?.close(); sql.close(); };
    closers.push(close);
    return { ...viewer, manager, factory, stack, close };
  }
  try { active = await construct(); } catch (error) { for (const close of closers.reverse()) close(); throw error; }
  const inspect = () => ({ calls, signals, turns, checkpoints, knowledge: Object.fromEntries(["a", "b", "outside"].map(id => [id, active.localStore!.knowledge(id) ?? null])),
    learning: Object.fromEntries(["a", "b", "outside"].map(id => [id, active.localStore!.learningHistory(id)])) });
  return {
    dir, calls, signals, turns, releases, get current() { return active; },
    async send(thread: string, id: string, message = "Continue") {
      const response = await bounded(Promise.resolve(active.app.request("/api/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: thread, id, message }) })), id);
      const body = await response.json(); const record = { thread, id, message, status: response.status, body: structuredClone(body), trace: active.localStore!.traceForTurn(id) };
      turns.push(record); return record;
    },
    async settled(thread = "a") { await bounded(active.manager.get(thread)!.learningSettled(), `learning ${thread}`); },
    async committed(thread: string, domain: Domain) {
      await until(() => signals.some(s => s.thread === thread && s.signal.kind === "domain_learning" && (s.signal.content as any).domain === domain && (s.signal.content as any).decision === "learned"), `owned commit ${thread}/${domain}`);
    },
    async checkpoint(label: string) { checkpoints.push({ label, at: Date.now() }); await Bun.write(join(dir, "evidence.json"), JSON.stringify(inspect(), null, 2)); },
    async restart() { await this.checkpoint("before reconstruction"); active.close(); active = await construct(); await this.checkpoint("after reconstruction"); },
    async close() { for (const release of releases) release(); await Promise.allSettled(["a", "b", "outside"].map(id => active.manager.get(id)?.learningSettled()));
      await this.checkpoint("final before cleanup"); for (const close of closers.reverse()) close(); await Bun.write(join(dir, "cleanup.json"), JSON.stringify({ runtimesDisposed: ["a", "b", "outside"].every(id => !active.manager.get(id)), journalAndSqlClosed: true })); },
  };
}
