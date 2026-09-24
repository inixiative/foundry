import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ContextLayer, ContextStack, EventStream, Harness, InterventionLog, Thread } from "@inixiative/foundry-core";
import { ConfigStore, starterConfig } from "../../src/viewer/config";
import { createViewer } from "../../src/viewer/server";
import { releaseAll } from "../helpers/release-all";

// Opt-in (FOUNDRY_QA_PLAYWRIGHT). Actual viewer, store and browser over a
// controlled HTTP server: knowledge and history responses are held and released
// in chosen orders. Proves request ownership in the store; no learning runtime,
// no model, no native work.
const { chromium } = createRequire(import.meta.url)(process.env.FOUNDRY_QA_PLAYWRIGHT ?? "playwright");

function snapshot(threadId: string, revision: number, generation = "runtime-A", status = "learned") {
  return { status: "durable", history: [], snapshot: { threadId, capturedAt: revision,
    domains: { conventions: { revision, content: `COMMITTED_${threadId}_${revision}`, hash: `hash-${revision}`, author: "controlled", updatedAt: revision, evidence: [] } } },
    learning: { domains: { conventions: { status, queued: 0, queuedEvidence: [], localSettled: true, nativeOutcome: "unknown",
      job: { id: `review-${generation}-${revision}`, domain: "conventions", threadId, generation, epoch: 0, base: { revision: Math.max(0, revision - 1), hash: "h" },
        evidence: { kind: "dispatch", id: "e", timestamp: 1 }, segments: { instructions: "I", domainKnowledge: "D", threadKnowledge: "" }, requested: {}, providerId: "controlled", budgets: {} } } } } };
}

