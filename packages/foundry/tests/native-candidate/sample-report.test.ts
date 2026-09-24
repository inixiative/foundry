import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSample } from "../../../../scripts/native-foundry-sample";
import { sha256 } from "../../../../scripts/stage-native-package";

// Explicitly run inside a reviewed installed candidate. Every subprocess is
// refused; only disposable production viewer/runtime/journal setup is exercised.
for (const engine of ["claude", "mcp"]) for (const mode of ["missing-module", "browser"] as const) for(const retrieval of [false,true]) {
  test(`actual ${engine} ${retrieval?"retrieval":"sentinel"} sample reports ${mode} failure without native writes or process construction`, async () => {
    const manifest = process.env.FOUNDRY_QA_NATIVE_MANIFEST;
    if (!manifest) throw Error("Run explicitly with the reviewed FOUNDRY_QA_NATIVE_MANIFEST in an installed candidate");
    const dir = await mkdtemp(join(tmpdir(), "foundry-sample-browser-"));
    const module = join(dir, "browser.cjs");
    const previousModule = process.env.FOUNDRY_QA_PLAYWRIGHT;
    const previousSpawn = Bun.spawn;
    let spawns = 0;
    Bun.spawn = (() => { spawns++; throw Error("No native or other subprocess authorized by this offline test"); }) as typeof Bun.spawn;
    try {
      if (mode === "browser") await writeFile(module, 'module.exports = { chromium: { async launch() { return { async newPage() { return { async goto() { throw Error("PRIVATE_TEST_MARKER"); } }; }, async close() {} }; } } };\n');
      process.env.FOUNDRY_QA_PLAYWRIGHT = module;
      const runId = `i1-offline-${engine}-${crypto.randomUUID()}`;
      const result = await runSample(engine, runId, manifest, retrieval);
      const file = Bun.file(result.report); const before = sha256(await file.bytes()); const report = await file.json();
      expect(result.passed).toBe(false); expect(report.failurePhase).toBe(mode === "browser" ? "browser" : "setup");
      expect(report.turns).toEqual([]); expect(report.writes).toBe(0); expect(report.spawns).toBe(0); expect(spawns).toBe(0);
      expect(report.cleanupFailures).toEqual([]); expect(report.projectUnchanged).toBe(true); expect(report.guard.closed).toBe(true);
      expect(report.finishedAt).toBeString(); expect(JSON.stringify(report)).not.toContain("PRIVATE_TEST_MARKER");
      await expect(runSample(engine, runId, manifest, retrieval)).rejects.toThrow(); // no historical output reuse
      expect(sha256(await file.bytes())).toBe(before); expect(spawns).toBe(0);
      // Keep candidate reports/journals for independent inspection.
    } finally {
      Bun.spawn = previousSpawn;
      if (previousModule === undefined) delete process.env.FOUNDRY_QA_PLAYWRIGHT; else process.env.FOUNDRY_QA_PLAYWRIGHT = previousModule;
      await rm(dir, { recursive: true, force: true });
    }
  });
}
