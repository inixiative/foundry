import { test, expect } from "bun:test";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { ContextLayer, ContextStack, EventStream, Harness, InterventionLog, type LLMMessage, type LLMProvider } from "@inixiative/foundry-core";
import { ThreadRuntimeManager } from "../../src/agents/thread-runtime";
import { ThreadFactory, buildAgents } from "../../src/agents/thread-factory";
import { ConfigStore, starterConfig } from "../../src/viewer/config";
import { createViewer } from "../../src/viewer/server";
import { releaseAll, type ReleaseStep } from "../helpers/release-all";

// G6 long-history AFTER-run. Same seeded fixture as the 13:40Z baseline (controlled
// executor, no native or model process; native-shaped rows are labelled fixture data),
// fresh unique output directory per run, explicit after-acceptance assertions.
// Opt-in: needs the QA Playwright runtime (FOUNDRY_QA_PLAYWRIGHT) and Chrome.
const { chromium } = createRequire(import.meta.url)(process.env.FOUNDRY_QA_PLAYWRIGHT ?? "playwright");
const root = resolve(import.meta.dir, "../../../..");
const ROW_REPEAT = Number(process.env.G6_ROW_REPEAT ?? 400);
const WAIT = Number(process.env.G6_WAIT_MS ?? 15_000);
const out = process.env.G6_OUT ? resolve(process.env.G6_OUT) : resolve(root, ".foundry/qa", `g6-history-after-${new Date().toISOString().replaceAll(":", "-")}-r${ROW_REPEAT}`);
if (existsSync(out) && !process.env.G6_OUT) throw new Error(`Refusing to reuse an existing output directory: ${out}`);
mkdirSync(out, { recursive: true });
const project = resolve(root, "fixtures/harness-qa/sample-projects/release-notes");
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const report: any = { scope: "AFTER-run: controlled fixture over production viewer/SQLite/routes/UI with the G6 history index; no native or model process; not native evidence.",
  rowRepeat: ROW_REPEAT, startedAt: new Date().toISOString(), seed: {}, payload: {}, browser: {}, assertions: [], screenshots: [], errors: [], failedResponses: [], sourceHashes: {} };
const check = (name: string, ok: boolean, detail: unknown = {}) => { report.assertions.push({ name, ok, detail }); return ok; };

/** Expand collapsed drawer sections by their stable title, re-resolving after each click (section lists re-render). */
async function expandSections(drawer: any, titles: RegExp[]) {
  for (const title of titles) {
    // Match the header that directly holds this title (an ancestor section would also "have" it).
    const header = drawer.locator(".detail-section-header").filter({ has: drawer.page().locator(".detail-section-title", { hasText: title }) }).first();
    if (!(await header.count())) continue;
    const caret = header.locator(".detail-caret").first();
    if ((await caret.innerText()).trim() === "▶") { await header.click(); await drawer.page().waitForFunction((t: string) => [...document.querySelectorAll(".detail-section-header")].some(h => new RegExp(t, "i").test(h.querySelector(".detail-section-title")?.textContent ?? "") && h.querySelector(".detail-caret")?.textContent?.trim() === "▼"), title.source); }
  }
}

