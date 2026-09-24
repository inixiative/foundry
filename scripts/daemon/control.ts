#!/usr/bin/env bun
/**
 * Daemon lifecycle — install, start, stop, status, logs, uninstall.
 *
 *   bun run daemon:install    write the LaunchAgent and start it
 *   bun run daemon:start      bun run daemon:stop      bun run daemon:status
 *   bun run daemon:logs       bun run daemon:uninstall
 */
import { $ } from "bun";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { buildPlist, DAEMON_LABEL } from "./plist";
import { checkReadiness } from "./ready";
import { installLocations, resolveDaemonPath } from "./agent-clis";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const home = homedir();
const plistPath = `${home}/Library/LaunchAgents/${DAEMON_LABEL}.plist`;
const logDir = `${home}/Library/Logs/foundry`;
const target = `gui/${process.getuid?.() ?? 501}/${DAEMON_LABEL}`;
const domain = `gui/${process.getuid?.() ?? 501}`;

const ok = (message: string) => console.log(`✓ ${message}`);
const info = (message: string) => console.log(`  ${message}`);

const resolveBun = async () => (await $`which bun`.quiet().text()).trim() || "/opt/homebrew/bin/bun";

const isLoaded = async () => {
  try {
    await $`launchctl print ${target}`.quiet();
    return true;
  } catch {
    return false;
  }
};

const install = async () => {
  const gate = await checkReadiness(resolve(repoRoot, ".foundry"));
  if (!gate.ready) {
    console.error("Foundry is not configured, so the daemon would restart into a runtime that cannot start.\n");
    for (const error of gate.errors) console.error(`  ✗ ${error}`);
    console.error("\nRun `bun run setup` to configure a provider, then `bun run start` to check it works.");
    console.error("Install the daemon once it starts cleanly.");
    process.exit(1);
  }
  for (const warning of gate.warnings) console.log(`  ! ${warning}`);

  const bunPath = await resolveBun();
  await mkdir(logDir, { recursive: true });
  await mkdir(`${home}/Library/LaunchAgents`, { recursive: true });

  const { pathEntries, resolved, missing } = await resolveDaemonPath(bunPath, home);
  if (missing.length) {
    console.error(`No working ${missing.join(" or ")} was found for the daemon's environment.`);
    console.error("The daemon starts with only the PATH written to its LaunchAgent, so every agent CLI must launch there.");
    for (const cli of missing) console.error(`  ✗ ${cli}: tried ${(await installLocations(cli, home)).join(", ") || "no install found"}`);
    process.exit(1);
  }
  for (const [cli, install] of resolved) info(`${cli}: ${install.binary} (${install.version.join(".")})`);

  await writeFile(
    plistPath,
    buildPlist({
      repoRoot,
      bunPath,
      logDir,
      port: Number.parseInt(process.env.VIEWER_PORT ?? "4400", 10),
      pathEntries,
    }),
  );
  ok(`wrote ${plistPath}`);

  if (await isLoaded()) await $`launchctl bootout ${target}`.quiet().nothrow();
  await $`launchctl bootstrap ${domain} ${plistPath}`;
  ok(`daemon installed and running — http://localhost:${process.env.VIEWER_PORT ?? "4400"}`);
  info(`logs: ${logDir}/foundry.out.log`);
  info(`auto-update is off by default; set daemon.autoUpdate to "apply" in .foundry/settings.json`);
};

const uninstall = async () => {
  if (await isLoaded()) await $`launchctl bootout ${target}`.nothrow();
  await rm(plistPath, { force: true });
  ok("daemon stopped and LaunchAgent removed");
};

const start = async () => {
  if (!(await isLoaded())) {
    await $`launchctl bootstrap ${domain} ${plistPath}`;
    ok("daemon started");
    return;
  }
  await $`launchctl kickstart -k ${target}`;
  ok("daemon restarted");
};

const stop = async () => {
  await $`launchctl bootout ${target}`.nothrow();
  ok("daemon stopped");
};

const status = async () => {
  if (!(await isLoaded())) {
    console.log("daemon: not loaded");
    return;
  }
  const out = await $`launchctl print ${target}`.quiet().text();
  const pid = out.match(/pid = (\d+)/)?.[1];
  const lastExit = out.match(/last exit code = (\d+)/)?.[1];
  console.log(`daemon: loaded${pid ? `, running (pid ${pid})` : ", not running"}`);
  if (lastExit) info(`last exit code: ${lastExit}${lastExit === "75" ? " (restarted for update)" : ""}`);
  info(`viewer: http://localhost:${process.env.VIEWER_PORT ?? "4400"}`);
};

const commands: Record<string, () => Promise<void>> = { install, uninstall, start, stop, status };

const command = process.argv[2];
const run = command ? commands[command] : undefined;
if (!run) {
  console.error(`usage: control.ts <${Object.keys(commands).join("|")}>`);
  process.exit(1);
}
await run();
