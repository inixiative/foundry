import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { m0Scenario, gate, bounded } from "../helpers/m0-domain-loop";

// Ordering controls for historical navigation ownership: real M0 factory/journal/viewer/store in isolated
// Chromium; only HTTP delivery order is controlled at the disposable server. No native or model process.
// Opt-in: FOUNDRY_QA_PLAYWRIGHT + Chrome.
const { chromium } = createRequire(import.meta.url)(process.env.FOUNDRY_QA_PLAYWRIGHT ?? "playwright");
const root = resolve(import.meta.dir, "../../../..");
const out = resolve(root, ".foundry/qa", `m1-navigation-order-${new Date().toISOString().replaceAll(":", "-")}`);
if (existsSync(out)) throw new Error(`Refusing to reuse an existing output directory: ${out}`);
mkdirSync(out, { recursive: true });
process.env.FOUNDRY_M0_OUTPUT_DIR = out;
const report: any = { scope: "real factory/journal/viewer/store; controlled HTTP delivery order only", assertions: [], errors: [], screenshots: [] };
const check = (name: string, ok: boolean, detail: unknown = {}) => report.assertions.push({ name, ok, detail });

test("late or superseded historical detail never publishes, re-opens or toasts; current and direct navigation still work", async () => {
  // Per-path holds: the server awaits a gate before answering the named turn's detail; `fail` answers 500 instead.
  const holds = new Map<string, { gate: ReturnType<typeof gate<void>>; requested: ReturnType<typeof gate<void>>; fail?: boolean }>();
  const hold = (turn: string, fail = false) => { const h = { gate: gate<void>(), requested: gate<void>(), fail }; holds.set(turn, h); return h; };
  let scenario: Awaited<ReturnType<typeof m0Scenario>> | null = null; let server: ReturnType<typeof Bun.serve> | null = null; let browser: any = null;
  try {
    scenario = await m0Scenario();
    expect((await scenario.send("a", "a-one", "Perform the migration")).status).toBe(200);
    expect((await scenario.send("a", "a-two")).status).toBe(200);
    expect((await scenario.send("b", "b-one", "Perform the migration")).status).toBe(200);
    await scenario.settled("a"); await scenario.settled("b");
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, websocket: scenario.current.websocket, async fetch(request, server) {
      const m = /^\/api\/threads\/(a|b)\/turns\/([^/]+)\/detail$/.exec(new URL(request.url).pathname);
      const h = m ? holds.get(m[2]!) : undefined;
      if (h) { h.requested.resolve(); await h.gate.promise; if (h.fail) return new Response(JSON.stringify({ error: "controlled failure" }), { status: 500, headers: { "content-type": "application/json" } }); }
      return scenario!.current.fetch(request, server);
    } });
    const origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.on("pageerror", (e: Error) => report.errors.push(e.message));
    const store = (fn: string) => page.evaluate(`(async () => { const store = await import(location.origin + "/ui/store.js"); return (${fn})(store); })()`);
    const observe = async () => ({ ...(await store(`s => ({ active: s.activeThreadId.value, selectedTurn: s.currentTrace.value?.selectedTurn?.turnId ?? null, selectedThread: s.currentTrace.value?.selectedTurn?.threadId ?? null, drawerOpen: s.detailDrawerOpen.value, toast: s.toast.value?.message ?? null })`)),
      drawerHead: (await page.locator(".detail-drawer").first().innerText()).slice(0, 80).replace(/\s+/g, " ") });
    const settle = () => page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => setTimeout(r, 50))));
    await page.goto(`${origin}/#project=P&thread=a`);
    await page.waitForFunction(async () => { const s = await import(`${location.origin}/ui/store.js`); return s.activeThreadId.value === "a" && s.allThreads.value.some((t: any) => t.threadId === "b"); });

    // 1. A -> B -> A: the old A response is a previous generation even though A is active again.
    let h = hold("a-one");
    await store(`s => { window.__p = s.openTurnDetail("a", "a-one"); }`);
    await bounded(h.requested.promise, "held a-one", 5000);
    await store(`s => { s.selectThread("b"); s.selectThread("a"); }`);
    h.gate.resolve(); await store(`async s => { await window.__p; }`); await settle();
    const aba = await observe();
    check("A -> B -> A: the response issued before the switches is rejected; nothing is selected on A", aba.active === "a" && aba.selectedTurn === null && aba.toast === null, aba);

    // 2. A fresh same-thread request on A now succeeds (direct navigation still works).
    holds.delete("a-one");
    await store(`async s => { await s.openTurnDetail("a", "a-one"); }`); await settle();
    const fresh = await observe();
    check("a current same-thread request publishes its turn", fresh.selectedTurn === "a-one" && fresh.selectedThread === "a" && fresh.drawerOpen === true, fresh);
    await page.screenshot({ path: join(out, "1440-fresh-a-one.png") }); report.screenshots.push("1440-fresh-a-one");

    // 3. Newer selected turn wins: hold a-one, then open a-two (unheld), then release a-one.
    h = hold("a-one");
    await store(`s => { window.__p = s.openTurnDetail("a", "a-one"); }`);
    await bounded(h.requested.promise, "held a-one again", 5000);
    await store(`async s => { await s.openTurnDetail("a", "a-two"); }`);
    const beforeRelease = await observe();
    h.gate.resolve(); await store(`async s => { await window.__p; }`); await settle();
    const newer = await observe();
    check("a newer selected turn is kept when an older request resolves later", beforeRelease.selectedTurn === "a-two" && newer.selectedTurn === "a-two" && newer.toast === null, { beforeRelease, newer });

    // 4. Dismissal during a held request (real Clear on the newer selection, then the held older one resolves): panel stays cleared.
    holds.delete("a-one"); h = hold("a-one");
    await store(`s => { window.__p = s.openTurnDetail("a", "a-one"); }`);
    await bounded(h.requested.promise, "held a-one for dismissal", 5000);
    await store(`s => s.dismissTraceSelection()`);
    await page.locator(".layer-item").filter({ hasText: "architecture" }).first().click(); // operator moved on to a layer
    await page.locator(".detail-drawer .expert-understanding").waitFor();
    h.gate.resolve(); await store(`async s => { await window.__p; }`); await settle();
    const dismissed = await observe();
    check("a dismissed selection is not re-opened by an older success", dismissed.selectedTurn === null && /architecture/.test(dismissed.drawerHead) && dismissed.toast === null, dismissed);
    await page.screenshot({ path: join(out, "1440-dismissed-stays-layer.png") }); report.screenshots.push("1440-dismissed-stays-layer");

    // 5. A superseded request that fails late produces no toast and no panel change.
    holds.delete("a-one"); h = hold("a-one", true);
    await store(`s => { s.toast.value = null; window.__p = s.openTurnDetail("a", "a-one"); }`);
    await bounded(h.requested.promise, "held failing a-one", 5000);
    await store(`s => s.selectThread("b")`);
    h.gate.resolve(); await store(`async s => { await window.__p; }`); await settle();
    const lateError = await observe();
    check("a late error for a superseded request neither toasts nor selects anything on the new thread", lateError.active === "b" && lateError.selectedTurn === null && lateError.toast === null, lateError);

    // 6. Same-thread error for a current request still surfaces (errors are not swallowed when owned).
    holds.delete("a-one"); h = hold("b-one", true);
    await store(`s => { window.__p = s.openTurnDetail("b", "b-one"); }`);
    await bounded(h.requested.promise, "held failing b-one", 5000);
    h.gate.resolve(); await store(`async s => { await window.__p; }`); await settle();
    const ownedError = await observe();
    check("an owned current request that fails reports the failure", ownedError.active === "b" && ownedError.selectedTurn === null && /unavailable \(500\)/.test(ownedError.toast ?? ""), ownedError);
    holds.delete("b-one");
    await store(`async s => { s.toast.value = null; await s.openTurnDetail("b", "b-one"); }`); await settle();
    const bOwn = await observe();
    check("B's own evidence opens on B", bOwn.selectedTurn === "b-one" && bOwn.selectedThread === "b", bOwn);
    await page.screenshot({ path: join(out, "1440-b-own-evidence.png") }); report.screenshots.push("1440-b-own-evidence");
    check("no page exceptions", report.errors.length === 0, report.errors);
  } finally {
    for (const h of holds.values()) h.gate.resolve();
    const cleanup: string[] = [];
    try { await browser?.close(); } catch (e) { cleanup.push(`browser: ${(e as Error).message}`); }
    try { server?.stop(true); } catch (e) { cleanup.push(`server: ${(e as Error).message}`); }
    try { await scenario?.close(); } catch (e) { cleanup.push(`scenario: ${(e as Error).message}`); }
    report.cleanupFailures = cleanup; report.scenarioDir = scenario?.dir ?? null;
    report.summary = { assertions: report.assertions.length, ok: report.assertions.filter((a: any) => a.ok).length, failed: report.assertions.filter((a: any) => !a.ok).map((a: any) => a.name) };
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
    console.log(`M1 navigation-order report: ${join(out, "report.json")}`);
  }
  expect(report.cleanupFailures).toEqual([]);
  expect(report.summary.failed).toEqual([]);
}, 120_000);
