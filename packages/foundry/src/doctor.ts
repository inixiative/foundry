#!/usr/bin/env bun
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectReadiness } from "./readiness";
import { ConfigStore } from "./viewer/config";

/** Inspect existing settings without starting servers, agents or authentication flows. */
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) { console.log("Usage: bun run doctor [configuration-directory]\nReads existing settings.json; checks local setup without making provider or Kastle requests."); return; }
  if (args.length > 1 || args[0]?.startsWith("--")) throw Error("Invalid arguments");
  const directory = resolve(args[0] ?? ".foundry");
  if (!(await stat(resolve(directory, "settings.json"))).isFile()) throw Error("Missing settings");
  const config = await new ConfigStore(directory).load();
  const report = await inspectReadiness(config);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.configurationReady ? 0 : 1;
}
if (import.meta.main) await main().catch(() => {
  console.log(JSON.stringify({ configurationReady: false, liveAccess: "unverified", profiles: [], issues: [{ severity: "error", scope: "global", code: "settings-unavailable", message: "Existing settings.json could not be loaded. Check the directory and configuration; no agents were started." }] }, null, 2));
  process.exitCode = 1;
});
