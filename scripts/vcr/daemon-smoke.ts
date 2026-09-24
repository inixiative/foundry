#!/usr/bin/env bun
/**
 * bun run test:live:daemon — the launchd tier. Submits a throwaway LaunchAgent built by the
 * daemon's own buildPlist, with the installed daemon's PATH and ProcessType and no terminal
 * environment, and runs a small live smoke inside it: the status probes and one decision per
 * runtime. Recordings go to a scratch directory and are compared with the committed cassettes,
 * so launchd-only failures (PATH, throttling, slow auth) show up as failures or drift findings.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { buildPlist, DAEMON_LABEL } from "../daemon/plist";
import { cassettes } from "../../packages/foundry/src/vcr";
import { display, driftOf, fixturesDir, livePath, repoRoot } from "./shared";

const uid = process.getuid?.() ?? 501;
const installedPlist = join(homedir(), "Library/LaunchAgents", `${DAEMON_LABEL}.plist`);

/** The environment launchd actually gives the daemon: the installed plist when there is one. */
async function daemonEnvironment() {
  if (existsSync(installedPlist)) {
    const plist = JSON.parse(await $`plutil -convert json -o - ${installedPlist}`.quiet().text()) as {
      EnvironmentVariables?: Record<string, string>; ProcessType?: string; ProgramArguments?: string[] };
    const path = plist.EnvironmentVariables?.PATH;
    if (path) return { source: "installed LaunchAgent", path, processType: plist.ProcessType ?? "Standard", bun: plist.ProgramArguments?.[0] ?? process.execPath };
  }
  const live = await livePath();
  return { source: "daemon:install resolution (no LaunchAgent installed)", path: live.path, processType: "Interactive", bun: live.bun };
}

const daemon = await daemonEnvironment();
const expectedType = /<key>ProcessType<\/key>\s*<string>(\w+)<\/string>/.exec(buildPlist({ repoRoot, bunPath: daemon.bun, logDir: "/", port: 0, pathEntries: [] }))?.[1];
console.log(`  environment: ${daemon.source}\n  PATH: ${daemon.path}\n  ProcessType: ${daemon.processType}${expectedType && expectedType !== daemon.processType ? ` (daemon:install would write ${expectedType}; reinstall the daemon)` : ""}`);

const work = mkdtempSync(join(tmpdir(), "foundry-vcr-smoke-"));
const label = `com.inixiative.foundry.vcr-smoke.${process.pid}`;
const reportPath = join(work, "report.json"), recordings = join(work, "cassettes");
const plist = buildPlist({ repoRoot, bunPath: daemon.bun, logDir: work, port: 0, pathEntries: daemon.path.split(":"), job: {
  label, programArguments: [daemon.bun, "run", join(repoRoot, "scripts/vcr/daemon-smoke-job.ts"), reportPath],
  environment: { FOUNDRY_VCR: "record", FOUNDRY_VCR_OUT: recordings, FOUNDRY_VCR_PATH: daemon.path, FOUNDRY_VCR_ENVIRONMENT: "launchd" },
  stdoutPath: join(work, "out.log"), stderrPath: join(work, "err.log"),
} }).replace(/<key>ProcessType<\/key>\s*<string>\w+<\/string>/, `<key>ProcessType</key>\n  <string>${daemon.processType}</string>`);
const plistPath = join(work, `${label}.plist`);
writeFileSync(plistPath, plist);

const target = `gui/${uid}/${label}`;
let report: { exitCode: number; facts: Record<string, unknown> } | undefined;
const bootout = () => $`launchctl bootout ${target}`.quiet().nothrow();
process.once("SIGINT", () => { void bootout().then(() => process.exit(130)); });
try {
  const loaded = await $`launchctl bootstrap gui/${uid} ${plistPath}`.quiet().nothrow();
  if (loaded.exitCode !== 0) console.error(`  launchctl bootstrap failed: ${loaded.stderr.toString().trim()}`);
  else {
    // Until the report appears, or the job has exited without one.
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline && !existsSync(reportPath)) {
      await Bun.sleep(1_000);
      const state = await $`launchctl print ${target}`.quiet().nothrow().text();
      if (!existsSync(reportPath) && !/state = running/.test(state) && /last exit code = (?!\(never exited\))/.test(state)) { await Bun.sleep(1_000); break; }
    }
  }
  if (existsSync(reportPath)) report = JSON.parse(readFileSync(reportPath, "utf8"));
} finally {
  await bootout();
}

const log = (name: string) => existsSync(join(work, name)) ? readFileSync(join(work, name), "utf8") : "";
const output = `${log("out.log")}${log("err.log")}`;
console.log(output.split("\n").filter(line => /^\((pass|fail|skip)\)|^\s*\d+ (pass|fail)|error:/.test(line)).map(line => `  ${line}`).join("\n"));
if (!report) {
  console.error(`✗ the smoke job did not finish under launchd; logs kept in ${work}`);
  process.exit(1);
}
console.log(`\n  launchd facts: ${JSON.stringify(report.facts, null, 2).replaceAll("\n", "\n  ")}`);

// Launchd recordings are evidence too: compare their structure with the committed cassettes.
const drift: string[] = [];
for (const path of cassettes(recordings)) {
  const committed = join(fixturesDir, path.slice(recordings.length + 1).replace(/\.pending\.json$/, ".json"));
  const differences = driftOf(committed, path);
  if (differences.length) drift.push(`${display(committed)}\n      ${differences.join("\n      ")}`);
  const recorded = JSON.parse(readFileSync(path, "utf8")) as { recorded?: { durationMs?: number } };
  const terminal = existsSync(committed) ? (JSON.parse(readFileSync(committed, "utf8")) as { recorded?: { durationMs?: number } }).recorded?.durationMs : undefined;
  if (recorded.recorded?.durationMs !== undefined && !path.includes("outcome."))
    console.log(`  ${display(committed)}: ${recorded.recorded.durationMs} ms under launchd${terminal !== undefined ? `, ${terminal} ms in the terminal recording` : ""}`);
}
if (drift.length) console.log(`\n  drift between launchd and the committed cassettes:\n    ${drift.join("\n    ")}`);

const ok = report.exitCode === 0 && !drift.length;
if (ok) rmSync(work, { recursive: true, force: true });
console.log(`\n${ok ? "✓" : "✗"} launchd smoke ${report.exitCode === 0 ? "passed" : "FAILED"}; ${drift.length} drift finding(s)${ok ? "" : `; logs and recordings kept in ${work}`}`);
process.exit(ok ? 0 : 1);
