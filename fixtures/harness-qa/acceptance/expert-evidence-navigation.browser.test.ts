import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { m0Scenario, gate, bounded } from "../../../packages/foundry/tests/helpers/m0-domain-loop";

test.skipIf(!process.env.FOUNDRY_QA_PLAYWRIGHT)("late expert evidence must not reopen another thread's historical panel", async () => {
  const root = resolve(import.meta.dir, "../../..");
  const parent = join(root, ".foundry/qa");
  await mkdir(parent, { recursive: true });
  const output = await mkdtemp(join(parent, "parent-expert-navigation-"));
  const oldOutput = process.env.FOUNDRY_M0_OUTPUT_DIR;
  process.env.FOUNDRY_M0_OUTPUT_DIR = output;
  const released = gate<void>();
  const requested = gate<void>();
  let scenario: Awaited<ReturnType<typeof m0Scenario>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: any;
  const report: Record<string, any> = { scope: "Real factory/journal/viewer/store in isolated Chromium; only HTTP delivery order controlled; no native calls", errors: [], cleanup: [], sourceHashes: {} };
  try {
    for (const file of ["packages/foundry/src/viewer/ui/store.js", "packages/foundry/src/viewer/ui/detail-drawer.js", "packages/foundry/tests/helpers/m0-domain-loop.ts"]) {
      report.sourceHashes[file] = new Bun.CryptoHasher("sha256").update(await Bun.file(join(root, file)).bytes()).digest("hex");
    }
    scenario = await m0Scenario();
    expect((await scenario.send("a", "owned-a-evidence", "Perform the migration")).status).toBe(200);
    await scenario.settled("a");
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (new URL(request.url).pathname === "/api/threads/a/turns/owned-a-evidence/detail") {
        requested.resolve();
        await released.promise;
      }
      return scenario!.current.app.fetch(request);
    } });
    const { chromium } = createRequire(import.meta.url)(process.env.FOUNDRY_QA_PLAYWRIGHT!);
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.on("pageerror", (error: Error) => report.errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/#project=P&thread=a`);
    await page.waitForFunction(async () => {
      const store = await import(`${location.origin}/ui/store.js`);
      return store.activeThreadId.value === "a" && store.allThreads.value.some((thread: any) => thread.threadId === "b");
    });
    await page.evaluate(async () => {
      const store = await import(`${location.origin}/ui/store.js`);
      (window as any).__evidenceOpen = store.openTurnDetail("a", "owned-a-evidence");
    });
    await bounded(requested.promise, "held owned evidence request", 5000);
    await page.evaluate(async () => {
      const store = await import(`${location.origin}/ui/store.js`);
      store.selectThread("b");
    });
    released.resolve();
    await page.evaluate(async () => {
      await (window as any).__evidenceOpen;
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    });
    report.observed = await page.evaluate(async () => {
      const store = await import(`${location.origin}/ui/store.js`);
      return { active: store.activeThreadId.value, selectedTurn: store.currentTrace.value?.selectedTurn ?? null,
        drawerText: document.querySelector(".detail-drawer")?.textContent ?? "" };
    });
    await page.screenshot({ path: join(output, "1440-after-thread-switch.png") });
    report.passed = report.observed.active === "b" && report.observed.selectedTurn === null && report.errors.length === 0;
    expect(report.observed.active).toBe("b");
    expect(report.observed.selectedTurn).toBeNull();
    expect(report.errors).toEqual([]);
  } finally {
    released.resolve();
    try { await browser?.close(); } catch (error) { report.cleanup.push(String(error)); }
    try { server?.stop(true); } catch (error) { report.cleanup.push(String(error)); }
    try { await scenario?.close(); } catch (error) { report.cleanup.push(String(error)); }
    if (oldOutput === undefined) delete process.env.FOUNDRY_M0_OUTPUT_DIR;
    else process.env.FOUNDRY_M0_OUTPUT_DIR = oldOutput;
    report.scenario = scenario?.dir;
    await Bun.write(join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(`Independent evidence-navigation report: ${join(output, "report.json")}`);
  }
  expect(report.cleanup).toEqual([]);
}, 30_000);
