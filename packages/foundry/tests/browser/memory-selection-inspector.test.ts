import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { completionFixture } from "../helpers/completion-persistence-fixture";
import { releaseAll } from "../helpers/release-all";

// Opt-in (FOUNDRY_QA_PLAYWRIGHT): the real viewer page must load the edited
// drawer and inspector modules without errors, and the selection helper must
// run in the browser on a layer snapshot shaped like the executor's artifact.
// This proves the UI compiles and the helper's wording; it does not by itself
// prove the Selection section's visual placement in the right panel.
const { chromium } = createRequire(import.meta.url)(process.env.FOUNDRY_QA_PLAYWRIGHT ?? "playwright");

const layer = {
  id: "memory", included: true, content: "## Pinned (1)\n[convention] conv: keep it",
  selection: { focusHash: "abc", sources: [{ sourceId: "memory-src", report: {
    selected: [
      { id: "conv", reason: "pinned", chars: 40, kind: "convention" },
      { id: "old", reason: "relevant", chars: 120, kind: "observation", matched: ["rollback"], truncated: true, ranges: [[2191, 2491]] },
    ],
    omitted: Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, reason: "audit-only", chars: 700, kind: "dispatch" })),
    considered: 14, retained: { count: 14, chars: 8560 }, budget: { chars: 6000, used: 160, exceeded: false },
    conflicts: [], focus: { hash: "abc", terms: 3 },
  } }] },
};

type Fixture = Awaited<ReturnType<typeof completionFixture>>;

async function run(reportName: string, channel: string, body: (page: any, server: ReturnType<typeof Bun.serve>) => Promise<void>) {
  const reportDir = resolve(".foundry/qa", `${reportName}-${new Date().toISOString().replaceAll(":", "-")}`);
  mkdirSync(reportDir, { recursive: true });
  const errors: string[] = [];
  const noise: string[] = [];
  const report: any = { passed: false, errors, ignoredFixtureNoise: noise, serverOwner: "this test; ephemeral port, stopped in finally" };
  let fixture: Fixture | undefined;
  let runtime: ReturnType<Fixture["make"]> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: any;
  try {
    fixture = await completionFixture();
    runtime = fixture.make();
    const app = runtime;
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => app.app.fetch(req) });
    browser = await chromium.launch({ channel, headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    page.on("pageerror", (e: Error) => errors.push(`pageerror: ${e.message}`));
    // Only errors that implicate the UI modules count. The fixture app has no websocket endpoint
    // and answers some background polls with 400; the storage browser test ignores that noise too.
    page.on("console", (m: any) => {
      if (m.type() !== "error") return;
      const text = m.text();
      (/detail-drawer|inspector-data|SyntaxError|ReferenceError|TypeError/.test(text) ? errors : noise).push(`console: ${text}`);
    });
    await body(page, server);
    await page.screenshot({ path: `${reportDir}/page.png` });
    expect(errors).toEqual([]);
    report.passed = true;
  } catch (err) {
    report.failure = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    // Every owned resource is released even when setup stopped part way; failures are reported, not hidden.
    report.cleanupFailures = await releaseAll([
      ["browser", browser ? () => browser.close() : undefined],
      ["server", server ? () => server!.stop(true) : undefined],
      ["fixture (runtime, store, temp dir)", fixture ? () => fixture!.close() : undefined],
    ]);
    report.released = { browser: Boolean(browser), server: Boolean(server), fixture: Boolean(fixture) };
    writeFileSync(`${reportDir}/report.json`, JSON.stringify(report, null, 2));
    if (report.cleanupFailures.length) throw new Error(`cleanup failures: ${report.cleanupFailures.join("; ")}`);
  }
  return report;
}

test("viewer page loads the edited drawer and runs selectionSummary in the browser without errors", async () => {
  const report = await run("memory-selection-browser", "chrome", async (page, server) => {
    await page.goto(`http://127.0.0.1:${server.port}/#thread=main`);
    await page.waitForFunction(async () => (await import("/ui/store.js")).inflight.value === 0);
    const result = await page.evaluate(async (snapshot: any) => {
      await import("/ui/detail-drawer.js");
      const { selectionSummary } = await import("/ui/inspector-data.js");
      return { summary: selectionSummary(snapshot), nullFor: selectionSummary({ id: "system", included: true, content: "x" }) };
    }, layer);
    expect(result.nullFor).toBeNull();
    expect(result.summary.selected.map((s: any) => s.id)).toEqual(["conv", "old"]);
    expect(result.summary.selected[1].detail).toContain("excerpt chars 2191-2491");
    expect(result.summary.omitted).toEqual([{ reason: "audit-only", count: 12, chars: 8400, kinds: "dispatch 12" }]);
    expect(result.summary.notice).toContain("prepared");
    expect(result.summary.notice).not.toContain("delivered");
  });
  expect(report.cleanupFailures).toEqual([]);
}, 60_000);

test("a browser launch failure still releases the fixture and server it had already created", async () => {
  let thrown: unknown;
  try { await run("memory-selection-browser-launch-failure", "no-such-browser-channel", async () => {}); }
  catch (err) { thrown = err; }
  expect(String(thrown)).not.toContain("cleanup failures");
  expect(thrown).toBeDefined();
  const dirs = (await import("node:fs")).readdirSync(resolve(".foundry/qa")).filter((d) => d.startsWith("memory-selection-browser-launch-failure-")).sort();
  const report = JSON.parse((await import("node:fs")).readFileSync(resolve(".foundry/qa", dirs.at(-1)!, "report.json"), "utf8"));
  expect(report.passed).toBe(false);
  expect(report.released).toEqual({ browser: false, server: true, fixture: true });
  expect(report.cleanupFailures).toEqual([]);
}, 60_000);
