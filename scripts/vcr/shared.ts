/**
 * @atlas
 * @kind helper
 * @partOf primitive:vcr
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { $ } from 'bun';
import { resolveDaemonPath } from '../../packages/foundry/src/daemon/agent-clis';
import {
  cassettes,
  diffCassetteDrift,
  diffVolatileCassetteNotices,
  FOUNDRY_SIGNATURE_OPTIONS,
  fetchPendingCassettes,
} from '../../packages/foundry/src/vcr';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
export const fixturesDir = join(repoRoot, 'packages/foundry/tests/fixtures/vcr');

/** Test files whose transports are cassettes; `test:live` records and replays exactly these. */
export const LIVE_FILES = [
  'vcr-scenarios.test.ts',
  'native-text-provider.test.ts',
  'subscription-decisions.test.ts',
  'subscription-default.test.ts',
  'subscription-policy.test.ts',
].map((file) => `./packages/foundry/tests/${file}`);

/** The launchd smoke: status probes and one Claude text decision, in the daemon's environment. */
export const SMOKE = {
  file: './packages/foundry/tests/vcr-scenarios.test.ts',
  filter: 'auth status|login status|text decision',
};

/** The PATH the daemon installer would write: the newest working install of each agent CLI. */
export async function livePath() {
  const bun = (await $`which bun`.quiet().nothrow().text()).trim() || process.execPath;
  const { pathEntries, resolved, missing } = await resolveDaemonPath(bun, homedir());
  return { path: pathEntries.join(':'), resolved, missing, bun };
}

/** A child environment with none of the calling terminal's agent session, credentials or wrappers.
 * The VCR's own knobs (FOUNDRY_VCR_MAX_LIVE, FOUNDRY_VCR_KINGDOM_URL) pass through. */
export function cleanEnvironment(extra: Record<string, string>): Record<string, string> {
  const keep = (key: string) =>
    ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'TERM'].includes(key) ||
    key.startsWith('FOUNDRY_VCR_');
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key, value]) => keep(key) && value !== undefined) as [
        string,
        string,
      ][],
    ),
    ...extra,
  };
}

/** Live tiers rewrite cassettes; the checkout the daemon runs must never be dirtied. */
export async function refuseDaemonCheckout() {
  const daemon = await $`launchctl print gui/${process.getuid?.() ?? 501}/com.inixiative.foundry`
    .quiet()
    .nothrow()
    .text();
  if (daemon.includes(`${repoRoot}/scripts/daemon/supervisor.ts`)) {
    console.error(
      `Refusing: ${repoRoot} is the checkout the daemon runs. Run live tiers from a worktree.`,
    );
    process.exit(1);
  }
}

export const pendingCassettes = (dir = fixturesDir) => fetchPendingCassettes(dir);

/** Structural differences between a committed cassette and a newer recording of it. */
export const driftOf = (committedPath: string, recordingPath: string): string[] =>
  diffCassetteDrift(committedPath, recordingPath, FOUNDRY_SIGNATURE_OPTIONS);

/** Every cassette's content, to compare this run's recordings against afterwards. */
export const snapshot = (dir = fixturesDir) =>
  new Map(cassettes(dir).map((path) => [path, readFileSync(path, 'utf8')]));

/** Volatile differences (thinking, rate-limit notices, reconnects) between two recordings of one cassette. */
export const noticesOf = (before: string, after: string): string[] =>
  diffVolatileCassetteNotices(before, after, FOUNDRY_SIGNATURE_OPTIONS);

export const display = (path: string) => relative(repoRoot, path);

export async function bunTest(args: string[], env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, 'test', ...args], {
    cwd: repoRoot,
    env,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await child.exited;
  if (code)
    console.log(`  bun test exited ${code}${child.signalCode ? ` (${child.signalCode})` : ''}`);
  return code;
}
