#!/usr/bin/env bun
/**
 * Daemon entrypoint. Updates before launching — nothing is running yet at that
 * point, so there is no in-flight job to interrupt — then hands off to start.ts.
 */
import { applyUpdate, RESTART_EXIT_CODE } from "./update";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

const stamp = () => new Date().toISOString();
const log = (message: string) => console.log(`[${stamp()}] daemon: ${message}`);

const result = await applyUpdate(repoRoot);
if (result.action === "applied") {
  log(`pulled ${result.behind} commit(s) from origin/main; exiting for relaunch`);
  process.exit(RESTART_EXIT_CODE);
}
if (result.action === "reported") log(`${result.behind} commit(s) behind origin/main (autoUpdate is not "apply")`);
if (result.action === "failed") log(`update skipped — ${result.detail}`);

log(`starting viewer on port ${process.env.VIEWER_PORT ?? "4400"}`);
await import(`${repoRoot}/packages/foundry/src/start.ts`);
