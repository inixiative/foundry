import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { ContextLayer, ContextStack, EventStream, Harness, InterventionLog, Thread, type LLMMessage, type NativeEvidence } from "@inixiative/foundry-core";
import { ThreadRuntimeManager } from "../../src/agents/thread-runtime";
import { ThreadFactory, buildAgents } from "../../src/agents/thread-factory";
import { ConfigStore, starterConfig } from "../../src/viewer/config";
import { createViewer } from "../../src/viewer/server";
import { releaseAll } from "../helpers/release-all";

// Opt-in browser evidence (FOUNDRY_QA_PLAYWRIGHT). Production runtime, viewer,
// HTTP, SQLite and WebSocket with a controlled reviewer and executor: proves an
// open observer sees externally admitted work and can inspect historical versus
// current learning. Not native latency, model or retention evidence.
const { chromium } = createRequire(import.meta.url)(process.env.FOUNDRY_QA_PLAYWRIGHT ?? "playwright");
const fact = "Zephyr rollback requires migration order C before B.";

async function fixture(name: string, withNative = false) {
  const output = resolve(".foundry/qa", `${name}-${new Date().toISOString().replaceAll(":", "-")}`);
  mkdirSync(output, { recursive: true });
  const setupCleanup: import("../helpers/release-all").ReleaseStep[] = [];
  try {
  const config = starterConfig("controlled", "controlled");
  config.setupComplete = true;
  config.agents = { worker: { id: "worker", kind: "executor", provider: "controlled", model: "controlled", prompt: "Work",
    temperature: 0, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
  config.layers = { conventions: { id: "conventions", prompt: "Configured domain instructions", sourceIds: [], staleness: 0, enabled: true } };
  const layer = new ContextLayer({ id: "conventions", prompt: "Configured domain instructions" });
  layer.set("Configured domain knowledge");
  const stack = new ContextStack([layer]);
  const events = new EventStream();
  const inputs: LLMMessage[][] = [];
  let native: NativeEvidence | undefined;
  let release!: (result: string) => void;
  const held = new Promise<string>(r => { release = r; });
  let reviews = 0;
  const manager = new ThreadRuntimeManager({ config, log() {}, warn() {}, eventStream: events,
    learning: { timeoutMs: 5, hardTimeoutMs: 120_000 },
    domains: [{ domain: "conventions", layerId: "conventions", guardTriggers: [] }],
    llm: { id: "controlled-review", async complete(messages) {
      return { model: "controlled", content: messages.some(m => m.content.includes("## Completed work"))
        ? (++reviews === 1 ? await held : '{"decision":"abstain"}')
        : '{"domains":["conventions"],"layers":["conventions"],"snippets":[],"confidence":1}' };
    } } });
  const factory = new ThreadFactory({ stack, runtime: manager, agents: buildAgents(config, stack, { provider: {
    id: "controlled", nativeOwnership: withNative ? "required-prewrite" : undefined,
    async complete(messages, opts) {
      inputs.push(structuredClone(messages));
      if(withNative && opts?.nativeObservation) {
        native={schema:1,owner:opts.nativeObservation.owner,admissionId:`controlled-${inputs.length}`,nativeOutcome:"unknown",localOutcome:"pending",dispatch:"not-dispatched"};
        await opts.nativeObservation.register(native);
        native={...native,dispatch:"attempted",localOutcome:"resolved"};await opts.nativeObservation.observe(native);
      }
      return { model: "controlled", content: `OBSERVED_WORK_${inputs.length}`, ...(native ? {native} : {}) };
    },
  } }) });
  const thread = factory.create("main");
  setupCleanup.push(["runtime", () => manager.disposeAll()]);
  const owned = manager.get("main")!;
  const harness = new Harness(thread); harness.setDefaultExecutor("worker");
  const configDir = join(output, "state");
  const configStore = new ConfigStore(configDir); await configStore.save(config);
  const viewer = createViewer({ harness, eventStream: events, interventions: new InterventionLog(thread.signals), configStore, configDir, threadFactory: factory });
  setupCleanup.unshift(["store", () => viewer.localStore?.close()]);
  viewer.directory.restore([{ id: "side", meta: { ...thread.meta, description: "Side thread" } }]);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: viewer.fetch, websocket: viewer.websocket });
  const origin = `http://127.0.0.1:${server.port}`;
  setupCleanup.unshift(["server", () => server.stop(true)]);
  const send = async (threadId: string, id: string) => {
    const response = await fetch(`${origin}/api/messages`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId, id, message: `External work ${id}` }) });
    const body = await response.text();
    if (response.status !== 200) throw new Error(`POST /api/messages ${threadId}/${id} returned ${response.status}: ${body.slice(0, 600)}`);
    return JSON.parse(body);
  };
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  setupCleanup.unshift(["browser", () => browser.close()]);
  const report: any = { passed: false, output, checks: [], errors: [] as string[],
    scope: "Production HTTP/SQLite/WebSocket viewer with controlled reviewer and executor; not native evidence." };
  const page = async (width = 1440) => {
    const p = await browser.newPage({ viewport: { width, height: 900 } });
    p.setDefaultTimeout(8_000);
    p.on("pageerror", (e: Error) => report.errors.push(`pageerror: ${e.message}`));
    p.on("console", (m: any) => { if (m.type() === "error" && /store\.js|conversation-state|inspector-data|detail-drawer|SyntaxError|ReferenceError|TypeError/.test(m.text())) report.errors.push(`console: ${m.text()}`); });
    return p;
  };
  const close = async () => {
    release('{"decision":"abstain"}');
    const failures = await releaseAll([
      ["learning", () => owned.learningSettled()],
      ["browser", () => browser.close()],
      ["server", () => server.stop(true)],
      ["runtime", () => manager.disposeAll()],
      ["store", () => viewer.localStore?.close()],
    ]);
    report.cleanupFailures = failures;
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
    if (failures.length) throw new Error(`cleanup failures: ${failures.join("; ")}`);
  };
  return { origin, send, page, owned, viewer, inputs, release, report, output, close,
    appendTerminal() {
      if(!native)throw Error("No controlled admission");
      viewer.localStore!.appendNative(thread,{...native,nativeOutcome:"completed",terminal:{type:"controlled_terminal"}});
      events.push({kind:"journal",threadId:thread.id,turnId:native.owner!.messageId!,timestamp:Date.now()});
    } };
  } catch (error) {
    const cleanupFailures = await releaseAll(setupCleanup);
    writeFileSync(join(output,"report.json"),JSON.stringify({passed:false,phase:"partial-setup",error:String(error),cleanupFailures},null,2));
    throw error;
  }
}

