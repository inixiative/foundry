import { test, expect } from "bun:test";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { ContextStack, EventStream, Executor, Harness, InterventionLog, Thread } from "@inixiative/foundry-core";
import { ConfigStore, starterConfig } from "../../src/viewer/config";
import { createViewer } from "../../src/viewer/server";
import { releaseAll, type ReleaseStep } from "../helpers/release-all";

// D1 browser scenario: browser-only failure evidence kept beside an interrupted journal row must
// survive a quota-limited cache write and a reload, inspectable and distinct from the server record.
// Opt-in: needs the QA Playwright runtime (FOUNDRY_QA_PLAYWRIGHT) and Chrome. Controlled executor only.
const { chromium } = createRequire(import.meta.url)(process.env.FOUNDRY_QA_PLAYWRIGHT ?? "playwright");
const root = resolve(import.meta.dir, "../../../..");
const out = resolve(root, ".foundry/qa", `g6-evidence-cache-${new Date().toISOString().replaceAll(":", "-")}`);
if (existsSync(out)) throw new Error(`Refusing to reuse an existing output directory: ${out}`);
mkdirSync(out, { recursive: true });
const MARKER = "BROWSER_ONLY_OBSERVED_TOOL_RESULT_SENTINEL";
const report: any = { scope: "controlled executor; no native or model process", startedAt: new Date().toISOString(), assertions: [], screenshots: [], errors: [], failedResponses: [] };
const check = (name: string, ok: boolean, detail: unknown = {}) => report.assertions.push({ name, ok, detail });

