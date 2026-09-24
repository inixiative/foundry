import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { completionFixture } from "../helpers/completion-persistence-fixture";

// Explicit browser check; uses the installed QA runtime, no project dependency changes.
const { chromium } = createRequire(import.meta.url)(process.env.FOUNDRY_QA_PLAYWRIGHT ?? "playwright");

test("actual conversation keeps a completed-but-unsaved result it sent through reload", async () => {
  const reportDir = resolve(".foundry/qa", `completion-browser-${new Date().toISOString().replaceAll(":", "-")}`);
  mkdirSync(reportDir, { recursive: true });
  const results: unknown[] = [];
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    // This tab sends and reads its full terminal from its thread stream.
    for (const transport of ["send"]) {
      const fixture = await completionFixture();
      const runtime = fixture.make();
      // Owned test listener only; no existing Foundry instance is changed.
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: runtime.fetch, websocket: runtime.websocket });
      const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error: Error) => errors.push(error.message));
      try {
        await page.goto(`http://127.0.0.1:${server.port}/#thread=main`);
        await page.locator(".chat-input").waitFor();
        await page.locator(".chat-input").fill(`Complete once via ${transport}`);
        await page.locator(".chat-input").press("Enter");
        const output = page.locator(".chat-agent > .chat-msg-content").filter({ hasText: fixture.output });
        await output.waitFor();
        await page.getByText(/Execution completed; result was not saved to local journal/).waitFor();
        expect(await page.getByText("Welcome to Foundry", { exact: true }).count()).toBe(0);
        expect(await page.getByText("Partial output (unconfirmed)", { exact: true }).count()).toBe(0);
        const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("foundry:msgs:main") || "[]"));
        const message = stored.find((m: any) => m.actor === "agent");
        expect(message.output).toBe(fixture.output);
        expect(message.traceSnapshot.root.status).toBe("ok");
        expect(message.traceSnapshot.messageId).toBe(message.turnId);
        expect(message.meta.executionOutcome).toBe("completed");
        expect(message.meta.persistence).toBe("failed");
        expect(runtime.failureWrites()).toBe(0);
        expect(fixture.calls()).toBe(1);
        expect(runtime.localStore!.turn(message.turnId)?.status).toBe("active");
        await page.screenshot({ path: `${reportDir}/${transport}-live.png` });
        await page.reload();
        await output.waitFor();
        await page.getByText(/Execution completed; result was not saved to local journal/).waitFor();
        expect(await page.getByText("Partial output (unconfirmed)", { exact: true }).count()).toBe(0);
        // Supply a later unresolved journal row to exercise actual browser reconciliation.
        // This is a history response fixture (index and full routes), not a server restart or native assertion.
        const journal = [
          { actor: "user", turnId: message.turnId, content: `Complete once via ${transport}`, timestamp: message.timestamp - 1 },
          { actor: "agent", turnId: message.turnId, content: "Journal outcome unresolved", timestamp: message.timestamp,
            kind: "error", meta: { turnStatus: "interrupted", persistence: "committed", inputEvidence: "unavailable", nativeOutcome: "unknown" } },
        ];
        await page.route("**/api/messages?threadId=main", (route: any) => route.fulfill({ json: { messages: journal } }));
        await page.route("**/api/threads/main/history*", (route: any) => route.fulfill({ json: { threadId: "main", source: "journal",
          messages: journal, hasMore: false, oldestReached: true, nextCursor: null } }));
        await page.reload();
        await output.waitFor();
        await page.getByText(/Server journal: interrupted/).waitFor();
        expect(await page.getByText("Welcome to Foundry", { exact: true }).count()).toBe(0);
        const reconciled = await page.evaluate(() => JSON.parse(localStorage.getItem("foundry:msgs:main") || "[]").find((m: any) => m.actor === "agent"));
        expect(reconciled.traceSnapshot).toEqual(message.traceSnapshot);
        expect(reconciled.output).toBe(fixture.output);
        expect(reconciled.journalRecord.meta.turnStatus).toBe("interrupted");
        expect(reconciled.traceId).toBeUndefined();
        expect(await page.getByText("Partial output (unconfirmed)", { exact: true }).count()).toBe(0);
        await page.screenshot({ path: `${reportDir}/${transport}-reconciled.png` });
        expect(errors).toEqual([]);
        expect(fixture.calls()).toBe(1);
        results.push({ transport, passed: true, turnId: message.turnId, calls: fixture.calls(), errors });
      } catch (error) {
        await page.screenshot({ path: `${reportDir}/${transport}-failure.png` });
        results.push({ transport, passed: false, error: String(error), errors });
        throw error;
      } finally { await context.close(); server.stop(true); fixture.close(); }
    }
  } finally {
    await browser.close();
    writeFileSync(`${reportDir}/report.json`, JSON.stringify({ results, limitation: "Headless controlled-provider checks; no native terminal or independent acceptance claim." }, null, 2));
    console.log(`Browser evidence: ${reportDir}/report.json`);
  }
}, 60_000);
