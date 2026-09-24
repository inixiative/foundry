import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOwnedPlaywrightDriver } from "../../../scripts/owned-playwright-driver";
import { collect, freezeCopy, sha256 } from "../../../scripts/stage-native-package";
import { foundryAllowed } from "../../../scripts/prepare-native-adoption";

test("driver can launch from a frozen non-executable host without mutating its source", async () => {
  const source = resolve(import.meta.dir, "../../../scripts");
  const name = "owned-browser-host.mjs";
  expect(foundryAllowed(`scripts/${name}`)).toBe(true);
  const files = await collect(source, path => path === name, () => false);
  expect(files).toHaveLength(1);
  const scratch = await mkdtemp(join(tmpdir(), "foundry-owned-browser-packaging-"));
  try {
    const target = join(scratch, "frozen");
    await freezeCopy(source, target, files);
    const hostScript = join(target, name);
    expect((await stat(hostScript)).mode & 0o777).toBe(0o444);
    const stopped = Error("controlled launch inspection; no process started");
    let launchCount = 0;
    let executableMode = 0;
    // Inspect the actual executable handed to Playwright, then refuse before any spawn.
    const driver = createOwnedPlaywrightDriver({ hostScript, chromium: {
      async launch(options) {
        launchCount++;
        executableMode = (await stat(String(options.executablePath))).mode;
        throw stopped;
      },
    } });
    await expect(driver.launchWithProcess({ headless: true, timeout: 10000 })).rejects.toBe(stopped);
    expect(launchCount).toBe(1);
    expect(sha256(await readFile(hostScript))).toBe(files[0]!.sha256);
    expect((await stat(hostScript)).mode & 0o777).toBe(0o444);
    expect(executableMode & 0o111).not.toBe(0);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