const agentCount = (p: any, text: string) => p.locator(".chat-agent").filter({ hasText: text }).count();

test("an open native inspector receives late journal terminal without changing historical delivery or sending again",async()=>{
  const f=await fixture("observer-native-terminal",true);
  try {
    const observer=await f.page();await observer.goto(`${f.origin}/#thread=main`);
    await observer.locator(".status-text").filter({hasText:/^connected$/}).waitFor();
    await f.send("main","native-history");
    const message=observer.locator(".chat-agent").filter({hasText:"OBSERVED_WORK_1"});await message.locator(".chat-trace-btn").click();
    await observer.locator(".native-journal-evidence").filter({hasText:"unknown"}).waitFor();
    const before=JSON.stringify(f.viewer.localStore!.traceForTurn("native-history"));
    f.appendTerminal();await observer.locator(".native-journal-evidence").filter({hasText:"completed"}).waitFor();
    expect(JSON.stringify(f.viewer.localStore!.traceForTurn("native-history"))).toBe(before);expect(f.inputs).toHaveLength(1);
    expect(f.report.errors).toEqual([]);f.report.passed=true;
  }finally{await f.close();}
},30_000);

test("pre-dispatch failure on an inactive thread is fetched on return and visible without re-execution", async () => {
  const f=await fixture("observer-inactive-predispatch");
  try {
    const empty=new Thread("no-executor",new ContextStack());f.viewer.directory.add(empty);
    const page=await f.page();let ownedRefresh=0;
    page.on("request",(request:any)=>{const url=new URL(request.url());if(url.pathname==="/api/threads/no-executor/history"||(url.pathname==="/api/messages"&&url.searchParams.get("threadId")==="no-executor"))ownedRefresh++;});
    await page.goto(`${f.origin}/#thread=no-executor`);await page.locator(".status-text").filter({hasText:/^connected$/}).waitFor();
    await page.waitForFunction(()=>localStorage.getItem("foundry:msgs:no-executor")!==null);
    await page.evaluate(()=>{location.hash="#thread=main";});await page.locator(".chat-input").waitFor();
    ownedRefresh=0;
    const response=await fetch(`${f.origin}/api/messages`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"before-provider",threadId:"no-executor",message:"Controlled refusal"})});
    expect(response.status).toBe(500);
    // Its stream is closed while inactive: nothing is fetched for it until the operator returns.
    await Bun.sleep(600);
    expect(ownedRefresh).toBe(0);
    await page.evaluate(()=>{location.hash="#thread=no-executor";});
    for(let n=0;n<60&&ownedRefresh===0;n++)await Bun.sleep(50);
    expect(ownedRefresh).toBeGreaterThan(0);
    await page.locator(".chat-agent").waitFor();expect(f.inputs).toHaveLength(0);
    expect(f.viewer.localStore!.messages("no-executor")).toHaveLength(2);f.report.passed=true;
  }finally{await f.close();}
},30000);

