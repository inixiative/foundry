import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createGlossPreview } from "./gloss-preview";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const output = resolve(".foundry/gloss-qa");
mkdirSync(output, { recursive: true });
const preview = await createGlossPreview();
let browser;
const errors: string[] = [];
let assertions = 0;
const check = (value: unknown, message: string) => { assertions++; if (!value) throw new Error(message); };
try {
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(preview.url, { waitUntil: "networkidle" });
    await page.locator(".proj-item-label", { hasText: "Gloss review sample" }).click();
    await page.getByRole("button", { name: "Gloss", exact: true }).click();
    await page.getByRole("region", { name: "Gloss for file", exact: true }).waitFor();
    check(await page.getByText("Review decisions are scoped to one source revision.", { exact: true }).isVisible(), "file preamble visible");
    await page.getByLabel("Section", { exact: true }).selectOption("canMerge");
    await page.getByText("Rejects approvals left on older revisions.", { exact: false }).waitFor();
    await page.getByText("Freshness unavailable:", { exact: false }).waitFor();
    await page.screenshot({ path: `${output}/${viewport.width}-margin.png`, fullPage: true });
    check(await page.locator(".gloss-review").evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth), "review has no horizontal viewport overflow");
    check(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth), "background does not widen mobile overlay");
    await page.getByLabel("Display", { exact: true }).selectOption("inline");
    check(await page.locator(".gloss-line-block > .gloss-note").count() === 1, "selected inline note exists");
    await page.screenshot({ path: `${output}/${viewport.width}-inline.png`, fullPage: true });
    await page.getByLabel("Display", { exact: true }).selectOption("hover");
    await page.getByRole("button", { name: "Show gloss for canMerge", exact: true }).focus();
    check(await page.getByRole("tooltip").isVisible(), "keyboard focus exposes hover note");
    await page.screenshot({ path: `${output}/${viewport.width}-hover.png`, fullPage: true });
    await page.getByRole("button", { name: "Show gloss for canMerge", exact: true }).click();
    await page.getByRole("button", { name: "View history", exact: true }).click();
    await page.getByText("no history", { exact: true }).waitFor();
    await page.getByLabel("Display", { exact: true }).selectOption("margin");
    await page.getByLabel("Source file", { exact: true }).fill("src/empty.ts");
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.getByText("No commentary for this file", { exact: true }).waitFor();
    check(await page.getByText("export const withoutNotes = true;", { exact: true }).isVisible(), "unglossed source remains visible");
    await page.getByLabel("Source file", { exact: true }).fill("../escape.ts");
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.getByRole("alert").waitFor();
    check(await page.locator(".gloss-code-line").count() === 0, "failed load clears previous source");
    await page.keyboard.press("Escape");
    check(await page.getByRole("dialog", { name: "Gloss code review" }).count() === 0, "Escape closes review");
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(preview.url, { waitUntil: "networkidle" });
  await page.locator(".proj-item-label", { hasText: "Gloss review sample" }).click();
  // Use the existing Settings keyboard command; no mocked settings or API data.
  await page.keyboard.press("s");
  await page.locator(".settings-nav").getByRole("button", { name: "Gloss", exact: true }).click();
  await page.getByLabel("Enable Gloss maintenance").waitFor();
  check(await page.getByRole("button", { name: "Harvest comments", exact: true }).isDisabled(), "maintenance disabled by default");
  await page.getByLabel("Enable Gloss maintenance").check();
  await page.getByRole("button", { name: "Set up / update", exact: true }).click();
  check(await page.getByRole("alertdialog", { name: "Confirm Gloss changes" }).isVisible(), "write confirmation shown");
  await page.getByRole("button", { name: "Confirm setup", exact: true }).click();
  await page.getByLabel("Gloss result").waitFor();
  check((await page.getByLabel("Gloss result").innerText()).includes("CLAUDE.md"), "setup result rendered");
  await page.getByRole("button", { name: "Harvest comments", exact: true }).click();
  await page.getByRole("button", { name: "Confirm harvest", exact: true }).click();
  await page.getByLabel("Gloss result").filter({ hasText: "legacy.ts" }).waitFor();
  await page.getByRole("button", { name: "Check bindings", exact: true }).click();
  await page.getByLabel("Gloss result").filter({ hasText: "violations" }).waitFor();
  check((await page.getByLabel("Gloss result").innerText()).includes('"violations": []'), "harvested tree passes check");
  await page.screenshot({ path: `${output}/settings.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.getByLabel("Enable Gloss maintenance").isVisible(), "mobile maintenance controls visible");
  check(await page.locator(".settings-body").evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth), "mobile settings do not overflow");
  await page.screenshot({ path: `${output}/390-settings.png`, fullPage: true });
  await page.close();
  check(errors.length === 0, `browser errors: ${errors.join("; ")}`);
  await Bun.write(`${output}/report.json`, JSON.stringify({ assertions, errors, viewports: [1440, 390] }, null, 2));
  console.log(JSON.stringify({ assertions, errors, output }));
} catch (error) {
  console.error(JSON.stringify({ assertions, errors }));
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
    await page.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => {});
    console.error((await page.locator("body").innerText()).slice(0, 4000));
  }
  throw error;
} finally {
  await browser?.close();
  preview.dispose();
}