async function fixture(name: string) {
  const output = resolve(".foundry/qa", `${name}-${new Date().toISOString().replaceAll(":", "-")}`);
  mkdirSync(output, { recursive: true });
  const setupCleanup: import("../helpers/release-all").ReleaseStep[] = [];
  try {
  const config = starterConfig("controlled", "controlled");
  config.setupComplete = true;
  const layer = new ContextLayer({ id: "conventions" }); layer.set("Controlled current layer");
  const main = new Thread("a", new ContextStack([layer]));
  const configDir = join(output, "state");
  const configStore = new ConfigStore(configDir); await configStore.save(config);
  const viewer = createViewer({ harness: new Harness(main), eventStream: new EventStream(), interventions: new InterventionLog(main.signals), configStore, configDir });
  setupCleanup.push(["threads", () => { for(const thread of viewer.directory.all()) thread.dispose(); }], ["store", () => viewer.localStore?.close()]);
  viewer.directory.restore([{ id: "b", meta: { ...main.meta, description: "Thread B" } }]);
  // Controlled responders: each returns a JSON body or a promise of one; holds are explicit.
  const knowledge = new Map<string, () => Promise<unknown> | unknown>();
  const history = new Map<string, () => Promise<unknown> | unknown>();
  const requests: Array<{ path: string; at: number }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") return server.upgrade(request) ? undefined : new Response("Upgrade required", { status: 400 });
    const knowledgeMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/knowledge$/);
    if (knowledgeMatch && knowledge.has(knowledgeMatch[1])) {
      const entry: Record<string, unknown> = { path: url.pathname, at: Date.now() };
      requests.push(entry as { path: string; at: number });
      const body = await knowledge.get(knowledgeMatch[1])!();
      entry.done = Date.now();
      entry.revision = body instanceof Response ? `status ${body.status}` : (body as any)?.snapshot?.domains?.conventions?.revision;
      return body instanceof Response ? body : Response.json(body);
    }
    if (url.pathname === "/api/messages" && request.method === "GET" && history.has(url.searchParams.get("threadId") ?? "")) {
      requests.push({ path: `${url.pathname}?threadId=${url.searchParams.get("threadId")}`, at: Date.now() });
      const body = await history.get(url.searchParams.get("threadId")!)!();
      return body instanceof Response ? body : Response.json(body);
    }
    return viewer.app.fetch(request);
  }, websocket: { open() {}, message() {}, close() {} } });
  const origin = `http://127.0.0.1:${server.port}`;
  setupCleanup.unshift(["server", () => server.stop(true)]);
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  setupCleanup.unshift(["browser", () => browser.close()]);
  const errors: string[] = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8_000);
  page.on("pageerror", (e: Error) => errors.push(e.message));
  const report: any = { passed: false, output, errors, checks: [] as unknown[], responses: [] as unknown[],
    scope: "Actual viewer/store/browser with controlled ordered HTTP responses; no learning runtime or native work." };
  page.on("request", (request: any) => {
    if (/\/knowledge$/.test(request.url())) report.responses.push({ sent: request.url().replace(origin, ""), at: Date.now() });
  });
  page.on("requestfailed", (request: any) => {
    if (/\/knowledge$/.test(request.url())) report.responses.push({ failed: request.url().replace(origin, ""), error: request.failure()?.errorText, at: Date.now() });
  });
  page.on("response", async (response: any) => {
    const url = response.url();
    if (!/\/knowledge$|\/api\/messages\?/.test(url)) return;
    let revision: unknown;
    try { const body = await response.json(); revision = body?.snapshot?.domains?.conventions?.revision ?? body?.messages?.length ?? body?.status; } catch {}
    report.responses.push({ url: url.replace(origin, ""), status: response.status(), revision, at: Date.now() });
  });
  const store = {
    load: (threadId: string) => page.evaluate(async (id: string) => { const s = await import(`${location.origin}/ui/store.js`); return s.loadKnowledge(id); }, threadId),
    loadDetached: (threadId: string) => page.evaluate((id: string) => { void import(`${location.origin}/ui/store.js`).then(s => s.loadKnowledge(id)); }, threadId),
    inspection: () => page.evaluate(async () => { const s = await import(`${location.origin}/ui/store.js`); const v = s.knowledgeInspection.value;
      return v ? { threadId: v.threadId, revision: v.payload?.snapshot?.domains?.conventions?.revision, generation: v.payload?.learning?.domains?.conventions?.job?.generation,
        status: v.payload?.status, pending: v.pending ?? false, superseded: v.superseded ?? 0 } : null; }),
    select: (threadId: string) => page.evaluate((id: string) => { location.hash = `#thread=${id}`; }, threadId),
    messages: (threadId: string) => page.evaluate((id: string) => JSON.parse(localStorage.getItem(`foundry:msgs:${id}`) ?? "[]"), threadId),
    active: () => page.evaluate(async () => { const s = await import(`${location.origin}/ui/store.js`); return { active: s.activeThreadId.value, contents: s.messages.value.map((m: any) => m.content) }; }),
    settle: () => page.evaluate(() => new Promise<void>(r => setTimeout(() => requestAnimationFrame(() => r()), 50))),
  };
  // Every held response is released before the server stops, so a failed
  // assertion reports its evidence instead of hanging on an in-flight handler.
  const gates = new Set<() => void>();
  const held = <T,>(value: T | (() => T)) => {
    let release!: () => void; let markStarted!: () => void;
    const gateP = new Promise<void>(r => { release = r; });
    const started = new Promise<void>(r => { markStarted = r; });
    gates.add(release);
    const responder = async () => { markStarted(); await gateP; return typeof value === "function" ? (value as () => T)() : value; };
    return { responder, release, started };
  };
  const close = async () => {
    for (const release of gates) release();
    report.finalCaptureFailures = await releaseAll([["final inspection", async () => {
      report.finalPanel = await page.locator(".panel-right").innerText({ timeout: 2_000 });
      report.finalInspection = await store.inspection();
    }]], 3_000);
    report.cleanupFailures = await releaseAll([
      ["browser", () => browser.close()], ["server", () => server.stop(true)],
      ["threads", () => { for (const t of viewer.directory.all()) t.dispose(); }], ["store", () => viewer.localStore?.close()],
    ]);
    report.requests = requests;
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
    if (report.cleanupFailures.length) throw new Error(`cleanup failures: ${report.cleanupFailures.join("; ")}`);
  };
  return { origin, page, viewer, knowledge, history, requests, report, store, output, errors, held, close };
  } catch(error) {
    const cleanupFailures = await releaseAll(setupCleanup);
    writeFileSync(join(output,"report.json"),JSON.stringify({passed:false,phase:"partial-setup",error:String(error),cleanupFailures},null,2));
    throw error;
  }
}

