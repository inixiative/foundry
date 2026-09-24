import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeJobsInFlight } from "./idle";

const runtimeDir = async () => mkdtemp(join(tmpdir(), "foundry-idle-"));

const jobLock = async (root: string, jobId: string) => {
  const directory = join(root, "runtime-jobs", jobId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return join(directory, "active.sqlite");
};

describe("runtimeJobsInFlight", () => {
  test("no runtime directory means nothing is running", async () => {
    expect(await runtimeJobsInFlight(undefined)).toBe(false);
  });

  test("an unenrolled runtime with no jobs directory is idle", async () => {
    expect(await runtimeJobsInFlight(await runtimeDir())).toBe(false);
  });

  test("a job whose lock is not held is finished", async () => {
    const root = await runtimeDir();
    const path = await jobLock(root, "done");
    new Database(path).close();
    expect(await runtimeJobsInFlight(root)).toBe(false);
  });

  test("a held lock reports the runtime busy", async () => {
    const root = await runtimeDir();
    const path = await jobLock(root, "running");
    const holder = new Database(path);
    holder.exec("BEGIN IMMEDIATE");
    try {
      expect(await runtimeJobsInFlight(root)).toBe(true);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });

  test("one held lock among several is enough to block a restart", async () => {
    const root = await runtimeDir();
    new Database(await jobLock(root, "finished")).close();
    const holder = new Database(await jobLock(root, "busy"));
    holder.exec("BEGIN IMMEDIATE");
    try {
      expect(await runtimeJobsInFlight(root)).toBe(true);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });
});