test("browser-only failure evidence survives quota fallback and reload, distinct from the server's interrupted record", async () => {
  const cleanup: ReleaseStep[] = [];
  try {
    const thread = new Thread("evidence", new ContextStack(), { description: "Evidence cache" });
    thread.register(new Executor({ id: "worker", stack: thread.stack, handler: async (_context, payload) => `CONTROLLED_LIVE_RESULT for ${String(payload).slice(0, 20)}` }));
    const harness = new Harness(thread); harness.setDefaultExecutor("worker");
    const configDir = join(out, "state"); mkdirSync(configDir, { recursive: true });
    const configStore = new ConfigStore(configDir);
    const config = starterConfig("controlled", "controlled"); config.setupComplete = true; await configStore.save(config);
    const viewer = createViewer({ harness, eventStream: new EventStream(), interventions: new InterventionLog(thread.signals), configStore, configDir });
    cleanup.unshift(["store", () => viewer.localStore?.close()]);
    const store = viewer.localStore!;
    // Durable history: 30 completed turns, then one turn that the journal recorded as interrupted.
    for (let n = 1; n <= 30; n++) {
      const id = `seed-${String(n).padStart(3, "0")}`, started = 1_700_000_000_000 + n * 1000;
      store.beginTurn(thread, id, `Seeded question ${n}`);
      store.completeTurn(thread, id, `Seeded answer ${n} ` + "filler ".repeat(400), { executionOutcome: "completed", persistence: "committed", turnStatus: "completed" },
        { id: `trace-${id}`, messageId: id, startedAt: started, endedAt: started + 10, durationMs: 10, root: { id: `s-${id}`, name: "ingress", kind: "ingress", status: "ok", annotations: {}, startedAt: started, endedAt: started + 10, durationMs: 10, children: [] },
          summary: { traceId: `trace-${id}`, messageId: id, totalDurationMs: 10, spanCount: 1, stages: [] }, spans: [] } as any);
    }
    store.beginTurn(thread, "turn-interrupted", "Question whose native work was interrupted");
    expect(store.recoverInterrupted()).toBe(1);
    const interruptedAgent = store.messages("evidence", 1000).find(m => m.turnId === "turn-interrupted" && m.actor === "agent")!;
    expect(interruptedAgent.meta?.turnStatus).toBe("interrupted");
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => viewer.app.fetch(request) });
    cleanup.unshift(["server", () => server.stop(true)]);
    const origin = `http://127.0.0.1:${server.port}`;
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    cleanup.unshift(["browser", () => browser.close()]);
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    page.on("pageerror", (e: Error) => report.errors.push(`pageerror: ${e.message}`));
    page.on("response", (r: any) => { if (r.status() >= 400) report.failedResponses.push({ status: r.status(), url: r.url().replace(origin, "").slice(0, 100) }); });
    // The browser copy holds what only this tab observed for the interrupted turn: a failed local
    // completion with an observed tool result. This is the pre-reload legacy state of a real tab.
    // Seed from a same-origin JSON page: the app must not have loaded the thread before the seed exists.
    await page.goto(`${origin}/api/threads`);
    await page.evaluate(([marker]: string[]) => localStorage.setItem("foundry:msgs:evidence", JSON.stringify([
      { turnId: "turn-interrupted", actor: "agent", content: marker, timestamp: Date.now(), meta: { persistence: "failed", nativeOutcome: "unknown", observedToolOutput: marker } },
    ])), [MARKER]);
    await page.goto(`${origin}/#thread=evidence`);
    await page.locator(".chat-history-oldest, .chat-history-older").first().waitFor();
    await page.locator(`.chat-msg[data-turn-id="turn-interrupted"][data-actor="agent"]`).waitFor();
    const merged = await page.evaluate(() => { const rows = JSON.parse(localStorage.getItem("foundry:msgs:evidence") ?? "[]"); const row = rows.find((r: any) => r.turnId === "turn-interrupted" && r.actor === "agent"); return { rows: rows.length, storage: row?.storage, evidence: row?.meta?.browserFailureEvidence?.observedToolOutput ?? null, content: row?.content, saved: row?.browserStorage?.status }; });
    const shot = async (name: string) => { await page.screenshot({ path: join(out, `${name}.png`) }); report.screenshots.push(name); };
    await shot("1440-merged-interrupted-with-evidence");
    check("reconciliation keeps the observed tool result beside the server's interrupted record", merged.storage === "server" && merged.evidence === MARKER && merged.content !== MARKER && merged.saved === "saved", merged);
    // Quota: the full snapshot no longer fits; only browser-only content may be written.
    const limit = await page.evaluate(() => { const set = Storage.prototype.setItem; const limit = Math.floor((localStorage.getItem("foundry:msgs:evidence") ?? "").length * 0.5);
      Storage.prototype.setItem = function (k: string, v: string) { if (this === localStorage && k.startsWith("foundry:msgs:") && !k.includes("legacy-backup") && v.length > limit) throw new DOMException("Controlled quota rejection", "QuotaExceededError"); return set.call(this, k, v); }; return limit; });
    await page.locator(".chat-input").fill("Another controlled question under quota"); await page.locator(".chat-input").press("Enter");
    await page.locator(".chat-agent > .chat-msg-content").filter({ hasText: "CONTROLLED_LIVE_RESULT" }).first().waitFor();
    const afterQuota = await page.evaluate(([marker]: string[]) => { const rows = JSON.parse(localStorage.getItem("foundry:msgs:evidence") ?? "[]"); return { limit: 0, savedRows: rows.length, savedEvidence: rows.some((r: any) => r.turnId === "turn-interrupted" && r.meta?.browserFailureEvidence?.observedToolOutput === marker), savedHeavy: JSON.stringify(rows).includes("filler filler filler filler filler filler filler filler filler filler filler filler"), projection: rows.find((r: any) => r.turnId === "turn-interrupted")?.browserEvidenceProjection ?? false,
      warnings: document.querySelectorAll(".chat-storage-warning").length, cacheStatus: document.querySelector(".chat-cache-status")?.textContent ?? null }; }, [MARKER]);
    afterQuota.limit = limit;
    await shot("1440-quota-transient-write");
    check("quota fallback writes the evidence projection (small) and omits plain durable rows; one scoped status, no per-row warning on the evidence row", afterQuota.savedEvidence && afterQuota.projection === true && !afterQuota.savedHeavy && afterQuota.savedRows < 10 && afterQuota.warnings === 0 && /server-saved rows are not cached/.test(afterQuota.cacheStatus ?? ""), afterQuota);
    // Reload: server history returns; the evidence must be back on the interrupted row and inspectable.
    await page.reload();
    await page.locator(`.chat-msg[data-turn-id="turn-interrupted"][data-actor="agent"]`).waitFor();
    const row = page.locator(`.chat-msg[data-turn-id="turn-interrupted"][data-actor="agent"]`);
    const rowText = await row.innerText();
    const evidenceVisible = rowText.includes(MARKER) || (await page.getByText(MARKER, { exact: false }).count()) > 0;
    // Open the failure evidence disclosure by its stable summary text.
    const disclosure = row.locator("summary").filter({ hasText: /failure evidence/i });
    const disclosureCount = await disclosure.count();
    if (disclosureCount) await disclosure.first().click();
    const rowTextOpen = await row.innerText();
    const afterReload = { disclosureCount, evidenceVisible: evidenceVisible || rowTextOpen.includes(MARKER), serverContentVisible: /restarted before recording completion|interrupted/i.test(rowTextOpen), distinct: rowTextOpen.includes(MARKER) && /restarted before recording completion|interrupted/i.test(rowTextOpen), rows: await page.locator(".chat-msg").count(),
      local: await page.evaluate(([marker]: string[]) => { const rows = JSON.parse(localStorage.getItem("foundry:msgs:evidence") ?? "[]"); return { rows: rows.length, evidence: rows.some((r: any) => r.meta?.browserFailureEvidence?.observedToolOutput === marker) }; }, [MARKER]) };
    await shot("1440-after-reload-evidence-inspectable");
    check("after reload the browser-only evidence is inspectable on the interrupted row and the server's interrupted record is still shown, distinct", afterReload.evidenceVisible && afterReload.serverContentVisible && afterReload.distinct && afterReload.local.evidence, afterReload);
    // Fully refused writes: the evidence row is volatile with a tab-only notice; nothing is discarded.
    await page.evaluate(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k: string, v: string) { if (this === localStorage && k.startsWith("foundry:msgs:")) throw new DOMException("Controlled quota rejection", "QuotaExceededError"); return set.call(this, k, v); }; });
    await page.locator(".chat-input").fill("Third controlled question, all writes refused"); await page.locator(".chat-input").press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".chat-agent .chat-msg-content").length >= 2 && [...document.querySelectorAll(".chat-agent .chat-msg-content")].filter(e => e.textContent?.includes("CONTROLLED_LIVE_RESULT")).length >= 1);
    await page.waitForFunction(() => document.querySelectorAll(".chat-storage-warning").length >= 1);
    // The load-time write after reload succeeded, so the retained snapshot already holds the evidence row;
    // a later refused write must not discard that snapshot, and only the rows never saved may warn.
    const refused = { warningTexts: (await page.locator(".chat-storage-warning").allInnerTexts()) as string[], evidenceStillVisible: (await page.getByText(MARKER, { exact: false }).count()) > 0, rowWarning: await row.locator(".chat-storage-warning").count(),
      snapshotStillHoldsEvidence: await page.evaluate(([marker]: string[]) => (localStorage.getItem("foundry:msgs:evidence") ?? "").includes(marker), [MARKER]) };
    await shot("1440-all-refused-evidence-row-notice");
    check("fully refused writes: the retained snapshot still holds the evidence row (no notice needed on it), the never-saved new rows warn, evidence stays visible", refused.rowWarning === 0 && refused.snapshotStillHoldsEvidence && refused.warningTexts.length >= 1 && refused.warningTexts.every((t: string) => /Browser storage failed/.test(t)) && refused.evidenceStillVisible, refused);
    await context.close();
    report.errorAttribution = { consoleErrors: report.errors.length, failedResponses: report.failedResponses };
    check("no page exceptions; any failed responses are recorded by URL", report.errors.length === 0, report.errorAttribution);
  } finally {
    report.cleanupFailures = await releaseAll(cleanup);
    report.finishedAt = new Date().toISOString();
    report.summary = { assertions: report.assertions.length, ok: report.assertions.filter((a: any) => a.ok).length, failed: report.assertions.filter((a: any) => !a.ok).map((a: any) => a.name), screenshots: report.screenshots.length };
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
    console.log(`G6 evidence-cache report: ${join(out, "report.json")}`);
  }
  expect(report.cleanupFailures).toEqual([]);
  expect(report.summary.failed).toEqual([]);
}, 120_000);
