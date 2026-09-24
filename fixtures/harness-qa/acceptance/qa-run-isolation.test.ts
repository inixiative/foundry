import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { createQARunDirectory } from "../../../scripts/qa-run-directory";

test("simultaneous checks with the same timestamp and gate retain independent evidence", async () => {
  const base = await mkdtemp(join(tmpdir(), "foundry-run-isolation-"));
  try {
    const runs = await Promise.all(Array.from({ length: 32 }, () => createQARunDirectory(base, "G3", "2026-09-07T04:33:06.747Z")));
    expect(new Set(runs).size).toBe(32);
    for (const [i, run] of runs.entries()) {
      expect(dirname(run)).toBe(base);
      expect(basename(run).endsWith("-G3")).toBe(true);
      await Bun.write(join(run, "report.json"), JSON.stringify({ check: i }));
    }
    for (const [i, run] of runs.entries()) expect(await Bun.file(join(run, "report.json")).json()).toEqual({ check: i });
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("a repeated check cannot overwrite evidence in a preexisting timestamp directory", async () => {
  const base = await mkdtemp(join(tmpdir(), "foundry-run-repeat-"));
  try {
    const first = await createQARunDirectory(base, "G5", "2026-09-07T04:33:06.747Z");
    await Bun.write(join(first, "report.json"), "ORIGINAL_EVIDENCE");
    const second = await createQARunDirectory(base, "G5", "2026-09-07T04:33:06.747Z");
    expect(second).not.toBe(first);
    expect(await Bun.file(join(first, "report.json")).text()).toBe("ORIGINAL_EVIDENCE");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("untrusted run labels cannot escape the evidence root", async () => {
  const base = await mkdtemp(join(tmpdir(), "foundry-run-label-"));
  try {
    await expect(createQARunDirectory(base, "../escape", "2026-09-07T04:33:06.747Z")).rejects.toThrow("Invalid QA run identity");
    await expect(createQARunDirectory(base, "G3", "../../escape")).rejects.toThrow("Invalid QA run identity");
  } finally { await rm(base, { recursive: true, force: true }); }
});
