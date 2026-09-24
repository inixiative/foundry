import { lstat, realpath } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { assertPrivateProfile } from "./private-profile";
import { writePrivateJson } from "./kastle-credential-file";
import { lockRuntimeJob } from "./runtime-job-lock";
export async function lockNativeCycle(profileDirectory: string): Promise<((cleanupConfirmed: boolean) => void) | null> {
  assertPrivateProfile(profileDirectory);
  const canonical = await realpath(profileDirectory);
  assertPrivateProfile(canonical);
  const release = await lockRuntimeJob(join(canonical, ".foundry-cycle.sqlite"));
  if (!release) return null;
  const settlement = join(canonical, ".foundry-cycle-unsettled.json");
  try {
    try { await lstat(settlement); throw Error("Native profile has an unsettled cycle; operator cleanup verification is required"); }
    catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
    await writePrivateJson(settlement, { schema: 1, leaseId: crypto.randomUUID(), pid: process.pid, startedAt: new Date().toISOString() });
  } catch (error) { release(); throw error; }
  return cleanupConfirmed => { try { if (cleanupConfirmed) unlinkSync(settlement); } finally { release(); } };
}
