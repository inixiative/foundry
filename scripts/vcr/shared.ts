import { homedir } from "node:os";
import { join, relative } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { $ } from "bun";
import { resolveDaemonPath } from "../daemon/agent-clis";
import { cassettes, compareSignatures, signatureOf, volatileDifferences, type Fixture } from "../../packages/foundry/src/vcr";

export const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
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

/** A child environment with none of the calling terminal's agent session, credentials or wrappers. */
export function cleanEnvironment(extra: Record<string, string>): Record<string, string> {
  const keep = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "SHELL", "TERM"];
  return { ...Object.fromEntries(keep.filter(key => process.env[key]).map(key => [key, process.env[key]!])), ...extra };
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
  return await child.exited;
}
