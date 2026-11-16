/**
 * @atlas
 * @kind service
 * @partOf feature:daemon
 */
/**
 * Agent-CLI upgrades at daemon start (`daemon.updateAgentClis`, off by default). The supervisor runs
 * this before a release boots, so no session is running on a CLI it moves. Each CLI is upgraded the
 * way its own install upgrades, found where the daemon finds it:
 * - Claude Code and Codex: `<binary> update`. Each CLI picks the right path for its install (Claude's
 *   native installer or its package manager; Codex's bun, npm, pnpm, Homebrew or standalone install,
 *   which its JS shim tells it). An app's bundled copy is the app's to update.
 * - Muse Code: only to the version agent-session speaks (`MUSE_SDK_VERSION`). Meta's launcher installs
 *   its channel's newest release and keeps no other, so it can neither pin nor downgrade: one below the
 *   pin is moved with the launcher's install and checked against the pin, one above it is reported.
 * After an upgrade the version is read again and the login checked by the CLI's read-only status
 * check. The report, `<config>/agent-clis.json`, is what `/api/daemon/update` shows, with the
 * cassettes recorded on an older CLI than the one installed: those need `bun run test:live`.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type NativeRuntime,
  withoutCompetingCredentials,
} from '../providers/native-authentication';
import { nativeLoginSignedIn } from '../providers/subscription-authentication';
import { checkFreshness, policyPath } from '../vcr/freshness';
import { compareVersions } from '../vcr/versions';
import {
  AGENT_CLIS,
  ensureAgentClisOnPath,
  type Install,
  inAppBundle,
  PINNED_CLI_VERSIONS,
} from './agent-clis';

export type AgentCliOutcome = 'updated' | 'current' | 'not-updated' | 'failed' | 'missing';

export interface AgentCliResult {
  cli: string;
  binary?: string;
  before?: string;
  after?: string;
  outcome: AgentCliOutcome;
  /** Why it was not updated, or what failed (an upgrade's last output, truncated). */
  detail?: string;
  /** The read-only login check after an upgrade ran; absent when none ran. */
  signedIn?: boolean;
}

export interface AgentCliReport {
  checkedAt: string;
  /** Whether `daemon.updateAgentClis` was on for this start. */
  updates: boolean;
  clis: AgentCliResult[];
  /** Cassettes recorded on an older CLI than the one installed (`bun run test:live` re-records them). */
  reRecord: Array<{ cli: string; installed: string; cassettes: number }>;
}

export type RunCommand = (
  argv: string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
) => Promise<{ exitCode: number; output: string }>;

export interface AgentCliUpdateOptions {
  /** `daemon.updateAgentClis`: off, nothing is upgraded and no login is checked. */
  updates: boolean;
  configDir: string;
  /** The booting release's cassettes, for the re-record check. */
  fixturesDir?: string;
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
  /** Seams: where each CLI is (default: the daemon's resolver, on a copy of `env`), how a command runs, the login check, the pins. */
  locate?: (env: Record<string, string | undefined>) => Promise<Map<string, Install>>;
  run?: RunCommand;
  signedIn?: (
    cli: NativeRuntime,
    binary: string,
    env: Record<string, string | undefined>,
  ) => Promise<boolean>;
  pinned?: Readonly<Record<string, string>>;
  /** Whether a binary is Meta's Muse Code launcher (default: reads it). */
  isMuseLauncher?: (binary: string) => Promise<boolean>;
}

export const agentCliReportPath = (configDir: string) => join(configDir, 'agent-clis.json');

const UPDATE_TIMEOUT_MS = 5 * 60_000;
const DETAIL_CHARS = 400;

const versionText = (install?: Install) =>
  install?.version.length ? install.version.join('.') : undefined;

const lastOutput = (output: string) => {
  const text = output.trim();
  return text.length > DETAIL_CHARS ? `…${text.slice(-DETAIL_CHARS)}` : text;
};

export const runCommand: RunCommand = async (argv, env, timeoutMs) => {
  const child = Bun.spawn(argv, { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, output: `${stdout}\n${stderr}` };
  } finally {
    clearTimeout(timer);
  }
};

/** Meta's launcher is a small shell script that installs its channel's newest release on request. */
const readsAsMuseLauncher = async (binary: string) => {
  try {
    if ((await stat(binary)).size > 1_000_000) return false;
    const text = await Bun.file(binary).text();
    return text.startsWith('#!') && text.includes('MUSE_LAUNCHER_INSTALL');
  } catch {
    return false;
  }
};

/** The environment an upgrade runs in: no competing credentials, and the CLIs' own updaters allowed. */
const upgradeEnvironment = (env: Record<string, string | undefined>) => {
  const upgrade = withoutCompetingCredentials(env);
  delete upgrade.DISABLE_AUTOUPDATER;
  delete upgrade.MUSE_NO_AUTO_UPDATE;
  return upgrade;
};

/** How a CLI at this install is upgraded, or why it is not. */
const upgradePlan = async (
  cli: string,
  install: Install,
  pinned: Readonly<Record<string, string>>,
  isMuseLauncher: (binary: string) => Promise<boolean>,
): Promise<{ argv: string[]; extraEnv?: Record<string, string> } | { skip: AgentCliResult }> => {
  const before = versionText(install);
  const base = { cli, binary: install.binary, ...(before ? { before } : {}) };
  if (inAppBundle(install.binary))
    return { skip: { ...base, outcome: 'not-updated', detail: 'its app updates it' } };
  const pin = pinned[cli];
  if (!pin) return { argv: [install.binary, 'update'] };
  if (before && compareVersions(before, pin) === 0)
    return { skip: { ...base, outcome: 'current' } };
  if (before && compareVersions(before, pin) > 0)
    return {
      skip: {
        ...base,
        outcome: 'not-updated',
        detail: `Foundry speaks ${cli} ${pin} only, and its installer cannot go back to it; install ${cli} ${pin}`,
      },
    };
  if (!(await isMuseLauncher(install.binary)))
    return { skip: { ...base, outcome: 'not-updated', detail: `install ${cli} ${pin}` } };
  return { argv: [install.binary], extraEnv: { MUSE_LAUNCHER_INSTALL: '1' } };
};

