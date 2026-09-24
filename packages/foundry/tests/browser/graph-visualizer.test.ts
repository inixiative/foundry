import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { m0Scenario } from "../helpers/m0-domain-loop";
import { releaseAll } from "../helpers/release-all";

// Graph panel over the production factory/runtime/HTTP/SQLite (the M0 domain loop: two experts,
// controlled reviewer and central answers; no model or native process). Opt-in: FOUNDRY_QA_PLAYWRIGHT
// + Chrome. Proves the thread graph (subagent nesting), the live turn flow (a turn sent while the
// view is open appears without a reload), the learning loop's feedback edges, click-to-inspect in the
// detail drawer, pan/zoom, and that `flow:<thread>` is held only while a flow view is shown.
const { chromium } = createRequire(import.meta.url)(process.env.FOUNDRY_QA_PLAYWRIGHT ?? "playwright");
const root = resolve(import.meta.dir, "../../../..");

test("graph panel: thread graph, live turn flow, learning loop, inspect, pan/zoom, stream held only while shown", async () => {
  const out = resolve(root, ".foundry/qa", `graph-visualizer-${new Date().toISOString().replaceAll(":", "-")}`);
  mkdirSync(out, { recursive: true });
  process.env.FOUNDRY_M0_OUTPUT_DIR = out;
  const errors: string[] = [], screenshots: string[] = [];
  const report: any = { passed: false, errors, screenshots, out };
  let scenario: Awaited<ReturnType<typeof m0Scenario>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: any;
  try {
    scenario = await m0Scenario();
    const s = scenario;
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request, srv) => s.current.fetch(request, srv), websocket: s.current.websocket });
    const origin = `http://127.0.0.1:${server.port}`;
    // Subagent threads under `a`, one nested a level deeper.
    for (const [id, parentThreadId, description] of [["a-review", "a", "Review subagent"], ["a-tests", "a", "Test subagent"], ["a-tests-fix", "a-tests", "Fix flaky test"]]) {
      const res = await s.current.app.request("/api/threads", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, parentThreadId, projectId: "P", description }) });
      expect(res.status).toBe(201);
    }
    await s.send("a", "t1", "Perform the migration");
    await s.committed("a", "architecture");
    await s.settled("a");
    await s.send("a", "t2", "Continue");
    await s.settled("a");

    browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (e: Error) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m: any) => { if (m.type() === "error" && /graph-view|flow-graph|store|SyntaxError|ReferenceError|TypeError/.test(m.text())) errors.push(`console: ${m.text()}`); });
    const shot = async (name: string) => { const path = join(out, `${name}.png`); await page.screenshot({ path }); screenshots.push(path); };
    const flowOpen = () => s.current.socket.streams.isOpen("flow:a");
    const until = async (predicate: () => boolean, label: string) => {
      const end = Date.now() + 8000;
      while (!predicate()) { if (Date.now() > end) throw new Error(`timed out: ${label}`); await Bun.sleep(20); }
    };

    // ---- Threads: subagent nesting from meta.parentThreadId ----
    await page.goto(`${origin}/#project=P&thread=a&panel=graph`);
    await page.locator(".graph-panel .graph-node[data-node-id='a-tests-fix']").waitFor();
    const edges = await page.locator(".graph-edge").evaluateAll((els: Element[]) => els.map(e => e.getAttribute("data-edge-id")).sort());
    expect(edges).toEqual(["a->a-review", "a->a-tests", "a-tests->a-tests-fix"]);
    expect(await page.locator(".graph-node--selected").getAttribute("data-node-id")).toBe("a");
    expect(flowOpen()).toBe(false); // the thread view reads the list the store already holds
    await page.locator(".graph-node[data-node-id='a-tests']").hover();
    await page.locator(".graph-tooltip").waitFor();
    expect(await page.locator(".graph-tooltip").innerText()).toContain("Test subagent");
    await shot("1440-threads");

    // ---- Turn flow: the recorded loop of the newest turn; live append of a new turn ----
    await page.getByRole("tab", { name: "Turn flow" }).click();
    await page.locator(".graph-node[data-node-id='executor']").waitFor();
    await until(flowOpen, "flow:a open while the turn flow is shown");
    await page.locator(".graph-turn[data-turn-id='t1']").click();
    const nodes = await page.locator(".graph-node").evaluateAll((els: Element[]) => els.map(e => e.getAttribute("data-node-id")));
    expect(nodes).toEqual(expect.arrayContaining(["input", "routing", "domain:architecture", "domain:testing", "plan", "executor", "guard:0", "delivery", "learn:architecture", "learn:testing"]));
    expect(await page.locator(".graph-node[data-node-id='learn:architecture'] .graph-node-sub").textContent()).toBe("learned · rev 0→1");
    await page.locator(".graph-node[data-node-id='plan']").hover();
    expect(await page.locator(".graph-tooltip").innerText()).toMatch(/elapsed/);
    await shot("1440-turn-flow-t1");

    // Keyboard: focusing a step outside the view pans it in; Enter inspects it (its turn opens in the detail drawer).
    await page.mouse.move(0, 0);
    await page.locator(".graph-node[data-node-id='executor']").focus();
    expect(await page.locator(".graph-tooltip").innerText()).toMatch(/Executor/);
    await shot("1440-turn-flow-focus-executor");
    await page.keyboard.press("Enter");
    await page.locator(".detail-drawer .historical-detail-status[data-status='loaded']").waitFor();
    expect(await page.locator(".detail-drawer").innerText()).toMatch(/t1/);
    await shot("1440-turn-flow-inspect");

    // Pan and zoom change the view transform; fit restores a view that shows the graph.
    const transform = () => page.locator(".graph-canvas svg > g").getAttribute("transform");
    const before = await transform();
    const box = await page.locator(".graph-canvas").boundingBox();
    await page.mouse.move(box.x + 40, box.y + box.height - 40);
    await page.mouse.wheel(0, -400);
    await page.waitForFunction((prev: string) => document.querySelector(".graph-canvas svg > g")?.getAttribute("transform") !== prev, before);
    const zoomed = await transform();
    await page.mouse.down(); await page.mouse.move(box.x + 140, box.y + box.height - 10, { steps: 4 }); await page.mouse.up();
    await page.waitForFunction((prev: string) => document.querySelector(".graph-canvas svg > g")?.getAttribute("transform") !== prev, zoomed);
    await page.getByRole("button", { name: "Fit to view" }).click();
    expect(await transform()).not.toBe(zoomed);

    // A turn sent while the view is open arrives on the stream, no reload.
    await s.send("a", "t3", "Continue");
    await page.locator(".graph-turn[data-turn-id='t3']").waitFor();
    await page.locator(".graph-turn[data-turn-id='t3']").click();
    await page.locator(".graph-node[data-node-id='learn:architecture']").waitFor();
    await shot("1440-turn-flow-live-t3");

    // ---- Learning loop: assessed revision → writeback → the later turn that worked from it ----
    await page.getByRole("tab", { name: "Learning loop" }).click();
    await page.locator(".graph-node[data-node-id='now:architecture']").waitFor();
    const feedback = await page.locator(".graph-edge--feedback").evaluateAll((els: Element[]) => els.map(e => e.getAttribute("data-edge-id")));
    expect(feedback).toEqual(expect.arrayContaining(["write:t1:architecture->feedback:t2", "write:t1:testing->feedback:t2"]));
    await shot("1440-learning-loop");
    await page.locator(".graph-node[data-node-id='write:t1:architecture']").click();
    await page.locator(".detail-drawer .expert-understanding:not([data-state='loading'])").waitFor();
    await shot("1440-learning-loop-inspect-layer");

    // ---- Stream lifecycle: closed with the view, re-opened (fresh snapshot) when it returns ----
    await page.locator(".center-view", { hasText: "Chat" }).click();
    await until(() => !flowOpen(), "flow:a closed when the graph panel is hidden");
    await page.keyboard.press("g");
    await until(flowOpen, "flow:a re-opened by the g hotkey");
    await page.locator(".graph-node[data-node-id='now:architecture']").waitFor();

    // ---- Compact width: the graph fills the center panel with no horizontal page overflow ----
    await page.setViewportSize({ width: 390, height: 844 });
    // Inspecting put the drawer in front; the compact navigation brings the center panel (still in graph mode) back.
    await page.locator(".panel-navigation [aria-controls='workspace-conversation']").click();
    await page.getByRole("tab", { name: "Turn flow" }).click();
    await page.locator(".graph-node[data-node-id='executor']").waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    await shot("390-turn-flow");

    expect(errors).toEqual([]);
    report.passed = true;
  } catch (err) {
    report.failure = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    report.cleanupFailures = await releaseAll([
      ["browser", browser ? () => browser.close() : undefined],
      ["server", server ? () => server!.stop(true) : undefined],
      ["scenario", scenario ? () => scenario!.close() : undefined],
    ]);
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  }
}, 120_000);