test("an open observer sees externally admitted work without reload, without duplicates, across active and inactive threads", async () => {
  const f = await fixture("observer-live");
  try {
    const observer = await f.page();
    await observer.goto(`${f.origin}/#thread=main`);
    await observer.locator(".status-text").filter({ hasText: /^connected$/ }).waitFor();
    await observer.locator(".chat-input").waitFor();
    // Externally admitted work appears in the open tab without reload.
    await f.send("main", "external-one");
    await observer.locator(".chat-agent").filter({ hasText: "OBSERVED_WORK_1" }).waitFor({ timeout: 4_000 });
    f.report.checks.push({ case: "external-work-live", passed: true });
    // Own submission then another external one: exactly one row per turn, one provider call per submission.
    await observer.locator(".chat-input").fill("Own submitted work");
    await observer.locator(".chat-input").press("Enter");
    await observer.locator(".chat-agent").filter({ hasText: "OBSERVED_WORK_2" }).waitFor();
    await observer.waitForFunction(async () => (await import(`${location.origin}/ui/store.js`)).inflight.value === 0);
    await f.send("main", "external-two");
    await observer.locator(".chat-agent").filter({ hasText: "OBSERVED_WORK_3" }).waitFor({ timeout: 4_000 });
    await observer.waitForTimeout(700); // one debounced reconcile window after the last event
    expect(await observer.locator(".chat-agent:not(.chat-thinking)").count()).toBe(3);
    expect(await observer.locator(".chat-user").count()).toBe(3);
    expect(await agentCount(observer, "OBSERVED_WORK_2")).toBe(1);
    expect(f.inputs).toHaveLength(3);
    f.report.checks.push({ case: "no-duplicate-rows-or-submissions", passed: true });
    // Inactive thread: cache the side thread, return to main, admit work on side, switch back.
    await observer.evaluate(() => { location.hash = "#thread=side"; });
    await observer.locator(".conv-empty").waitFor();
    await observer.evaluate(() => { location.hash = "#thread=main"; });
    await observer.locator(".chat-agent").filter({ hasText: "OBSERVED_WORK_3" }).waitFor();
    await f.send("side", "external-side");
    await observer.waitForTimeout(700);
    expect(await agentCount(observer, "OBSERVED_WORK_4")).toBe(0); // never cross-written into main
    await observer.evaluate(() => { location.hash = "#thread=side"; });
    await observer.locator(".chat-agent").filter({ hasText: "OBSERVED_WORK_4" }).waitFor({ timeout: 4_000 });
    expect(await observer.locator(".chat-agent:not(.chat-thinking)").count()).toBe(1);
    // Late fetch after a quick double switch lands in the right cache only.
    await observer.evaluate(() => { location.hash = "#thread=main"; });
    await observer.evaluate(() => { location.hash = "#thread=side"; });
    await observer.waitForTimeout(700);
    expect(await agentCount(observer, "OBSERVED_WORK_3")).toBe(0);
    expect(await agentCount(observer, "OBSERVED_WORK_4")).toBe(1);
    await observer.evaluate(() => { location.hash = "#thread=main"; });
    await observer.waitForTimeout(700);
    expect(await observer.locator(".chat-agent:not(.chat-thinking)").count()).toBe(3);
    f.report.checks.push({ case: "inactive-thread-and-late-switch", passed: true });
    await observer.screenshot({ path: join(f.output, "observer.png"), fullPage: true });
    expect(f.report.errors).toEqual([]);
    f.report.passed = true;
  } finally { await f.close(); }
}, 90_000);

test("browser storage failure keeps externally observed work visible and honestly labeled", async () => {
  const f = await fixture("observer-storage-failure");
  try {
    const observer = await f.page();
    await observer.goto(`${f.origin}/#thread=main`);
    await observer.locator(".status-text").filter({ hasText: /^connected$/ }).waitFor();
    await observer.waitForFunction(() => localStorage.getItem("foundry:msgs:main") !== null);
    await observer.evaluate(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (this === localStorage && key.startsWith("foundry:msgs:")) throw new DOMException("Controlled browser write rejection", "QuotaExceededError");
        return set.call(this, key, value);
      };
    });
    await f.send("main", "external-under-storage-failure");
    await observer.locator(".chat-agent").filter({ hasText: "OBSERVED_WORK_1" }).waitFor({ timeout: 4_000 });
    await observer.locator(".chat-msg-time").filter({ hasText: "Browser copy not saved" }).first().waitFor();
    expect(await observer.locator(".chat-agent:not(.chat-thinking)").count()).toBe(1);
    f.report.checks.push({ case: "storage-failure-visible", passed: true });
    expect(f.report.errors).toEqual([]);
    f.report.passed = true;
  } finally { await f.close(); }
}, 60_000);

