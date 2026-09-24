import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { completionFixture } from "../helpers/completion-persistence-fixture";

const { chromium } = createRequire(import.meta.url)(process.env.FOUNDRY_QA_PLAYWRIGHT ?? "playwright");

for (const errorName of ["QuotaExceededError", "SecurityError"]) {
  for (const committed of [false, true]) {
    test(`real composer keeps ${committed ? "committed" : "unsaved"} completion honest after ${errorName}`, async () => {
      const reportDir = resolve(".foundry/qa", `storage-browser-${errorName}-${committed}-${new Date().toISOString().replaceAll(":", "-")}`);
      mkdirSync(reportDir, { recursive: true });
      const fixture = await completionFixture();
      const runtime = fixture.make();
      const sql = (runtime.localStore as unknown as { db: Database }).db;
      if (committed) sql.exec("DROP TRIGGER reject_completed_message");
      runtime.directory.restore([{ id: "other", meta: { description: "Other thread" } }]);
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => runtime.app.fetch(req) });
      const browser = await chromium.launch({ channel: "chrome", headless: true });
      const context = await browser.newContext({ viewport: { width: 1100, height: 950 } });
      const page = await context.newPage();
      page.setDefaultTimeout(8_000);
      const errors: string[] = [];
      const report: any = { errorName, committed, passed: false, errors };
      page.on("pageerror", (error: Error) => errors.push(error.message));
      try {
        await page.goto(`http://127.0.0.1:${server.port}/#thread=main`);
        await page.locator(".chat-input").waitFor();
        await page.waitForFunction(() => localStorage.getItem("foundry:msgs:main") !== null);
        // Include a real prior browser record, not just an empty key.
        await page.evaluate(() => localStorage.setItem("foundry:msgs:main", JSON.stringify([
          { actor: "user", turnId: "legacy", content: "Previously saved browser history", timestamp: 1 },
        ])));
        await page.reload();
        await page.getByText("Previously saved browser history", { exact: true }).waitFor();
        const prior = await page.evaluate((name: string) => {
          // Reject only Foundry message writes, leaving unrelated browser state alone.
          const set = Storage.prototype.setItem;
          (window as any).rejectMessageWrites = true;
          Storage.prototype.setItem = function (key, value) {
            if (this === localStorage && key.startsWith("foundry:msgs:") && (window as any).rejectMessageWrites) {
              throw new DOMException("Controlled browser write rejection", name);
            }
            return set.call(this, key, value);
          };
          return localStorage.getItem("foundry:msgs:main");
        }, errorName);
        const submit = async (text: string) => {
          await page.locator(".chat-input").fill(text);
          await page.locator(".chat-input").press("Enter");
        };
        await submit("Complete this work once");
        const output = page.locator(".chat-agent > .chat-msg-content").filter({ hasText: fixture.output }).first();
        await output.waitFor();
        const warning = page.locator(".chat-agent .chat-storage-warning").first();
        await warning.waitFor();
        await page.waitForFunction(async () => (await import("/ui/store.js")).inflight.value === 0);
        const expected = committed ? "saved on the server" : "only in this tab";
        expect(await warning.innerText()).toContain(expected);
        if (!committed) expect(await warning.innerText()).toContain("reload or close");
        else expect(await warning.innerText()).not.toContain("only in this tab");
        const state = await page.evaluate(async () => (await import("/ui/store.js")).messages.value.find((m: any) => m.actor === "agent"));
        expect(state.output ?? state.content).toBe(fixture.output);
        expect(state.meta.persistence).toBe(committed ? "committed" : "failed");
        expect(state.browserStorage).toEqual({ status: "volatile", error: errorName });
        expect(await page.evaluate(() => localStorage.getItem("foundry:msgs:main"))).toBe(prior);
        expect(fixture.calls()).toBe(1);
        expect(fixture.inputs()).toEqual(["Complete this work once"]);
        expect(runtime.failureWrites()).toBe(0);
        expect(await page.getByText("Partial output (unconfirmed)", { exact: true }).count()).toBe(0);
        expect(await page.getByText("Welcome to Foundry", { exact: true }).count()).toBe(0);
        // Rerender and real thread navigation must not dismiss or lose the warning.
        await page.setViewportSize({ width: 1200, height: 950 });
        await page.getByText("Other thread", { exact: true }).first().click();
        await page.waitForFunction(async () => (await import("/ui/store.js")).activeThreadId.value === "other");
        expect(await page.locator(".chat-storage-warning").count()).toBe(0);
        await page.locator('.tree-label[title="main"]').click();
        await output.waitFor();
        // Outlive the existing transient-toast interval without sending another request.
        await page.waitForTimeout(7_000);
        expect(await warning.isVisible()).toBe(true);
        expect(await warning.innerText()).toContain(expected);
        expect(fixture.calls()).toBe(1);
        await page.screenshot({ path: `${reportDir}/volatile.png` });
        // A later ordinary write can save the older result; never resend that turn.
        await page.evaluate(() => { (window as any).rejectMessageWrites = false; });
        // The original journal row stays unresolved. This distinct request has
        // its own turn ID and input; ordinary cache writes also save the old result.
        await submit("A separate request; never replay the previous turn");
        await page.waitForFunction(async () => (await import("/ui/store.js")).inflight.value === 0);
        expect(await page.locator(".chat-storage-warning").count()).toBe(0);
        const restored = await page.evaluate(() => JSON.parse(localStorage.getItem("foundry:msgs:main") || "[]").find((m: any) => m.actor === "agent"));
        expect(restored.output ?? restored.content).toBe(fixture.output);
        expect(restored.browserStorage.status).toBe("saved");
        expect(restored.meta.persistence).toBe(committed ? "committed" : "failed");
        expect(fixture.calls()).toBe(2);
        expect(fixture.inputs()).toEqual(["Complete this work once", "A separate request; never replay the previous turn"]);
        expect(runtime.localStore!.turn(state.turnId)?.status).toBe(committed ? "completed" : "active");
        await page.screenshot({ path: `${reportDir}/browser-saved.png` });
        await page.reload();
        await output.waitFor();
        expect(await page.locator(".chat-storage-warning").count()).toBe(0);
        expect(fixture.calls()).toBe(2);
        expect(errors).toEqual([]);
        Object.assign(report, { passed: true, calls: fixture.calls(), originalTurnId: state.turnId });
      } catch (error) {
        report.error = String(error);
        await page.screenshot({ path: `${reportDir}/failure.png` });
        throw error;
      } finally {
        await browser.close(); server.stop(true); fixture.close();
        writeFileSync(`${reportDir}/report.json`, JSON.stringify(report, null, 2));
        console.log(`Browser storage evidence: ${reportDir}/report.json`);
      }
    }, 45_000);
  }
}
