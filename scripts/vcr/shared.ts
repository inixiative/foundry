import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { $ } from "bun";
import { resolveDaemonPath } from "../daemon/agent-clis";
import { cassettes, compareSignatures, signatureOf, volatileDifferences, type Fixture } from "../../packages/foundry/src/vcr";

export const repoRoot = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
export const fixturesDir = join(repoRoot, "packages/foundry/tests/fixtures/vcr");

/** Test files whose transports are cassettes; `test:live` records and replays exactly these. */
export const LIVE_FILES = [
  "vcr-scenarios.test.ts",
  "native-text-provider.test.ts",
  "subscription-decisions.test.ts",
  "subscription-default.test.ts",
  "subscription-policy.test.ts",
].map(file => `./packages/foundry/tests/${file}`);

/** The launchd smoke: status probes and one decision per runtime, in the daemon's environment. */
export const SMOKE = { file: "./packages/foundry/tests/vcr-scenarios.test.ts", filter: "auth status|login status|text decision|codex decision" };

/** The PATH the daemon installer would write: the newest working install of each agent CLI. */
export async function livePath() {
  const bun = (await $`which bun`.quiet().nothrow().text()).trim() || process.execPath;
  const { pathEntries, resolved, missing } = await resolveDaemonPath(bun, homedir());
  return { path: pathEntries.join(":"), resolved, missing, bun };
}

/** A child environment with none of the calling terminal's agent session, credentials or wrappers.
 * The VCR's own knobs (FOUNDRY_VCR_MAX_LIVE, FOUNDRY_VCR_KINGDOM_URL) pass through. */
export function cleanEnvironment(extra: Record<string, string>): Record<string, string> {
  const keep = (key: string) => ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "SHELL", "TERM"].includes(key) || key.startsWith("FOUNDRY_VCR_");
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => keep(key) && value !== undefined) as [string, string][]), ...extra };
}

/** Live tiers rewrite cassettes; the checkout the daemon runs must never be dirtied. */
export async function refuseDaemonCheckout() {
  const daemon = (await $`launchctl print gui/${process.getuid?.() ?? 501}/com.inixiative.foundry`.quiet().nothrow().text());
  if (daemon.includes(`${repoRoot}/scripts/daemon/supervisor.ts`)) {
    console.error(`Refusing: ${repoRoot} is the checkout the daemon runs. Run live tiers from a worktree.`);
    process.exit(1);
  }
}

export const pendingCassettes = (dir = fixturesDir) => cassettes(dir).filter(path => path.endsWith(".pending.json"));

/** Structural differences between a committed cassette and a newer recording of it. */
export function driftOf(committedPath: string, recordingPath: string): string[] {
  if (!existsSync(committedPath)) return ["new cassette"];
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Fixture;
  const before = read(committedPath), after = read(recordingPath);
  return compareSignatures(signatureOf(before.status, before.body), signatureOf(after.status, after.body));
}

/** Every cassette's content, to compare this run's recordings against afterwards. */
export const snapshot = (dir = fixturesDir) => new Map(cassettes(dir).map(path => [path, readFileSync(path, "utf8")]));

/** Volatile differences (thinking, rate-limit notices, reconnects) between two recordings of one cassette. */
export function noticesOf(before: string, after: string): string[] {
  const parse = (text: string) => JSON.parse(text) as Fixture;
  const was = parse(before), now = parse(after);
  return volatileDifferences(signatureOf(was.status, was.body), signatureOf(now.status, now.body));
}

export const display = (path: string) => relative(repoRoot, path);

export async function bunTest(args: string[], env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, "test", ...args], { cwd: repoRoot, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code) console.log(`  bun test exited ${code}${child.signalCode ? ` (${child.signalCode})` : ""}`);
  return code;
}