test("malformed knowledge history shows an error and recovers on a later valid response", async () => {
  const f=await fixture("knowledge-malformed-recovery");
  try {
    f.knowledge.set("a",()=>({status:"durable",snapshot:null,history:[null]}));
    await f.page.goto(`${f.origin}/#thread=a`);await f.store.load("a");
    await f.page.getByText("Malformed knowledge inspection response; refresh to recover").waitFor();
    f.knowledge.set("a",()=>snapshot("a",2));await f.store.load("a");
    await f.page.waitForFunction(()=>!document.body.textContent?.includes("Malformed knowledge inspection response"));
    expect((await f.store.inspection()).revision).toBe(2);expect(f.errors).toEqual([]);f.report.passed=true;
  }finally{await f.close();}
},30000);

test("older same-thread knowledge successes or failures never overwrite a later observed state, across refresh sources", async () => {
  const f = await fixture("knowledge-order-same-thread");
  try {
    f.knowledge.set("a", () => snapshot("a", 0));
    await f.page.goto(`${f.origin}/#thread=a`);
    await f.page.locator(".panel-right").getByText(/0 by controlled/).waitFor();
    // Hold revision 1; a later manual request observes revision 2; the held one then succeeds.
    const old = f.held(snapshot("a", 1));
    f.knowledge.set("a", old.responder);
    f.store.loadDetached("a");
    await old.started;
    f.knowledge.set("a", () => snapshot("a", 2));
    await f.store.load("a");
    await f.page.locator(".panel-right").getByText(/2 by controlled/).waitFor();
    old.release();
    await f.store.settle();
    expect(await f.store.inspection()).toMatchObject({ threadId: "a", revision: 2, pending: false });
    expect(await f.page.locator(".panel-right").innerText()).toMatch(/2 by controlled/);
    f.report.checks.push({ case: "older-success-dropped", passed: true });
    const step = (name: string) => { f.report.step = name; };
    // Older failure after a newer success: still revision 2, not unavailable.
    const oldFailure = f.held(() => new Response(JSON.stringify({ status: "blocked", error: "OLD_FAILURE" }), { status: 503 }));
    f.knowledge.set("a", oldFailure.responder);
    f.store.loadDetached("a");
    step("old-failure-detached");
    await oldFailure.started;
    step("old-failure-started");
    f.knowledge.set("a", () => snapshot("a", 3));
    await f.page.locator(".panel-right").getByRole("button", { name: "Refresh", exact: true }).click(); // manual refresh path
    step("refresh-clicked");
    await f.page.locator(".panel-right").getByText(/3 by controlled/).waitFor();
    step("revision-3-visible");
    oldFailure.release();
    await f.store.settle();
    step("old-failure-released");
    expect(await f.store.inspection()).toMatchObject({ threadId: "a", revision: 3, status: "durable" });
    expect(await f.page.locator(".panel-right").innerText()).not.toContain("OLD_FAILURE");
    f.report.checks.push({ case: "older-failure-dropped", passed: true });
    // Newer unavailable state is not replaced by an older held success.
    const oldOk = f.held(snapshot("a", 4));
    f.knowledge.set("a", oldOk.responder);
    f.store.loadDetached("a");
    await oldOk.started;
    f.knowledge.set("a", () => new Response(JSON.stringify({ status: "unavailable", error: "NEWER_UNAVAILABLE" }), { status: 503 }));
    await f.store.load("a");
    await f.page.locator(".panel-right").getByText(/NEWER_UNAVAILABLE/).waitFor();
    oldOk.release();
    await f.store.settle();
    expect(await f.store.inspection()).toMatchObject({ threadId: "a", status: "unavailable" });
    expect(await f.page.locator(".panel-right").innerText()).toContain("NEWER_UNAVAILABLE");
    f.report.checks.push({ case: "newer-unavailable-kept", passed: true });
    // Runtime generation change: an older-issued request with a higher revision from generation A
    // must not beat the later-issued generation B response; latest issued wins, not the largest revision.
    const oldGen = f.held(snapshot("a", 9, "runtime-A"));
    f.knowledge.set("a", oldGen.responder);
    f.store.loadDetached("a");
    await oldGen.started;
    f.knowledge.set("a", () => snapshot("a", 1, "runtime-B"));
    await f.store.load("a");
    await f.page.locator(".panel-right").getByText(/1 by controlled/).waitFor();
    oldGen.release();
    await f.store.settle();
    expect(await f.store.inspection()).toMatchObject({ revision: 1, generation: "runtime-B" });
    f.report.checks.push({ case: "generation-change-latest-issued-wins", passed: true });
    expect((await f.store.inspection()).superseded).toBeGreaterThanOrEqual(4);
    await f.page.screenshot({ path: join(f.output, "same-thread.png"), fullPage: true });
    expect(f.errors).toEqual([]);
    f.report.passed = true;
  } finally { await f.close(); }
}, 90_000);