/** Cassettes that need re-recording because the installed CLI is newer than the one they were recorded on. */
const reRecordNeeded = (
  fixturesDir: string | undefined,
  installed: Record<string, string>,
): AgentCliReport['reRecord'] => {
  if (!fixturesDir) return [];
  try {
    const key = (finding: { cassette: string; problem: string }) =>
      `${finding.cassette}\n${finding.problem}`;
    const already = new Set(checkFreshness(fixturesDir).map(key));
    return Object.entries(installed).flatMap(([cli, version]) => {
      const cassettes = checkFreshness(fixturesDir, { installed: { [cli]: version } }).filter(
        (finding) => !already.has(key(finding)),
      ).length;
      return cassettes ? [{ cli, installed: version, cassettes }] : [];
    });
  } catch {
    // No policy in this release (or no cassettes): nothing to compare against.
    return [];
  }
};

/**
 * Upgrades each agent CLI where the daemon finds it (when `updates` is on), records the result in
 * `<config>/agent-clis.json` and returns it. Never throws for a CLI: a failure is reported and the
 * release boots on whatever is installed.
 */
export async function updateAgentClis(options: AgentCliUpdateOptions): Promise<AgentCliReport> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const locate =
    options.locate ?? ((environment) => ensureAgentClisOnPath(AGENT_CLIS, { ...environment }));
  const run = options.run ?? runCommand;
  const signedIn = options.signedIn ?? nativeLoginSignedIn;
  const pinned = options.pinned ?? PINNED_CLI_VERSIONS;
  const isMuseLauncher = options.isMuseLauncher ?? readsAsMuseLauncher;

  let located = await locate(env);
  const clis: AgentCliResult[] = [];
  if (options.updates) {
    let moved = false;
    for (const cli of AGENT_CLIS) {
      const install = located.get(cli);
      if (!install) {
        clis.push({ cli, outcome: 'missing' });
        continue;
      }
      const plan = await upgradePlan(cli, install, pinned, isMuseLauncher);
      if ('skip' in plan) {
        clis.push(plan.skip);
        continue;
      }
      const before = versionText(install);
      let result: { exitCode: number; output: string };
      try {
        result = await run(
          plan.argv,
          { ...upgradeEnvironment(env), ...plan.extraEnv },
          UPDATE_TIMEOUT_MS,
        );
      } catch (error) {
        result = { exitCode: -1, output: String(error) };
      }
      moved = true;
      const after = versionText((await locate(env)).get(cli));
      const pin = pinned[cli];
      const entry: AgentCliResult = {
        cli,
        binary: install.binary,
        ...(before ? { before } : {}),
        ...(after ? { after } : {}),
        outcome: 'current',
      };
      if (result.exitCode !== 0) {
        entry.outcome = 'failed';
        entry.detail = lastOutput(result.output) || `exited ${result.exitCode}`;
      } else if (!after) {
        entry.outcome = 'failed';
        entry.detail = 'it no longer reports a version';
      } else if (pin && after !== pin) {
        entry.outcome = 'failed';
        entry.detail = `its installer put ${after} in place; Foundry speaks ${cli} ${pin} only`;
      } else if (after !== before) entry.outcome = 'updated';
      entry.signedIn = await signedIn(cli as NativeRuntime, install.binary, env).catch(() => false);
      clis.push(entry);
    }
    if (moved) located = await locate(env);
  }

  const installed = Object.fromEntries(
    [...located].flatMap(([cli, install]) => {
      const version = versionText(install);
      return version ? [[cli, version]] : [];
    }),
  );
  const report: AgentCliReport = {
    checkedAt: new Date().toISOString(),
    updates: options.updates,
    clis,
    reRecord: reRecordNeeded(
      options.fixturesDir && (await Bun.file(policyPath(options.fixturesDir)).exists())
        ? options.fixturesDir
        : undefined,
      installed,
    ),
  };
  for (const entry of clis) log(describeAgentCli(entry));
  for (const stale of report.reRecord)
    log(
      `${stale.cassettes} cassette(s) were recorded on an older ${stale.cli} than ${stale.installed}; re-record with bun run test:live`,
    );
  await Bun.write(agentCliReportPath(options.configDir), JSON.stringify(report, null, 2));
  return report;
}

/** One line per CLI for the daemon log. */
export const describeAgentCli = (entry: AgentCliResult): string => {
  const versions =
    entry.before && entry.after && entry.before !== entry.after
      ? `${entry.before} → ${entry.after}`
      : (entry.after ?? entry.before ?? '');
  const login = entry.signedIn === false ? '; not signed in' : entry.signedIn ? '; signed in' : '';
  const detail = entry.detail ? ` (${entry.detail})` : '';
  return `${entry.cli} ${entry.outcome}${versions ? ` ${versions}` : ''}${detail}${login}`;
};

/** The last report, for `/api/daemon/update`; undefined before the first daemon start writes one. */
export async function readAgentCliReport(configDir: string): Promise<AgentCliReport | undefined> {
  try {
    return (await Bun.file(agentCliReportPath(configDir)).json()) as AgentCliReport;
  } catch {
    return undefined;
  }
}
