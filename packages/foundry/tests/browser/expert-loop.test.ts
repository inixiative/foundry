import { test, expect } from "bun:test";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { m0Scenario, gate, learned, abstain, instructions, domainKnowledge, interpretation, type Call } from "../helpers/m0-domain-loop";

// M1/M2 expert-loop inspection over the production factory/runtime/HTTP/SQLite (Astra's M0 helper,
// unedited, composed with a disposable server). Controlled reviewer/central answers only; no model or
// native process. Opt-in: FOUNDRY_QA_PLAYWRIGHT + Chrome. Every assertion is an after-acceptance
// assertion; the first run records the baseline gaps as failures.
const { chromium } = createRequire(import.meta.url)(process.env.FOUNDRY_QA_PLAYWRIGHT ?? "playwright");
const root = resolve(import.meta.dir, "../../../..");
const out = resolve(root, ".foundry/qa", `m1-expert-loop-${new Date().toISOString().replaceAll(":", "-")}`);
if (existsSync(out)) throw new Error(`Refusing to reuse an existing output directory: ${out}`);
mkdirSync(out, { recursive: true });
process.env.FOUNDRY_M0_OUTPUT_DIR = out;
const sha = (p: string) => createHash("sha256").update(readFileSync(join(root, p))).digest("hex");
const report: any = { scope: "production factory/runtime/HTTP/SQLite with controlled reviewer and central answers; no model or native process", startedAt: new Date().toISOString(), assertions: [], screenshots: [], errors: [], failedResponses: [], sourceHashes: {} };
const check = (name: string, ok: boolean, detail: unknown = {}) => report.assertions.push({ name, ok, detail });
const A = interpretation("a", "architecture"), T = interpretation("a", "testing");

