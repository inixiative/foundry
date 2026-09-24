#!/usr/bin/env bun
/**
 * Daemon entrypoint. Updates before launching — nothing is running yet at that
 * point, so there is no in-flight job to interrupt — then hands off to start.ts
 * and keeps watching, because a daemon left running for days would otherwise
 * never see main move.
 */
import { dirname, resolve } from "node:path";
import { applyUpdate, RESTART_EXIT_CODE } from "./update";
import { startUpdateWatcher } from "./watch";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

const log = (message: string) => console.log(`[${new Date().toISOString()}] daemon: ${message}`);

const readSettings = async () => {
  try {
    return await Bun.file(`${repoRoot}/.foundry/settings.json`).json();
  } catch {
    return undefined;
  }
};

const result = await applyUpdate(repoRoot);
if (result.action === "applied") {
  log(`pulled ${result.behind} commit(s) from origin/main; exiting for relaunch`);
  process.exit(RESTART_EXIT_CODE);
}
if (result.action === "reported") log(`${result.behind} commit(s) behind origin/main (autoUpdate is not "apply")`);
if (result.action === "failed") log(`update skipped — ${result.detail}`);

const settings = await readSettings();
const credentialFile = settings?.kingdomRuntime?.credentialFile;
const checkSeconds = Number(settings?.daemon?.updateCheckSeconds ?? 300);
if (Number.isSafeInteger(checkSeconds) && checkSeconds >= 30)
  startUpdateWatcher({
    repoRoot,
    intervalMs: checkSeconds * 1000,
    runtimeDirectory: credentialFile ? dirname(resolve(credentialFile)) : undefined,
    log,
  });

log(`starting viewer on port ${process.env.VIEWER_PORT ?? "4400"}`);
await import(`${repoRoot}/packages/foundry/src/start.ts`);