test("A-to-B-to-A selection: a held response for the first A request cannot overwrite the later A request, and B's state never shows on A", async () => {
  const f = await fixture("knowledge-order-a-b-a");
  try {
    f.knowledge.set("a", () => snapshot("a", 0));
    f.knowledge.set("b", () => snapshot("b", 7));
    await f.page.goto(`${f.origin}/#thread=a`);
    await f.page.locator(".panel-right").getByText(/0 by controlled/).waitFor();
    const firstA = f.held(snapshot("a", 1));
    f.knowledge.set("a", firstA.responder);
    f.store.loadDetached("a");
    await firstA.started;
    await f.store.select("b");
    await f.page.locator(".panel-right").getByText(/7 by controlled/).waitFor();
    f.knowledge.set("a", () => snapshot("a", 2));
    await f.store.select("a");
    await f.page.locator(".panel-right").getByText(/2 by controlled/).waitFor();
    firstA.release();
    await f.store.settle();
    expect(await f.store.inspection()).toMatchObject({ threadId: "a", revision: 2 });
    expect(await f.page.locator(".panel-right").innerText()).not.toMatch(/7 by controlled/);
    // Pending indicator: while a newer request is outstanding the panel says so instead of showing stale data as fresh.
    const slow = f.held(snapshot("a", 3));
    f.knowledge.set("a", slow.responder);
    f.store.loadDetached("a");
    await slow.started;
    expect(await f.store.inspection()).toMatchObject({ threadId: "a", revision: 2, pending: true });
    await f.page.locator(".panel-right").getByText(/refresh in progress/i).waitFor();
    slow.release();
    await f.page.locator(".panel-right").getByText(/3 by controlled/).waitFor();
    expect(await f.store.inspection()).toMatchObject({ revision: 3, pending: false });
    f.report.checks.push({ case: "a-b-a-and-pending", passed: true });
    expect(f.errors).toEqual([]);
    f.report.passed = true;
  } finally { await f.close(); }
}, 90_000);

