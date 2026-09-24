#!/usr/bin/env bun
/**
 * bun run test:live — the live tier. Runs every cassette-backed test against this machine's
 * real subscriptions (Claude on ~/.claude, Codex's ChatGPT login on ~/.codex, local Kingdom),
 * re-records the cassettes, then replays them all. Structural drift from a committed cassette
 * is kept beside it as `.pending.json` and reported, never silently overwritten.
 *
 *   bun run test:live               everything
 *   bun run test:live -t "codex"    a subset (bun test filters pass through)
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { agentSessionVersion, checkFreshness, cassettes, compareVersions, installedVersions, policyPath, readPolicy, type Fixture } from "../../packages/foundry/src/vcr";
import { LIVE_FILES, bunTest, cleanEnvironment, display, driftOf, fixturesDir, livePath, noticesOf, pendingCassettes, snapshot } from "./shared";

const passthrough = process.argv.slice(2);
const SLOW_MS = 8_000;
const { path, resolved, missing } = await livePath();
if (missing.length) {
  console.error(`No working ${missing.join(" or ")} on the daemon's PATH; the live tier runs the CLIs the daemon would.`);
  process.exit(1);
}
for (const [cli, install] of resolved) console.log(`  ${cli}: ${install.binary} (${install.version.join(".")})`);

// A previous run's unreviewed drift is superseded by this run's recordings.
for (const stale of pendingCassettes()) rmSync(stale);

const before = snapshot();
const env = cleanEnvironment({ PATH: path, FOUNDRY_VCR_PATH: path, FOUNDRY_VCR_ENVIRONMENT: "terminal" });
console.log("\n== live: record every scenario against the real CLIs and services");
const recorded = await bunTest(["--timeout", "120000", ...LIVE_FILES, ...passthrough], { ...env, FOUNDRY_VCR: "record" });
console.log("\n== replay: the same tests against the fresh cassettes");
const replayed = await bunTest([...LIVE_FILES, ...passthrough], env);

// Volatile differences are worth seeing (reconnect storms, thinking) but do not hold a recording back.
for (const [path, previous] of before) {
  const pending = path.replace(/\.json$/, ".pending.json");
  const current = existsSync(pending) ? readFileSync(pending, "utf8") : existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const notices = current && current !== previous ? noticesOf(previous, current) : [];
  if (notices.length) console.log(`  notice: ${display(path)}: ${notices.join("; ")}`);
}

const drift = pendingCassettes().map(pending => ({ pending, differences: driftOf(pending.replace(/\.pending\.json$/, ".json"), pending) }));
if (drift.length) {
  console.log("\n== drift: live no longer matches these cassettes (committed ones kept)");
  for (const { pending, differences } of drift) console.log(`  ${display(pending)}\n    ${differences.join("\n    ")}`);
  console.log("  Review each: a CLI or protocol change Foundry must handle, or `bun run vcr:accept` to adopt the new recording.");
}

// Bless what was just recorded: CI then refuses any cassette older than these versions.
if (!recorded && !replayed && !drift.length && !passthrough.length) {
  const policy = readPolicy(fixturesDir);
  for (const path of cassettes(fixturesDir)) {
    const fixture = JSON.parse(readFileSync(path, "utf8")) as Fixture;
    const cli = fixture.recorded?.cli;
    if (cli && fixture.version && (!policy.blessed[cli] || compareVersions(fixture.version, policy.blessed[cli]!) > 0)) policy.blessed[cli] = fixture.version;
  }
  if (agentSessionVersion) policy.blessed["@inixiative/agent-session"] = agentSessionVersion;
  writeFileSync(policyPath(fixturesDir), `${JSON.stringify(policy, null, 2)}\n`);
}

// Latency is a live-only fact: the daemon's decision deadlines are budgets these must fit in.
const started = Date.now() - performance.now();
for (const path of cassettes(fixturesDir)) {
  const { recorded: stamp } = JSON.parse(readFileSync(path, "utf8")) as Fixture;
  if (stamp?.durationMs && stamp.durationMs > SLOW_MS && Date.parse(stamp.recordedAt) >= started)
    console.log(`  slow: ${display(path)} took ${(stamp.durationMs / 1000).toFixed(1)} s live`);
}

const findings = checkFreshness(fixturesDir, { installed: await installedVersions(["claude", "codex"]), agentSession: agentSessionVersion });
for (const finding of findings) console.log(`  stale: ${finding.cassette}: ${finding.problem}`);

const ok = !recorded && !replayed && !drift.length && !findings.length;
console.log(`\n${ok ? "✓" : "✗"} live ${recorded ? "FAILED" : "passed"}; replay ${replayed ? "FAILED" : "passed"}; ${drift.length} drift finding(s); ${findings.length} freshness finding(s)`);
process.exit(ok ? 0 : 1);
