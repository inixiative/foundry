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
import { buildPlist, DAEMON_LABEL } from "./plist";

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
  const bunPath = await resolveBun();
  await mkdir(logDir, { recursive: true });
  await mkdir(`${home}/Library/LaunchAgents`, { recursive: true });

  const pathEntries = [
    bunPath.replace(/\/bun$/, ""),
    `${home}/.bun/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];

  await writeFile(
    plistPath,
    buildPlist({
      repoRoot,
      bunPath,
      logDir,
      port: Number.parseInt(process.env.VIEWER_PORT ?? "4400", 10),
      pathEntries: [...new Set(pathEntries)],
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