test("a late history response after a thread switch writes only into its own thread and preserves browser-only rows", async () => {
  const f = await fixture("history-order-thread-switch");
  try {
    f.knowledge.set("a", () => snapshot("a", 0));
    f.knowledge.set("b", () => snapshot("b", 0));
    const row = (threadId: string, turnId: string, actor: string, content: string, ts: number, extra: Record<string, unknown> = {}) =>
      ({ id: `${threadId}-${turnId}-${actor}`, threadId, turnId, actor, kind: "text", content, timestamp: ts, ...extra });
    f.history.set("a", () => ({ messages: [row("a", "a1", "user", "A first", 1), row("a", "a1", "agent", "A_REPLY_1", 2, { traceId: "ta1" })] }));
    f.history.set("b", () => ({ messages: [row("b", "b1", "user", "B first", 1), row("b", "b1", "agent", "B_REPLY_1", 2, { traceId: "tb1" })] }));
    await f.page.goto(`${f.origin}/#thread=a`);
    await f.page.getByText("A_REPLY_1").waitFor();
    // Browser-only evidence in both threads: legacy rows without identity and a completed-unsaved result.
    await f.page.evaluate(() => {
      const add = (id: string, rows: unknown[]) => { const cur = JSON.parse(localStorage.getItem(`foundry:msgs:${id}`) ?? "[]"); localStorage.setItem(`foundry:msgs:${id}`, JSON.stringify([...cur, ...rows])); };
      add("a", [{ actor: "user", content: "A legacy browser-only", timestamp: 3 },
        { actor: "agent", turnId: "a-unsaved", content: "A_COMPLETED_UNSAVED", timestamp: 4, storage: "browser-only", meta: { executionOutcome: "completed", persistence: "failed" } }]);
      add("b", [{ actor: "user", content: "B legacy browser-only", timestamp: 3 }]);
    });
    await f.page.reload();
    await f.page.getByText("A_COMPLETED_UNSAVED").waitFor();
    await f.store.select("b");
    await f.page.getByText("B legacy browser-only").waitFor();
    await f.store.select("a");
    await f.page.getByText("A_REPLY_1").waitFor();
    // Hold A's late reconcile (with new external work), switch to B, then release: only A's cache changes.
    const lateA = f.held({ messages: [row("a", "a1", "user", "A first", 1), row("a", "a1", "agent", "A_REPLY_1", 2, { traceId: "ta1" }),
      row("a", "a2", "user", "A second", 10), row("a", "a2", "agent", "A_REPLY_2_LATE", 11, { traceId: "ta2" })] });
    f.history.set("a", lateA.responder);
    await f.page.evaluate(async () => { const s = await import(`${location.origin}/ui/store.js`); s.requestReconcile("a", 0); });
    await lateA.started;
    await f.store.select("b");
    await f.page.getByText("B_REPLY_1").waitFor();
    lateA.release();
    await f.store.settle();
    const activeB = await f.store.active();
    expect(activeB.active).toBe("b");
    expect(activeB.contents).toEqual(["B first", "B_REPLY_1", "B legacy browser-only"]);
    expect(activeB.contents).not.toContain("A_REPLY_2_LATE");
    const cacheA = await f.store.messages("a");
    expect(cacheA.map((m: any) => m.content)).toContain("A_REPLY_2_LATE");
    expect(cacheA.map((m: any) => m.content)).toContain("A legacy browser-only");
    expect(cacheA.find((m: any) => m.content === "A_COMPLETED_UNSAVED")).toMatchObject({ storage: "browser-only" });
    await f.store.select("a");
    await f.page.getByText("A_REPLY_2_LATE").waitFor();
    expect(await f.page.locator(".chat-agent:not(.chat-thinking)").count()).toBe(3);
    f.report.checks.push({ case: "late-history-own-thread-only", passed: true });
    // Older history response resolving after a newer one does not regress the cache.
    const olderA = f.held({ messages: [row("a", "a1", "user", "A first", 1), row("a", "a1", "agent", "A_REPLY_1", 2, { traceId: "ta1" })] });
    f.history.set("a", olderA.responder);
    await f.page.evaluate(async () => { const s = await import(`${location.origin}/ui/store.js`); s.requestReconcile("a", 0); });
    await olderA.started;
    f.history.set("a", () => ({ messages: [row("a", "a1", "user", "A first", 1), row("a", "a1", "agent", "A_REPLY_1", 2, { traceId: "ta1" }),
      row("a", "a2", "user", "A second", 10), row("a", "a2", "agent", "A_REPLY_2_LATE", 11, { traceId: "ta2" }), row("a", "a3", "user", "A third", 20), row("a", "a3", "agent", "A_REPLY_3", 21, { traceId: "ta3" })] }));
    await f.page.evaluate(async () => { const s = await import(`${location.origin}/ui/store.js`); s.requestReconcile("a", 0); });
    await f.page.getByText("A_REPLY_3").waitFor();
    olderA.release();
    await f.store.settle();
    expect((await f.store.active()).contents).toContain("A_REPLY_3");
    expect(await f.page.locator(".chat-agent:not(.chat-thinking)").count()).toBe(4);
    f.report.checks.push({ case: "older-history-response-dropped", passed: true });
    await f.page.screenshot({ path: join(f.output, "history-order.png"), fullPage: true });
    expect(f.errors).toEqual([]);
    f.report.passed = true;
  } finally { await f.close(); }
}, 90_000);