test("long history after-run: index pagination to the oldest record, lazy detail, artifacts, cache policy, offline, reorder, inactive reconcile, mobile", async () => {
  for (const f of ["packages/foundry/src/viewer/ui/store.js", "packages/foundry/src/viewer/ui/conversation.js", "packages/foundry/src/viewer/ui/conversation-state.js",
    "packages/foundry/src/viewer/ui/detail-drawer.js", "packages/foundry/src/viewer/ui/styles.css", "packages/foundry/src/viewer/routes/runtime.ts", "packages/foundry/src/persistence/local-session-store.ts"])
    report.sourceHashes[f] = sha(readFileSync(join(root, f)));
  const cleanup: ReleaseStep[] = [];
  let providerCalls = 0, nativeObservations = 0;
  const readme = readFileSync(join(project, "README.md"), "utf8");
  try {
    const config = starterConfig("controlled", "controlled"); config.setupComplete = true;
    config.agents = { worker: { id: "worker", kind: "executor", provider: "controlled", model: "controlled", prompt: "Answer the release-notes question briefly.", temperature: 0, visibleLayers: ["conventions"], peers: [], maxDepth: 1, enabled: true } } as any;
    config.layers = { conventions: { id: "conventions", prompt: "Release Notes QA project conventions", sourceIds: [], staleness: 0, enabled: true, segment: "domain-knowledge" } } as any;
    const layer = new ContextLayer({ id: "conventions", prompt: "Release Notes QA project conventions", segment: "domain-knowledge" });
    layer.set(`CURRENT_CONVENTIONS_V2\n${readme}`);
    const stack = new ContextStack([layer]); const events = new EventStream();
    const provider: LLMProvider = { id: "controlled",
      async complete(messages: LLMMessage[], opts: any) { providerCalls++; if (opts?.nativeObservation) nativeObservations++; const last = String(messages.at(-1)?.content ?? "");
        return { model: "controlled", content: last.includes("unsaved") ? "CONTROLLED_UNSAVED_RESULT: grouped release notes drafted (browser-only evidence expected)" : "CONTROLLED_LIVE_RESULT: release notes grouped" }; },
      stream: async function* (messages: LLMMessage[]) { providerCalls++; const last = String(messages.at(-1)?.content ?? "");
        yield { type: "text", text: last.includes("unsaved") ? "CONTROLLED_UNSAVED_RESULT: grouped release notes drafted (browser-only evidence expected)" : "CONTROLLED_LIVE_RESULT: release notes grouped" }; } } as any;
    const runtime = new ThreadRuntimeManager({ config, log() {}, warn() {}, eventStream: events, domains: [],
      llm: { id: "controlled-routing", async complete() { return { model: "deterministic", content: '{"domains":[],"layers":["conventions"],"snippets":[],"confidence":1}' }; } } } as any);
    cleanup.push(["runtime", () => runtime.disposeAll()]);
    const factory = new ThreadFactory({ stack, runtime, agents: buildAgents(config, stack, { provider }) });
    const main = factory.create("release-notes", { cwd: project, projectId: "release-notes-qa" });
    const side = factory.create("release-notes-side", { cwd: project, projectId: "release-notes-qa" });
    const harness = new Harness(main); harness.setDefaultExecutor("worker");
    const configDir = join(out, "state"); mkdirSync(configDir, { recursive: true });
    const configStore = new ConfigStore(configDir); await configStore.save(config);
    const viewer = createViewer({ harness, eventStream: events, interventions: new InterventionLog(main.signals), configStore, configDir, threadFactory: factory });
    cleanup.unshift(["store", () => viewer.localStore?.close()]);
    const store = viewer.localStore!;
    // ---- seed via actual journal APIs (identical shape to the baseline fixture) ----
    const bigDomain = (i: number) => `[controlled fixture: domain knowledge snapshot for turn ${i}]\n${readme}\n` + "release-notes convention line ".repeat(ROW_REPEAT);
    const bigThread = (i: number) => `[controlled fixture: thread knowledge for turn ${i}]\n` + "prior decision recorded ".repeat(200);
    const seedTurn = (thread: typeof main, n: number, marker?: string) => {
      const turnId = `seed-${thread.id}-${String(n).padStart(3, "0")}`;
      const user = `Seeded question ${n}: how should the --group flag order Added before Fixed?${marker ? ` ${marker}_QUESTION` : ""}`;
      store.beginTurn(thread, turnId, user);
      const blocks = [
        { id: "conventions", kind: "instructions", source: "conventions", text: "Release Notes QA project conventions", hash: sha("p").slice(0, 16), tokens: 6 },
        { id: "conventions", kind: "domain-knowledge", source: "conventions", text: bigDomain(n), hash: sha(bigDomain(n)).slice(0, 16), tokens: 3000 },
        { id: "thread-knowledge:conventions", kind: "thread-knowledge", source: "thread-knowledge:conventions", text: bigThread(n), hash: sha(bigThread(n)).slice(0, 16), tokens: 800 },
      ];
      const layers = [{ definitionId: "conventions", threadId: thread.id, id: "conventions", prompt: "Release Notes QA project conventions", sourceIds: [], included: true,
        segment: "domain-knowledge", content: bigDomain(n), hash: sha(bigDomain(n)).slice(0, 16), state: "warm", lastWarmed: 1, lastAccessed: 1 }];
      const injection = { userMessage: user, blocks, text: blocks.map(b => b.text).join("\n\n"), tokens: 3806, capturedAt: Date.now(), threadId: thread.id,
        executorContext: "controlled fixture", providerMessages: [{ role: "system", content: "Release Notes QA project conventions" }, { role: "user", content: user }], layers,
        plan: { controlledFixture: true, note: "seeded historical injection; not a live dispatch" } };
      const started = Date.now() - (1000 - n) * 60_000;
      const exec = { id: `span-exec-${turnId}`, parentId: `span-ingress-${turnId}`, name: "execute:worker", kind: "execute", agentId: "worker", threadId: thread.id, status: "ok",
        input: user, output: `Seeded answer ${n}`, annotations: { invocation: { controlledFixture: true }, injection,
          ...(n % 10 === 0 ? { native: { schema: 1, nativeOutcome: "completed", localOutcome: "resolved", transportOutcome: "open", terminal: { type: "controlled-fixture-terminal", subtype: "not-native-evidence" }, controlledFixture: true } } : {}) },
        startedAt: started + 5, endedAt: started + 95, durationMs: 90 };
      const ingress = { id: `span-ingress-${turnId}`, name: "ingress", kind: "ingress", threadId: thread.id, status: "ok", input: user, annotations: {}, startedAt: started, endedAt: started + 100, durationMs: 100 };
      const trace = { id: `trace-${turnId}`, messageId: turnId, startedAt: started, endedAt: started + 100, durationMs: 100, root: { ...ingress, children: [exec] },
        summary: { traceId: `trace-${turnId}`, messageId: turnId, totalDurationMs: 100, spanCount: 2, stages: [{ name: "ingress", kind: "ingress", status: "ok", durationMs: 100, depth: 0 }, { name: "execute:worker", kind: "execute", status: "ok", durationMs: 90, depth: 1 }] }, spans: [] };
      const agent = `Seeded answer ${n}: Added entries precede Fixed entries; input order is preserved within each group.${marker ? ` ${marker}` : ""}`;
      store.completeTurn(thread, turnId, agent, { injection, injectedLayers: [{ id: "conventions", hash: sha(bigDomain(n)).slice(0, 16), tokens: Math.ceil(bigDomain(n).length / 4) }], executionOutcome: "completed", persistence: "committed", turnStatus: "completed", controlledFixture: true,
        // Realistic opaque provider metadata: belongs to owned detail, never to the index.
        providerTranscript: `OPAQUE_PROVIDER_TRANSCRIPT_${turnId}\n${bigThread(n)}`,
        ...(n % 10 === 0 ? { nativeHistory: [{ schema: 1, owner: { threadId: thread.id, projectId: "release-notes-qa", generation: "fixture", messageId: turnId, dispatchId: `d-${turnId}` }, admissionId: `fixture-${turnId}`,
          nativeOutcome: "completed", localOutcome: "resolved", terminal: { type: "controlled-fixture-terminal", subtype: "not-native-evidence" }, content: agent, kind: "result", observedAt: started + 90 }] } : {}) }, trace as any);
      return turnId;
    };
    const oldest = seedTurn(main, 1, "ARTIFACT_MARKER_OLDEST_release_md");
    seedTurn(main, 2, "ARTIFACT_MARKER_SECOND_group_diff");
    for (let n = 3; n <= 160; n++) seedTurn(main, n);
    for (let n = 1; n <= 60; n++) seedTurn(side, n, n === 1 ? "SIDE_OLDEST_MARKER" : undefined);
    report.seed = { mainTurns: 160, sideTurns: 60, mainMessages: store.messages("release-notes", 10000).length, sideMessages: store.messages("release-notes-side", 10000).length, oldestTurn: oldest,
      note: "native-shaped rows are labelled controlled-fixture-terminal / not-native-evidence" };
    const sql = (store as unknown as { db: Database }).db;
    sql.exec(`CREATE TEMP TRIGGER reject_unsaved BEFORE INSERT ON session_messages WHEN NEW.actor='agent' AND NEW.record LIKE '%CONTROLLED_UNSAVED_RESULT%' BEGIN SELECT RAISE(ABORT, 'CONTROLLED-COMMIT-REJECTION'); END`);
    // ---- owned temporary server ----
    const unsub = new Map<object, () => void>();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, s) { if (new URL(req.url).pathname === "/ws") return s.upgrade(req) ? undefined : new Response("Upgrade required", { status: 400 }); return viewer.app.fetch(req); },
      websocket: { open(ws) { unsub.set(ws, events.subscribe(e => ws.send(JSON.stringify(e)))); }, message() {}, close(ws) { unsub.get(ws)?.(); unsub.delete(ws); } } });
    cleanup.unshift(["server", () => server.stop(true)]);
    const origin = `http://127.0.0.1:${server.port}`;

    // ---- payload: index vs unchanged full route (bytes and counts only) ----
    const get = async (path: string) => { const res = await fetch(`${origin}${path}`); const raw = await res.text(); return { status: res.status, bytes: Buffer.byteLength(raw), raw, json: (() => { try { return JSON.parse(raw); } catch { return null; } })() }; };
    const legacy = await get("/api/messages?threadId=release-notes");
    const first = await get("/api/threads/release-notes/history");
    // Equal-row comparisons: 50 vs 50 and 100 vs 100, so size claims compare the same rows.
    const legacy50 = await get("/api/messages?threadId=release-notes&limit=50");
    const index100 = await get("/api/threads/release-notes/history?limit=100");
    const walk: { pages: number; ids: Set<string>; bytes: number; last: any } = { pages: 1, ids: new Set(first.json.messages.map((m: any) => m.id)), bytes: first.bytes, last: first.json };
    let cursor = first.json.nextCursor; const secondPage = cursor ? await get(`/api/threads/release-notes/history?before=${encodeURIComponent(cursor)}`) : null;
    const secondAgain = cursor ? await get(`/api/threads/release-notes/history?before=${encodeURIComponent(cursor)}`) : null;
    while (cursor) { const page = await get(`/api/threads/release-notes/history?before=${encodeURIComponent(cursor)}`); walk.pages++; walk.bytes += page.bytes; for (const m of page.json.messages) walk.ids.add(m.id); cursor = page.json.nextCursor; walk.last = page.json; if (walk.pages > 20) break; }
    const sideFirst = await get("/api/threads/release-notes-side/history");
    const cross = await get(`/api/threads/release-notes/history?before=${encodeURIComponent(sideFirst.json.nextCursor)}`);
    const malformed = await get("/api/threads/release-notes/history?before=zzz");
    const detail = await get(`/api/threads/release-notes/turns/${oldest}/detail`);
    report.payload = { fullRouteDefault: { status: legacy.status, messages: legacy.json.messages.length, bytes: legacy.bytes, hasInjection: legacy.raw.includes('"injection"') },
      equalRows: { full50: { messages: legacy50.json.messages.length, bytes: legacy50.bytes }, index50: { messages: first.json.messages.length, bytes: first.bytes }, full100: { messages: legacy.json.messages.length, bytes: legacy.bytes }, index100: { messages: index100.json.messages.length, bytes: index100.bytes },
        sameRows50: JSON.stringify(legacy50.json.messages.map((m: any) => m.id)) === JSON.stringify(first.json.messages.map((m: any) => m.id)), sameRows100: JSON.stringify(legacy.json.messages.map((m: any) => m.id)) === JSON.stringify(index100.json.messages.map((m: any) => m.id)) },
      indexFirstPage: { status: first.status, messages: first.json.messages.length, bytes: first.bytes, hasMore: first.json.hasMore, oldestReached: first.json.oldestReached, hasInjection: first.raw.includes('"injection":{'), hasNativeHistoryPayload: first.raw.includes('"nativeHistory":[') },
      walk: { pages: walk.pages, uniqueMessages: walk.ids.size, totalBytes: walk.bytes, lastOldestReached: walk.last.oldestReached, oldestMarkerInLastPage: JSON.stringify(walk.last).includes("ARTIFACT_MARKER_OLDEST") },
      repeatedCursorIdentical: !!secondPage && secondPage.raw === secondAgain!.raw, crossThreadCursorStatus: cross.status, malformedCursorStatus: malformed.status,
      oldestDetail: { status: detail.status, bytes: detail.bytes, injectionText: typeof detail.json?.injection?.text === "string", artifacts: detail.json?.artifacts?.map((a: any) => a.kind) } };
    check("full-history route unchanged: 100 rows with injection payloads", legacy.status === 200 && legacy.json.messages.length === 100 && report.payload.fullRouteDefault.hasInjection, report.payload.fullRouteDefault);
    report.payload.indexFirstPage.hasOpaqueTranscript = first.raw.includes("OPAQUE_PROVIDER_TRANSCRIPT_");
    report.payload.indexFirstPage.detailOnlyMetaSample = first.json.messages.find((m: any) => m.actor === "agent")?.detail?.detailOnlyMeta ?? null;
    report.payload.oldestDetailHasTranscript = detail.raw.includes(`OPAQUE_PROVIDER_TRANSCRIPT_${oldest}`);
    check("index first page: 50 summaries, no injection, native or opaque transcript payload, names detail-only metadata, advertises more", first.json.messages.length === 50 && first.json.hasMore === true && !report.payload.indexFirstPage.hasInjection && !report.payload.indexFirstPage.hasNativeHistoryPayload && !report.payload.indexFirstPage.hasOpaqueTranscript && (report.payload.indexFirstPage.detailOnlyMetaSample ?? []).includes("providerTranscript") && report.payload.oldestDetailHasTranscript, report.payload.indexFirstPage);
    check("index pages are at least 20x smaller than the full route for the SAME rows (50 vs 50, 100 vs 100)", report.payload.equalRows.sameRows50 && report.payload.equalRows.sameRows100 && first.bytes * 20 < legacy50.bytes && index100.bytes * 20 < legacy.bytes, report.payload.equalRows);
    check("cursor walk reaches the oldest record exactly once (320 unique) and says so", walk.ids.size === 320 && walk.last.oldestReached === true && report.payload.walk.oldestMarkerInLastPage, report.payload.walk);
    check("repeated cursor returns the identical page; cross-thread and malformed cursors are 400", report.payload.repeatedCursorIdentical && cross.status === 400 && malformed.status === 400, report.payload);
    check("oldest turn detail carries the recorded injection and artifact links", detail.status === 200 && report.payload.oldestDetail.injectionText && report.payload.oldestDetail.artifacts.includes("trace"), report.payload.oldestDetail);

    // ---- browser ----
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    cleanup.unshift(["browser", () => browser.close()]);
    const shot = async (p: any, name: string) => { await p.screenshot({ path: join(out, `${name}.png`), fullPage: false }); report.screenshots.push(name); };
    // Every failed response is recorded with its URL so console errors are attributed from evidence, not assumed.
    const attach = (p: any, label: string) => { p.setDefaultTimeout(WAIT); p.on("pageerror", (e: Error) => report.errors.push(`${label} pageerror: ${e.message}`)); p.on("console", (m: any) => { if (m.type() === "error") report.errors.push(`${label} console: ${m.text().slice(0, 200)}`); });
      p.on("response", (r: any) => { if (r.status() >= 400) report.failedResponses.push({ label, status: r.status(), url: r.url().replace(origin, "").slice(0, 120) }); });
      p.on("requestfailed", (r: any) => report.failedResponses.push({ label, status: "request-failed", url: r.url().replace(origin, "").slice(0, 120), reason: r.failure()?.errorText })); };
    const overflow = (p: any) => p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    const count = (p: any, sel: string) => p.locator(sel).count();
    const loadAllOlder = async (p: any) => { let clicks = 0; while (await p.locator(".chat-history-older").count()) { await p.locator(".chat-history-older").click(); await p.waitForFunction(() => !document.querySelector(".chat-history-older:disabled")); if (++clicks > 40) break; } await p.locator(".chat-history-oldest").waitFor(); return clicks; };
    const localBytes = (p: any, thread: string) => p.evaluate((t: string) => { const raw = localStorage.getItem(`foundry:msgs:${t}`) ?? ""; const rows = raw ? JSON.parse(raw) : []; return { bytes: raw.length, rows: rows.length, withInjection: rows.filter((m: any) => m.meta && "injection" in m.meta).length }; }, thread);

    const desk = await browser.newContext({ viewport: { width: 1440, height: 960 } }); const page = await desk.newPage(); attach(page, "1440");
    const t0 = performance.now(); await page.goto(`${origin}/#thread=release-notes`);
    await page.locator(".chat-history-older").waitFor();
    report.timing = { initialLoadMs: Math.round(performance.now() - t0) };
    const initial = { visible: await count(page, ".chat-msg"), warnings: await count(page, ".chat-storage-warning"), cacheStatus: await count(page, ".chat-cache-status"), local: await localBytes(page, "release-notes") };
    await page.evaluate(() => { const el = document.querySelector(".chat-messages"); if (el) el.scrollTop = 0; });
    await shot(page, "1440-initial-top-with-older-control");
    check("1440 initial: exactly 50 index rows, an older control, zero storage warnings, browser copy without injection payloads", initial.visible === 50 && initial.warnings === 0 && initial.local.withInjection === 0 && initial.local.rows === 50, initial);
    // scroll anchoring: the top-visible row must stay in place when older rows arrive above
    await page.evaluate(() => { const el = document.querySelector(".chat-messages")!; el.scrollTop = 0; });
    // The reader's row is identified by turn and actor, not by a text prefix (time labels repeat across rows).
    const anchorId = await page.locator(".chat-msg").first().evaluate((el: Element) => ({ turn: el.getAttribute("data-turn-id"), actor: el.getAttribute("data-actor") }));
    const anchorRow = page.locator(`.chat-msg[data-turn-id="${anchorId.turn}"][data-actor="${anchorId.actor}"]`);
    const before = await anchorRow.boundingBox();
    const scrollBefore = await page.evaluate(() => { const el = document.querySelector(".chat-messages")!; return { top: el.scrollTop, height: el.scrollHeight }; });
    await page.locator(".chat-history-older").click(); await page.waitForFunction(() => document.querySelectorAll(".chat-msg").length >= 100);
    await page.waitForTimeout(200);
    const anchorAfter = await anchorRow.boundingBox();
    const scrollAfter = await page.evaluate(() => { const el = document.querySelector(".chat-messages")!; return { top: el.scrollTop, height: el.scrollHeight }; });
    const order = await page.evaluate(() => [...document.querySelectorAll(".chat-msg")].map(el => el.getAttribute("data-turn-id")));
    const ordered = order.every((id: string, i: number) => i === 0 || id === null || order[i - 1] === null || order[i - 1]! <= id); // seed ids are zero-padded, so lexical order is seq order
    report.browser.anchoring = { anchor: anchorId, before: before?.y, after: anchorAfter?.y, scrollBefore, scrollAfter, visibleAfterOnePage: await count(page, ".chat-msg"), orderedBySeq: ordered, firstTurnAfter: order[0] };
    check("older page prepends above in journal order without moving the reader's row (within 2px)", !!before && !!anchorAfter && Math.abs(anchorAfter.y - before.y) <= 2 && ordered && order[0] === "seed-release-notes-111" && report.browser.anchoring.visibleAfterOnePage === 100, report.browser.anchoring);
    const clicks = await loadAllOlder(page);
    const reached = { clicks, visible: await count(page, ".chat-msg"), oldestMarker: await page.getByText("ARTIFACT_MARKER_OLDEST_release_md", { exact: false }).count(), oldestLabel: await page.locator(".chat-history-oldest").innerText(), uniqueTurns: await page.evaluate(() => new Set(JSON.parse(localStorage.getItem("foundry:msgs:release-notes")!).map((m: any) => `${m.turnId}:${m.actor}`)).size), local: await localBytes(page, "release-notes") };
    await page.evaluate(() => { const el = document.querySelector(".chat-messages"); if (el) el.scrollTop = 0; });
    await shot(page, "1440-oldest-reached-top");
    check("1440: loading older pages reaches all 320 seeded rows, the oldest marker and an explicit oldest-record label, no duplicates", reached.visible === 320 && reached.oldestMarker >= 1 && /Oldest record reached/.test(reached.oldestLabel) && reached.uniqueTurns === 320, reached);
    // historical inspection of the OLDEST turn (lazy detail)
    const oldestAgent = page.locator(".chat-agent").filter({ hasText: "ARTIFACT_MARKER_OLDEST_release_md" }).first();
    await oldestAgent.scrollIntoViewIfNeeded(); await oldestAgent.locator(".chat-trace-btn").click();
    await page.locator(".historical-detail-status[data-status='loaded']").waitFor();
    await page.getByRole("button", { name: "Turn Context" }).click();
    await page.getByText("CONTRIBUTIONS", { exact: false }).first().waitFor();
    const drawer = page.locator(".detail-drawer").first();
    await expandSections(drawer, [/^Layer snapshots/i, /^conventions \/ included/i, /^Cached content/i]);
    const drawerText = await drawer.innerText();
    const links = await drawer.locator("a[href]").evaluateAll((els: any[]) => els.map(e => e.getAttribute("href")));
    report.browser.inspection = { contributions: /CONTRIBUTIONS/i.test(drawerText), layerSnapshots: /LAYER SNAPSHOTS/i.test(drawerText), domainKind: /DOMAIN-KNOWLEDGE/.test(drawerText), threadKind: /THREAD-KNOWLEDGE/.test(drawerText),
      historicalSnapshotTurn: /domain knowledge snapshot for turn (\d+)\]/.exec(drawerText)?.[1] ?? null, selectedTurn: /seed-release-notes-001/.test(drawerText), detailLoaded: /Owned turn detail loaded/.test(drawerText), links,
      preparedInput: /Prepared initial provider messages|providerMessages/i.test(drawerText), rawLinkStatus: null as number | null, rawLinkMessageId: null as string | null };
    await shot(page, "1440-oldest-turn-context-lazy-detail");
    // artifact navigation: the trace link opens the recorded artifact
    const traceHref = links.find((h: string) => h.startsWith("/api/traces/"));
    if (traceHref) { const [popup] = await Promise.all([desk.waitForEvent("page"), drawer.locator(`a[href="${traceHref}"]`).click()]); await popup.waitForLoadState(); const text = await popup.evaluate(() => document.body.innerText); report.browser.inspection.rawLinkStatus = 200; report.browser.inspection.rawLinkMessageId = /"messageId":\s*"([^"]+)"/.exec(text)?.[1] ?? null; await shot(popup, "1440-artifact-trace-json"); await popup.close(); }
    check("oldest turn: lazily loaded detail shows selected turn, contributions, layer snapshot for turn 1 and prepared input", report.browser.inspection.detailLoaded && report.browser.inspection.selectedTurn && report.browser.inspection.contributions && report.browser.inspection.layerSnapshots && report.browser.inspection.historicalSnapshotTurn === "1" && report.browser.inspection.preparedInput, report.browser.inspection);
    check("oldest turn: artifact links exist and the trace link opens the recorded trace for seed turn 1", links.length >= 2 && report.browser.inspection.rawLinkMessageId === "seed-release-notes-001", { links, id: report.browser.inspection.rawLinkMessageId });
    await page.setViewportSize({ width: 1024, height: 900 }); report.browser.narrowDesktopOverflow = await overflow(page); await shot(page, "1024-drawer-wrapping"); await page.setViewportSize({ width: 1440, height: 960 });
    // completed-unsaved through the real composer, then reload
    await page.locator(".chat-input").fill("Draft the grouped release notes (unsaved)"); await page.locator(".chat-input").press("Enter");
    await page.locator(".chat-agent > .chat-msg-content").filter({ hasText: "CONTROLLED_UNSAVED_RESULT" }).first().waitFor();
    const unsavedNotice = await page.getByText(/result was not saved to local journal/).count();
    await shot(page, "1440-completed-unsaved");
    await page.reload(); await page.locator(".chat-history-older, .chat-history-oldest").first().waitFor();
    const afterReload = { unsavedVisible: await page.locator(".chat-agent").filter({ hasText: "CONTROLLED_UNSAVED_RESULT" }).count(), visible: await count(page, ".chat-msg"), warnings: await count(page, ".chat-storage-warning"), cacheStatus: await count(page, ".chat-cache-status"), local: await localBytes(page, "release-notes") };
    await shot(page, "1440-after-reload");
    check("completed-unsaved result is labelled and survives reload with the walked history intact", unsavedNotice > 0 && afterReload.unsavedVisible === 1 && afterReload.visible >= 322, afterReload);
    // quota case A: durable snapshot refused, transient snapshot fits → one scoped status, evidence survives reload
    // Quota relative to the current snapshot: a full write (all rows) is refused, a transient-only write
    // (the unsaved completion with its inline evidence plus new browser-only rows) fits at any row size.
    const quotaLimit = await page.evaluate(() => { const set = Storage.prototype.setItem; const limit = Math.floor((localStorage.getItem("foundry:msgs:release-notes") ?? "").length * 0.5);
      Storage.prototype.setItem = function (k: string, v: string) { if (this === localStorage && k.startsWith("foundry:msgs:") && !k.includes("legacy-backup") && v.length > limit) throw new DOMException("Controlled quota rejection", "QuotaExceededError"); return set.call(this, k, v); }; return limit; });
    await page.locator(".chat-input").fill("Second controlled question after quota denial"); await page.locator(".chat-input").press("Enter");
    await page.locator(".chat-agent > .chat-msg-content").filter({ hasText: "CONTROLLED_LIVE_RESULT" }).first().waitFor();
    const quotaA = { quotaLimit, warnings: await count(page, ".chat-storage-warning"), cacheStatus: await count(page, ".chat-cache-status"), statusText: (await page.locator(".chat-cache-status").first().innerText().catch(() => "")), visible: await count(page, ".chat-msg"), local: await localBytes(page, "release-notes") };
    await page.evaluate(() => { const el = document.querySelector(".chat-messages"); if (el) el.scrollTop = 0; }); await shot(page, "1440-quota-scoped-status");
    check("quota (durable refused): one scoped status, no per-row storage warnings on durable rows, prior history intact, transient copy written", quotaA.cacheStatus === 1 && quotaA.warnings <= 1 && /server-saved rows are not cached/.test(quotaA.statusText) && quotaA.visible >= 324 && quotaA.local.rows > 0 && quotaA.local.rows < 20, quotaA);
    // quota persists across reload for this context: the browser copy now holds transient rows only; the server supplies the rest
    await page.reload(); await page.locator(".chat-history-older, .chat-history-oldest").first().waitFor();
    // Expected rows: the newest index page (50, which already contains the quota send's own journalled rows
    // and the unsaved turn's user row) plus the one browser-only unsaved completion = 51.
    const quotaReload = { unsavedVisible: await page.locator(".chat-agent").filter({ hasText: "CONTROLLED_UNSAVED_RESULT" }).count(), visible: await count(page, ".chat-msg"), olderControl: await count(page, ".chat-history-older") };
    check("after quota-limited write and reload, the browser-only unsaved completion is still present alongside the newest server page (50 + 1) with the older control available", quotaReload.unsavedVisible === 1 && quotaReload.visible === 51 && quotaReload.olderControl === 1, quotaReload);
    // quota case B: every browser write refused → per-row honesty as before, prior history intact, not 100 notices
    await page.evaluate(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k: string, v: string) { if (this === localStorage && k.startsWith("foundry:msgs:")) throw new DOMException("Controlled quota rejection", "QuotaExceededError"); return set.call(this, k, v); }; });
    await page.locator(".chat-input").fill("Third controlled question, all writes denied"); await page.locator(".chat-input").press("Enter");
    await page.locator(".chat-agent > .chat-msg-content").filter({ hasText: "CONTROLLED_LIVE_RESULT" }).nth(quotaReload.visible > 100 ? 1 : 0).waitFor().catch(() => {});
    await page.waitForFunction(() => document.querySelectorAll(".chat-agent .chat-msg-content").length >= 2);
    const quotaB = { warnings: await count(page, ".chat-storage-warning"), cacheStatus: await count(page, ".chat-cache-status"), visible: await count(page, ".chat-msg"), text: await page.locator(".chat-agent").last().innerText() };
    await shot(page, "1440-quota-all-denied");
    check("quota (all refused): the new rows carry honest per-row notices, the rest of the history is untouched, and notices stay bounded", quotaB.warnings >= 1 && quotaB.warnings <= 6 && quotaB.visible >= quotaReload.visible + 2, quotaB);
    // offline: index, full route and thread list unreachable → browser copy with explicit status
    const offline = await browser.newContext({ viewport: { width: 1440, height: 960 }, storageState: await desk.storageState() }); const off = await offline.newPage(); attach(off, "offline");
    await off.route("**/api/threads/*/history*", (r: any) => r.abort()); await off.route("**/api/messages?threadId=*", (r: any) => r.abort()); await off.route("**/api/threads", (r: any) => r.abort());
    await off.goto(`${origin}/#thread=release-notes`); await off.locator(".chat-history-pager").waitFor();
    report.browser.offline = { rows: await count(off, ".chat-msg"), unsaved: await off.locator(".chat-agent").filter({ hasText: "CONTROLLED_UNSAVED_RESULT" }).count(), pager: await off.locator(".chat-history-pager").innerText() };
    await shot(off, "1440-offline-fallback"); await offline.close();
    check("offline: browser copy renders (including the unsaved completion) with an explicit 'server history unavailable' status, never an empty history", report.browser.offline.rows > 0 && report.browser.offline.unsaved === 1 && /Server history unavailable/.test(report.browser.offline.pager), report.browser.offline);
    // delayed older page across a thread switch: the response lands in the owning thread's cache
    const fresh = await browser.newContext({ viewport: { width: 1440, height: 960 } }); const p2 = await fresh.newPage(); attach(p2, "reorder");
    let delayed = 0; await p2.route("**/api/threads/release-notes/history?*before=*", async (r: any) => { if (delayed++ === 0) await new Promise(res => setTimeout(res, 1500)); await r.continue(); });
    await p2.goto(`${origin}/#thread=release-notes`); await p2.locator(".chat-history-older").waitFor();
    await p2.locator(".chat-history-older").click();
    await p2.locator(".thread-tree-item, .thread-item, [data-thread-id]").filter({ hasText: "release-notes-side" }).first().click().catch(async () => { await p2.goto(`${origin}/#thread=release-notes-side`); });
    await p2.waitForFunction(() => document.querySelectorAll(".chat-msg").length > 0);
    const sideView = { visible: await count(p2, ".chat-msg"), mainRowsWhileOnSide: await p2.locator(".chat-msg").filter({ hasText: "Seeded question" }).filter({ hasText: /on release-notes-side|release-notes-side/ }).count() };
    await new Promise(res => setTimeout(res, 2000));
    await p2.goto(`${origin}/#thread=release-notes`); await p2.waitForFunction(() => document.querySelectorAll(".chat-msg").length >= 100);
    const backOnMain = { visible: await count(p2, ".chat-msg"), unique: await p2.evaluate(() => new Set(JSON.parse(localStorage.getItem("foundry:msgs:release-notes")!).map((m: any) => `${m.turnId}:${m.actor}`)).size), sideUntouched: await p2.evaluate(() => JSON.parse(localStorage.getItem("foundry:msgs:release-notes-side") ?? "[]").every((m: any) => m.threadId === "release-notes-side")) };
    check("delayed older page issued for release-notes lands in that thread only, after a switch to the side thread and back, without duplicates", sideView.visible === 50 && backOnMain.visible === 100 && backOnMain.unique === 100 && backOnMain.sideUntouched, { sideView, backOnMain });
    // inactive-thread reconciliation by an owned journal event while the side thread is active
    await p2.goto(`${origin}/#thread=release-notes-side`); await p2.waitForFunction(() => document.querySelectorAll(".chat-msg").length >= 50);
    const observed = p2.waitForRequest((req: any) => req.url().includes("/api/threads/release-notes/history") && !req.url().includes("before="), { timeout: WAIT });
    const lateTurn = seedTurn(main, 900, "LATE_INACTIVE_MARKER");
    events.push({ kind: "journal", threadId: "release-notes", projectId: "release-notes-qa", turnId: lateTurn, timestamp: Date.now() });
    const reconcileRequest = await observed.then(() => true).catch(() => false);
    const stillSide = await count(p2, ".chat-msg");
    await p2.goto(`${origin}/#thread=release-notes`); await p2.getByText("LATE_INACTIVE_MARKER", { exact: false }).first().waitFor();
    const afterEvent = { reconcileRequest, stillSide, lateVisible: await p2.getByText("LATE_INACTIVE_MARKER", { exact: false }).count(), visible: await count(p2, ".chat-msg"), olderControl: await count(p2, ".chat-history-older") };
    await shot(p2, "1440-inactive-reconcile"); await fresh.close();
    check("owned journal event for the inactive thread triggers one bounded index fetch into its own cache; the row shows on return with paging intact", afterEvent.reconcileRequest && afterEvent.stillSide === 50 && afterEvent.lateVisible >= 1 && afterEvent.visible === 102 && afterEvent.olderControl === 1, afterEvent);
    await desk.close();
    // mobile 390
    const mob = await browser.newContext({ viewport: { width: 390, height: 844 } }); const m = await mob.newPage(); attach(m, "390");
    await m.goto(`${origin}/#thread=release-notes`);
    const chatTab = m.locator('.panel-navigation [aria-controls="workspace-conversation"]'); if (await chatTab.isVisible()) await chatTab.click();
    await m.locator(".chat-history-older").waitFor();
    await m.evaluate(() => { const el = document.querySelector(".chat-messages"); if (el) el.scrollTop = 0; }); await shot(m, "390-initial-top-with-older-control");
    const mClicks = await loadAllOlder(m);
    const mobile = { clicks: mClicks, visible: await count(m, ".chat-msg"), oldestMarker: await m.getByText("ARTIFACT_MARKER_OLDEST_release_md", { exact: false }).count(), overflow: await overflow(m), warnings: await count(m, ".chat-storage-warning") };
    await m.evaluate(() => { const el = document.querySelector(".chat-messages"); if (el) el.scrollTop = 0; }); await shot(m, "390-oldest-reached-top");
    const mOldest = m.locator(".chat-agent").filter({ hasText: "ARTIFACT_MARKER_OLDEST_release_md" }).first(); await mOldest.scrollIntoViewIfNeeded(); await mOldest.locator(".chat-trace-btn").click();
    await m.locator(".historical-detail-status[data-status='loaded']").waitFor(); await m.getByRole("button", { name: "Turn Context" }).click(); await m.getByText("CONTRIBUTIONS", { exact: false }).first().waitFor();
    const mobileDrawer = { overflow: await overflow(m), links: await m.locator(".detail-drawer a[href]").count() };
    await shot(m, "390-oldest-turn-context");
    check("390: older pages reach all 322 rows and the oldest marker without horizontal overflow; lazy detail and artifact links render", mobile.visible >= 322 && mobile.oldestMarker >= 1 && !mobile.overflow && !mobileDrawer.overflow && mobileDrawer.links >= 2, { mobile, mobileDrawer });
    await mob.close();
    report.controlled = { providerCalls, nativeObservations, nativeProcesses: 0, modelCalls: 0, note: "three controlled executor calls (unsaved, quota A, quota B sends); no adapter, spawn or bridge exists in this fixture" };
    check("zero native/model calls; exactly three controlled executor completions", nativeObservations === 0 && providerCalls === 3, report.controlled);
    // Console error attribution from recorded responses: analytics 400s (fixture configures no analytics)
    // and the offline stage's intentional aborts. Anything else is unattributed and fails the run.
    const analytics400 = report.failedResponses.filter((f: any) => f.status === 400 && /^\/api\/analytics/.test(f.url)).length;
    const intentionalAborts = report.failedResponses.filter((f: any) => f.status === "request-failed" && f.label === "offline").length;
    const otherFailed = report.failedResponses.filter((f: any) => !(f.status === 400 && /^\/api\/analytics/.test(f.url)) && !(f.status === "request-failed" && f.label === "offline"));
    const consoleResourceErrors = report.errors.filter((e: string) => /Failed to load resource/.test(e)).length;
    const otherConsole = report.errors.filter((e: string) => !/Failed to load resource/.test(e));
    report.errorAttribution = { consoleErrors: report.errors.length, consoleResourceErrors, analytics400, intentionalAborts, otherFailedResponses: otherFailed, otherConsoleErrors: otherConsole };
    check("every console error is attributed to a recorded analytics 400 or an intentional offline abort; none unattributed", otherFailed.length === 0 && otherConsole.length === 0 && consoleResourceErrors === analytics400 + intentionalAborts, report.errorAttribution);
  } finally {
    report.cleanupFailures = await releaseAll(cleanup);
    report.finishedAt = new Date().toISOString();
    report.summary = { assertions: report.assertions.length, ok: report.assertions.filter((a: any) => a.ok).length, failed: report.assertions.filter((a: any) => !a.ok).map((a: any) => a.name), errors: report.errors.length, screenshots: report.screenshots.length };
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
    console.log(`G6 long-history after-run report: ${join(out, "report.json")}`);
  }
  expect(report.cleanupFailures).toEqual([]);
  expect(report.summary.failed).toEqual([]);
}, 300_000);