test("Turn Context shows historical pending learning that stays fixed after commit, and the thread view inspects current knowledge", async () => {
  const f = await fixture("observer-inspection");
  try {
    await f.send("main", "origin");
    await Bun.sleep(15);
    expect(f.owned.learningState.domains.conventions.status).toBe("delayed");
    const immediate = await f.send("main", "before-commit");
    expect(immediate.meta.delivery.learningBarrier).toMatchObject({ outcome: "pending", waitedMs: 0 });
    const observer = await f.page();
    await observer.goto(`${f.origin}/#thread=main`);
    const pendingMessage = observer.locator(".chat-agent").filter({ hasText: "OBSERVED_WORK_2" });
    await pendingMessage.locator(".chat-trace-btn").click();
    await observer.getByRole("button", { name: "Turn Context", exact: true }).click();
    const panel = observer.locator(".panel-right");
    const before = await panel.innerText();
    expect(before).toMatch(/\blearning\b[^\n]*\bpending\b|\bpending\b[^\n]*\blearning\b/i);
    expect(before).toMatch(/0 ms added wait/);
    expect(before).toMatch(/historical/i);
    expect(before).toMatch(/conventions/);
    f.report.checks.push({ case: "historical-pending-visible", passed: true });
    // Commit the fact; the selected historical record must not change.
    f.release(JSON.stringify({ decision: "learn", knowledge: fact, facts: [fact], reason: "Verified completed work" }));
    await f.owned.learningSettled();
    expect(f.viewer.localStore!.knowledge("main")!.domains.conventions.content).toBe(fact);
    await f.send("main", "after-commit");
    await observer.locator(".chat-agent").filter({ hasText: "OBSERVED_WORK_3" }).waitFor({ timeout: 4_000 });
    await observer.waitForTimeout(500);
    const after = await panel.innerText();
    expect(after).toMatch(/\blearning\b[^\n]*\bpending\b|\bpending\b[^\n]*\blearning\b/i);
    expect(after).not.toContain(fact);
    expect(after).not.toMatch(/learned/i);
    f.report.checks.push({ case: "historical-record-unchanged-after-commit", passed: true });
    // Current knowledge inspection in the thread view.
    await observer.getByRole("button", { name: "Clear", exact: true }).click();
    const current = observer.locator(".panel-right");
    await current.locator(".detail-section-title").filter({ hasText: /^Thread knowledge \(current\)$/ }).waitFor();
    await current.getByText(/^conventions: /).waitFor();
    const text = await current.innerText();
    // The controlled reviewer abstains on the post-commit work, so the live
    // status is abstain while the durable revision remains the committed fact.
    expect(text).toMatch(/Review status\s*\n?\s*abstain/i);
    expect(text).toMatch(/Latest committed revision\s*\n?\s*1 by conventions-reviewer/);
    expect(text).toMatch(/Native outcome\s*\n?\s*unknown/);
    expect(text).not.toMatch(/acknowledged by/i);
    await current.locator(".detail-section-title").filter({ hasText: /^Requested review configuration/ }).click();
    // After the post-commit review, the segment is the copy frozen at that review's
    // admission (base revision 1); without a job it would be the latest durable commit.
    await current.locator(".detail-section-title").filter({ hasText: /^Thread knowledge \((frozen at review admission|latest durable commit)\)$/ }).click();
    const expanded = await current.innerText();
    expect(expanded).toContain("Requested by Foundry for this review; the native engine has not acknowledged these values.");
    expect(expanded).toContain(fact);
    // Section titles render uppercase via CSS; innerText reflects that transform.
    expect(expanded).toMatch(/Review instructions/i);
    expect(expanded).toMatch(/Configured domain knowledge/i);
    f.report.checks.push({ case: "current-knowledge-inspection", passed: true });
    // Layout at three widths: no horizontal overflow, no page errors.
    for (const width of [333, 390, 1440]) {
      const p = await f.page(width);
      await p.goto(`${f.origin}/#thread=main`);
      await p.locator(".chat-agent").filter({ hasText: "OBSERVED_WORK_2" }).locator(".chat-trace-btn").click();
      await p.getByRole("button", { name: "Turn Context", exact: true }).click();
      await p.locator(".panel-right").getByText(/Learning at this turn/).first().waitFor();
      let overflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      await p.screenshot({ path: join(f.output, `turn-context-${width}.png`), fullPage: true });
      await p.getByRole("button", { name: "Clear", exact: true }).click();
      await p.locator(".panel-right").getByText(/^conventions: /).waitFor();
      overflow = overflow || await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      await p.screenshot({ path: join(f.output, `knowledge-${width}.png`), fullPage: true });
      f.report.checks.push({ case: "layout", width, overflow });
      expect(overflow).toBe(false);
      await p.close();
    }
    expect(f.report.errors).toEqual([]);
    f.report.passed = true;
  } finally { await f.close(); }
}, 120_000);