test("expert loop: before work, after post-hooks (pending, commit, abstention), historical pre-hook segments, immutability, evidence navigation, 1440 and 390", async () => {
  for (const f of ["packages/foundry/src/viewer/ui/detail-drawer.js", "packages/foundry/src/viewer/ui/inspector-data.js", "packages/foundry/src/viewer/ui/store.js", "packages/foundry/src/viewer/ui/thread-tree.js", "packages/foundry/tests/helpers/m0-domain-loop.ts"]) report.sourceHashes[f] = sha(f);
  const held = gate<void>(); let released = false;
  const review = async (call: Call) => {
    if (call.phase === "post" && call.thread === "a" && call.domain === "testing" && !released) await held.promise;
    return call.messages.some(m => m.content.includes("MIGRATION_APPLIED")) ? learned(call.thread, call.domain!) : abstain;
  };
  let scenario: Awaited<ReturnType<typeof m0Scenario>> | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let browser: any = null;
  try {
    scenario = await m0Scenario({ learning: { timeoutMs: 10, hardTimeoutMs: 60_000 }, review });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => scenario!.current.app.fetch(request) });
    const origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const attach = (p: any, label: string) => { p.setDefaultTimeout(15_000); p.on("pageerror", (e: Error) => report.errors.push(`${label} pageerror: ${e.message}`));
      p.on("response", (r: any) => { if (r.status() >= 400) report.failedResponses.push({ label, status: r.status(), url: r.url().replace(origin, "").slice(0, 100) }); }); };
    const shot = async (p: any, name: string) => { await p.screenshot({ path: join(out, `${name}.png`) }); report.screenshots.push(name); };
    const overflow = (p: any) => p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    const drawer = (p: any) => p.locator(".detail-drawer").first();
    const text = async (loc: any) => (await loc.count()) ? await loc.first().innerText() : "";
    const count = (p: any, sel: string) => p.locator(sel).count();
    // Wait past the loading placeholder (same class) and for the layer's own cache section to arrive.
    const openLayer = async (p: any, id: string) => { await p.locator(".layer-item").filter({ hasText: id }).first().click();
      await drawer(p).locator(".expert-understanding:not([data-state='loading'])").waitFor(); await drawer(p).locator(".detail-section-title").filter({ hasText: /^Cached content/ }).first().waitFor();
      await drawer(p).locator(".expert-role").first().scrollIntoViewIfNeeded(); };
    const openTrace = async (p: any, turn: string) => {
      const row = p.locator(`.chat-msg[data-turn-id="${turn}"][data-actor="agent"]`); await row.scrollIntoViewIfNeeded(); await row.locator(".chat-trace-btn").click();
      await drawer(p).locator(".historical-detail-status[data-status='loaded']").waitFor();
      await p.getByRole("button", { name: "Turn Context" }).click(); await drawer(p).locator(".expert-participant").first().waitFor();
      // Screenshots must show the participants, not only the DOM: scroll the first participant into view.
      await drawer(p).locator(".expert-participant").first().scrollIntoViewIfNeeded(); };
    const shotParticipants = async (p: any, prefix: string) => { for (const d of ["architecture", "testing"]) { const node = drawer(p).locator(`.expert-participant[data-domain="${d}"]`).first(); if (!(await node.count())) continue; await node.scrollIntoViewIfNeeded(); await shot(p, `${prefix}-${d}-segments`);
      const seg = node.locator(`.participant-segment[data-segment="threadKnowledge"]`).first(); if (await seg.count()) { await seg.scrollIntoViewIfNeeded(); await shot(p, `${prefix}-${d}-understanding`); } } };
    const participant = async (p: any, domain: string) => {
      const node = drawer(p).locator(`.expert-participant[data-domain="${domain}"]`).first();
      return { present: (await node.count()) > 0, decision: await node.getAttribute("data-decision"), revision: await node.getAttribute("data-revision"),
        instructions: await text(node.locator(`.participant-segment[data-segment="instructions"]`)), domainKnowledge: await text(node.locator(`.participant-segment[data-segment="domainKnowledge"]`)),
        threadKnowledge: await text(node.locator(`.participant-segment[data-segment="threadKnowledge"]`)), guidance: await text(node.locator(".participant-guidance")), rationale: await text(node.locator(".participant-rationale")) };
    };

    const desk = await browser.newContext({ viewport: { width: 1440, height: 960 } }); const page = await desk.newPage(); attach(page, "1440");
    // ---- before work: each expert's configured instructions, domain knowledge, empty owned understanding ----
    await page.goto(`${origin}/#project=P&thread=a`); await page.locator(".layer-item").filter({ hasText: "architecture" }).first().waitFor();
    const before: Record<string, any> = {};
    for (const d of ["architecture", "testing"] as const) {
      await openLayer(page, d);
      const dt = await drawer(page).innerText();
      const und = drawer(page).locator(".expert-understanding").first();
      before[d] = { instructions: dt.includes(instructions(d)), domainKnowledge: dt.includes(domainKnowledge(d)), revision: await und.getAttribute("data-revision"), state: await und.getAttribute("data-state"),
        role: /advises before|reviews after/i.test(await text(drawer(page).locator(".expert-role"))), notExecutor: /Not\s*the central executor, router or classifier/i.test(await text(drawer(page).locator(".expert-role"))), leaked: dt.includes(A) || dt.includes(T) };
      await shot(page, `1440-before-${d}`);
    }
    check("before work: each layer shows its instructions, domain knowledge, role wording and an owned understanding that is explicitly empty (revision 0), with no interpretation text", ["architecture", "testing"].every(d => before[d].instructions && before[d].domainKnowledge && before[d].role && before[d].notExecutor && before[d].revision === "0" && before[d].state === "none" && !before[d].leaked), before);

    // ---- turn 1: migration; architecture commits, testing review held (pending, no serial wait) ----
    const t1 = await scenario.send("a", "t1", "Perform the migration");
    await scenario.committed("a", "architecture");
    await page.reload(); await page.locator(".chat-msg[data-turn-id='t1'][data-actor='agent']").waitFor();
    await drawer(page).locator(".knowledge-domain[data-domain='architecture'][data-status='learned']").waitFor();
    const arch = drawer(page).locator(".knowledge-domain[data-domain='architecture']").first();
    const testingPending = drawer(page).locator(".knowledge-domain[data-domain='testing']").first();
    const afterT1 = { t1Status: t1.status, archStatus: await arch.getAttribute("data-status"), archRevision: await text(arch.locator(".knowledge-revision-change")), archExplanationState: await arch.locator(".knowledge-explanation").first().getAttribute("data-state"),
      archExplanation: await text(arch.locator(".knowledge-explanation")), archEvidence: await text(arch.locator(".knowledge-evidence")), archUnderstanding: (await arch.innerText()).includes(A),
      testingStatus: await testingPending.getAttribute("data-status"), testingLastCommitted: await text(testingPending.locator(".knowledge-last-committed")), testingUnderstandingLeak: (await testingPending.innerText()).includes(T),
      live: await drawer(page).locator(".knowledge-live-state").first().getAttribute("data-state") };
    await shot(page, "1440-after-t1-architecture-learned-testing-pending");
    check("after turn 1: architecture shows post-hook state learned, revision 0→1, evidence turn t1, current understanding, and an explicitly labelled explanation (recorded or absent); testing is pending with its last committed state (none) still readable; live state reporting", t1.status === 200 && afterT1.archStatus === "learned" && /0\s*→\s*1/.test(afterT1.archRevision) && ["recorded", "absent"].includes(afterT1.archExplanationState ?? "") && afterT1.archExplanation.length > 0 && /t1/.test(afterT1.archEvidence) && afterT1.archUnderstanding && ["pending", "delayed"].includes(afterT1.testingStatus ?? "") && /none committed|revision 0|nothing committed/i.test(afterT1.testingLastCommitted) && !afterT1.testingUnderstandingLeak && afterT1.live === "reporting", afterT1);
    await openLayer(page, "architecture");
    const archLayer = drawer(page).locator(".expert-understanding").first();
    const layerAfter = { revision: await archLayer.getAttribute("data-revision"), state: await archLayer.getAttribute("data-state"), content: (await archLayer.innerText()).includes(A), otherLeak: (await archLayer.innerText()).includes(T), domainKnowledgeStill: (await drawer(page).innerText()).includes(domainKnowledge("architecture")) };
    await shot(page, "1440-layer-architecture-understanding-rev1");
    await openLayer(page, "testing");
    const testingLayer = drawer(page).locator(".expert-understanding").first();
    const testingLayerState = { revision: await testingLayer.getAttribute("data-revision"), state: await testingLayer.getAttribute("data-state"), pendingShown: /pending/i.test(await testingLayer.innerText()), leak: (await testingLayer.innerText()).includes(T) };
    check("layer view after turn 1: architecture's owned understanding is revision 1 with its interpretation and its domain knowledge unchanged; testing's is still revision 0, shows pending, and does not carry the other expert's text", layerAfter.revision === "1" && layerAfter.state === "committed" && layerAfter.content && !layerAfter.otherLeak && layerAfter.domainKnowledgeStill && testingLayerState.revision === "0" && testingLayerState.pendingShown && !testingLayerState.leak, { layerAfter, testingLayerState });

    // ---- turn 2 prepared while testing is pending; then release (commit); turn 3 abstentions ----
    const t2 = await scenario.send("a", "t2", "Continue");
    released = true; held.resolve();
    await scenario.committed("a", "testing");
    const t3 = await scenario.send("a", "t3", "Continue");
    await scenario.settled("a");
    await page.reload(); await page.locator(".chat-msg[data-turn-id='t3'][data-actor='agent']").waitFor();
    await drawer(page).locator(".knowledge-domain[data-domain='testing'][data-status]").waitFor();
    const entries = await drawer(page).locator(".learning-entry").evaluateAll((els: any[]) => els.map(e => ({ domain: e.getAttribute("data-domain"), decision: e.getAttribute("data-decision"), revision: e.getAttribute("data-revision"), text: e.innerText.slice(0, 200) })));
    const afterT3 = { statuses: [t2.status, t3.status], entries, testingStatus: await drawer(page).locator(".knowledge-domain[data-domain='testing']").first().getAttribute("data-status"),
      abstentions: entries.filter((e: any) => e.decision === "abstain"), abstainReasonShown: entries.some((e: any) => e.decision === "abstain" && /No additional owned interpretation/.test(e.text)), learnedBoth: ["architecture", "testing"].every(d => entries.some((e: any) => e.domain === d && e.decision === "learned" && e.revision === "1")) };
    await shot(page, "1440-after-t3-history");
    check("after commit and turn 3: learning history lists both learned revision-1 entries and later abstentions with the recorded abstention reason, per domain, without raw ids as the only identity", afterT3.statuses.every(s => s === 200) && afterT3.learnedBoth && afterT3.abstentions.length >= 2 && afterT3.abstainReasonShown, afterT3);

    // ---- historical pre-hook of turn 2: exact three segments, guidance, revision; testing empty (pending then) ----
    await openTrace(page, "t2");
    const p2a = await participant(page, "architecture"), p2t = await participant(page, "testing");
    const barrier = await text(drawer(page).locator(".learning-barrier"));
    await shot(page, "1440-turn2-participants"); await shotParticipants(page, "1440-turn2");
    check("turn 2 historical preparation: architecture worked from its instructions, domain knowledge and revision-1 understanding with attributed guidance; testing's thread understanding was empty at revision 0; learning barrier recorded pending", p2a.present && p2a.decision === "contribute" && p2a.revision === "1" && p2a.instructions.includes(instructions("architecture")) && p2a.domainKnowledge.includes(domainKnowledge("architecture")) && p2a.threadKnowledge.includes(A) && /architecture guidance/.test(p2a.guidance) && p2t.present && p2t.revision === "0" && !p2t.threadKnowledge.includes(T) && /pending/i.test(barrier), { p2a: { ...p2a, instructions: p2a.instructions.slice(0, 80), domainKnowledge: p2a.domainKnowledge.slice(0, 80), threadKnowledge: p2a.threadKnowledge.slice(0, 120) }, p2t: { ...p2t, threadKnowledge: p2t.threadKnowledge.slice(0, 120) }, barrier });
    // ---- original turn 1 has NOT acquired newer knowledge ----
    await openTrace(page, "t1");
    const p1a = await participant(page, "architecture"), p1t = await participant(page, "testing");
    const t1Drawer = await drawer(page).innerText();
    await shot(page, "1440-turn1-participants-immutable");
    check("turn 1 historical preparation is immutable: both experts at revision 0 with empty thread understanding; no interpretation text anywhere in the historical view", p1a.revision === "0" && p1t.revision === "0" && !p1a.threadKnowledge.includes(A) && !p1t.threadKnowledge.includes(T) && !t1Drawer.includes(A) && !t1Drawer.includes(T), { p1a: { ...p1a, threadKnowledge: p1a.threadKnowledge.slice(0, 80) }, p1t: { ...p1t, threadKnowledge: p1t.threadKnowledge.slice(0, 80) } });
    // ---- turn 3: both at revision 1 ----
    await openTrace(page, "t3");
    const p3a = await participant(page, "architecture"), p3t = await participant(page, "testing");
    check("turn 3 historical preparation: both experts worked from their own revision-1 understanding, never the other's", p3a.revision === "1" && p3t.revision === "1" && p3a.threadKnowledge.includes(A) && !p3a.threadKnowledge.includes(T) && p3t.threadKnowledge.includes(T) && !p3t.threadKnowledge.includes(A), { p3a: p3a.threadKnowledge.slice(0, 100), p3t: p3t.threadKnowledge.slice(0, 100) });
    // ---- evidence navigation from thread knowledge to the owning turn ----
    await page.locator(".back-btn").filter({ hasText: "Clear" }).click();
    // The committed revision's evidence (turn t1) and the latest post-hook (an abstention at t3) are distinct controls.
    const revisionEvidence = await text(drawer(page).locator(".knowledge-domain[data-domain='architecture'] .knowledge-revision-evidence"));
    const latestEvidence = await text(drawer(page).locator(".knowledge-domain[data-domain='architecture'] .knowledge-evidence"));
    await drawer(page).locator(".knowledge-domain[data-domain='architecture'] .knowledge-revision-evidence .knowledge-open-turn").first().click();
    await drawer(page).locator(".historical-detail-status[data-status='loaded']").waitFor();
    const navigated = await text(drawer(page).locator(".historical-detail"));
    check("evidence navigation: the architecture expert distinguishes the turn that produced its committed revision (t1) from its latest post-hook (t3), and the revision control opens t1 in the same panel", /t1/.test(revisionEvidence) && /t3/.test(latestEvidence) && /Selected turn\s*t1/.test(navigated), { revisionEvidence, latestEvidence, navigated: navigated.slice(0, 200) });
    await shot(page, "1440-evidence-navigation");
    // ---- recent history omits the original learn outcome: 52 more real Continue turns (104 abstentions) ----
    for (let n = 4; n <= 55; n++) { const r = await scenario.send("a", `t${n}`, "Continue"); if (r.status !== 200) throw new Error(`t${n} status ${r.status}`); }
    await scenario.settled("a");
    await desk.close();
    const fresh = await browser.newContext({ viewport: { width: 1440, height: 960 } }); const page2 = await fresh.newPage(); attach(page2, "1440-fresh");
    await page2.goto(`${origin}/#project=P&thread=a`); await page2.locator(".chat-msg[data-turn-id='t55'][data-actor='agent']").waitFor();
    await drawer(page2).locator(".knowledge-domain[data-domain='architecture']").waitFor();
    const archLater = drawer(page2).locator(".knowledge-domain[data-domain='architecture']").first();
    const omitted = { historyEntries: await drawer(page2).locator(".learning-entry").count(), learnedEntriesVisible: await drawer(page2).locator(".learning-entry[data-decision='learned']").count(),
      revisionEvidence: await text(archLater.locator(".knowledge-revision-evidence")), revisionEvidenceSource: await archLater.locator(".knowledge-revision-evidence").first().getAttribute("data-source"),
      revisionExplanationState: await archLater.locator(".knowledge-revision-explanation").first().getAttribute("data-state"), revisionChange: await text(archLater.locator(".knowledge-revision-change")),
      understanding: (await archLater.innerText()).includes(A), t1RowLoaded: await count(page2, ".chat-msg[data-turn-id='t1']") };
    await shot(page2, "1440-omitted-history-provenance");
    await archLater.locator(".knowledge-revision-evidence .knowledge-open-turn").first().click();
    await drawer(page2).locator(".historical-detail-status[data-status='loaded']").waitFor();
    const resolved = await text(drawer(page2).locator(".historical-detail"));
    await page2.getByRole("button", { name: "Turn Context" }).click(); await drawer(page2).locator(".expert-participant").first().waitFor();
    const resolvedParticipant = await participant(page2, "architecture");
    await shot(page2, "1440-omitted-history-evidence-resolved");
    await fresh.close();
    check("with the original learn outcome outside the recent history window, current revision provenance still comes from the snapshot (turn t1), the before-revision and rationale are marked unavailable rather than invented, the understanding stays visible, and the control resolves t1 through the owned detail route although t1 is not in the loaded page", omitted.learnedEntriesVisible === 0 && omitted.historyEntries >= 100 && /turn t1/.test(omitted.revisionEvidence) && omitted.revisionEvidenceSource === "snapshot" && omitted.revisionExplanationState === "unavailable" && /before-revision not in the recent history window/.test(omitted.revisionChange) && omitted.understanding && omitted.t1RowLoaded === 0 && /Selected turn\s*t1/.test(resolved) && resolvedParticipant.revision === "0", { omitted, resolved: resolved.slice(0, 160), resolvedParticipantRevision: resolvedParticipant.revision });

    // ---- 390 ----
    const mob = await browser.newContext({ viewport: { width: 390, height: 844 } }); const m = await mob.newPage(); attach(m, "390");
    await m.goto(`${origin}/#project=P&thread=a`);
    const tab = async (name: RegExp) => { const t = m.locator(".panel-navigation button, .panel-navigation [role=tab]").filter({ hasText: name }).first(); if (await t.count()) await t.click(); };
    await tab(/threads/i); await m.locator(".layer-item").filter({ hasText: "architecture" }).first().click(); await tab(/inspect/i);
    await drawer(m).locator(".expert-understanding").waitFor();
    const mLayer = { revision: await drawer(m).locator(".expert-understanding").first().getAttribute("data-revision"), overflow: await overflow(m) };
    await shot(m, "390-layer-architecture");
    await tab(/chat/i); await m.locator(".chat-msg[data-turn-id='t55'][data-actor='agent']").waitFor();
    const row = m.locator(".chat-msg[data-turn-id='t55'][data-actor='agent']"); await row.scrollIntoViewIfNeeded(); await row.locator(".chat-trace-btn").click();
    await tab(/inspect/i); await drawer(m).locator(".historical-detail-status[data-status='loaded']").waitFor();
    await m.getByRole("button", { name: "Turn Context" }).click(); await drawer(m).locator(".expert-participant").first().waitFor();
    const mp = await participant(m, "architecture");
    await shot(m, "390-turn55-participants"); await shotParticipants(m, "390-turn55");
    check("390: layer understanding and historical participants render without horizontal overflow", mLayer.revision === "1" && !mLayer.overflow && mp.present && mp.revision === "1" && !(await overflow(m)), { mLayer, mp: { present: mp.present, revision: mp.revision } });
    await mob.close();
    report.errorAttribution = { pageErrors: report.errors, failedResponses: report.failedResponses.filter((f: any) => !/^\/api\/analytics/.test(f.url)) };
    check("no page exceptions; every failed response other than the fixture's analytics 400s is listed", report.errors.length === 0, report.errorAttribution);
  } finally {
    const cleanup: string[] = [];
    try { await browser?.close(); } catch (e) { cleanup.push(`browser: ${(e as Error).message}`); }
    try { server?.stop(true); } catch (e) { cleanup.push(`server: ${(e as Error).message}`); }
    try { released = true; held.resolve(); await scenario?.close(); } catch (e) { cleanup.push(`scenario: ${(e as Error).message}`); }
    report.cleanupFailures = cleanup; report.scenarioDir = scenario?.dir ?? null;
    report.finishedAt = new Date().toISOString();
    report.summary = { assertions: report.assertions.length, ok: report.assertions.filter((a: any) => a.ok).length, failed: report.assertions.filter((a: any) => !a.ok).map((a: any) => a.name), screenshots: report.screenshots.length };
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
    console.log(`M1 expert-loop report: ${join(out, "report.json")}`);
  }
  expect(report.cleanupFailures).toEqual([]);
  expect(report.summary.failed).toEqual([]);
}, 180_000);
