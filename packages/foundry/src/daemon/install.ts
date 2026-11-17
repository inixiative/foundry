/**
 * @atlas
 * @kind service
 * @partOf feature:daemon
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { daemonDomain, daemonPlistPath, daemonTarget } from '../client/daemon';
import { installLocations, resolveDaemonPath } from './agent-clis';
import { clearHold } from './boot-record';
import { buildPlist, DAEMON_LOG_DIR } from './plist';
import { checkReadiness } from './ready';

export interface DaemonInstallOptions {
  /** A Foundry checkout, or an installed Foundry's home; its `.foundry/` holds the settings. */
  workingDirectory: string;
  /** Default: the checkout's supervisor. */
  program?: string[];
  port: number;
  log?: (message: string) => void;
}

export const daemonLoaded = async () =>
  (await $`launchctl print ${daemonTarget()}`.quiet().nothrow()).exitCode === 0;

/**
 * Write the daemon's LaunchAgent and (re)start it. Refuses a configuration that can't start, and
 * an agent CLI that won't launch under the LaunchAgent's PATH: a daemon that restarts forever is
 * worse than none.
 */
export async function installDaemon(options: DaemonInstallOptions) {
  if (process.platform !== 'darwin')
    throw Error('The Foundry daemon is a launchd agent: macOS only for now.');
  const log = options.log ?? (() => {});
  const gate = await checkReadiness(join(options.workingDirectory, '.foundry'));
  if (!gate.ready)
    throw Error(
      [
        'Foundry is not configured, so the daemon would restart into a runtime that cannot start.',
        ...gate.errors.map((error) => `  ✗ ${error}`),
      ].join('\n'),
    );
  for (const warning of gate.warnings) log(`! ${warning}`);
  const home = homedir();
  const bunPath = (await $`which bun`.quiet().nothrow().text()).trim() || process.execPath;
  await mkdir(DAEMON_LOG_DIR, { recursive: true });
  await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  const { pathEntries, resolved, missing } = await resolveDaemonPath(bunPath, home);
  if (missing.length) {
    const lines = [
      `No working ${missing.join(' or ')} was found for the daemon's environment; every agent CLI must launch under the LaunchAgent's PATH.`,
    ];
    for (const cli of missing)
      lines.push(
        `  ✗ ${cli}: tried ${(await installLocations(cli, home)).join(', ') || 'no install found'}`,
      );
    throw Error(lines.join('\n'));
  }
  for (const [cli, install] of resolved)
    log(`${cli}: ${install.binary} (${install.version.join('.')})`);
  const plistPath = daemonPlistPath(home);
  await writeFile(
    plistPath,
    buildPlist({
      workingDirectory: options.workingDirectory,
      ...(options.program ? { program: options.program } : {}),
      bunPath,
      logDir: DAEMON_LOG_DIR,
      port: options.port,
      pathEntries,
    }),
  );
  log(`wrote ${plistPath}`);
  // An install starts Foundry: no stop or failing-boot hold from before carries over.
  clearHold(join(options.workingDirectory, '.foundry'));
  await replaceService(plistPath);
  return { plistPath, logDir: DAEMON_LOG_DIR };
}

/** One `launchctl` call: its exit code and stderr. */
export type Launchctl = (args: string[]) => Promise<{ exitCode: number; stderr: string }>;

const launchctl: Launchctl = async (args) => {
  const result = await $`launchctl ${args}`.quiet().nothrow();
  return { exitCode: result.exitCode, stderr: result.stderr.toString().trim() };
};

/**
 * Boot out the loaded daemon and bootstrap `plistPath` in its place. `bootout` returns while the old
 * service is still tearing down, and a bootstrap in that window fails (exit 5, "Input/output error"),
 * so this waits until `launchctl print` no longer finds the service, up to `timeoutMs`.
 */
export async function replaceService(
  plistPath: string,
  {
    run = launchctl,
    target = daemonTarget(),
    domain = daemonDomain(),
    timeoutMs = 15_000,
    pollMs = 100,
  }: {
    run?: Launchctl;
    target?: string;
    domain?: string;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<void> {
  const loaded = async () => (await run(['print', target])).exitCode === 0;
  if (await loaded()) {
    await run(['bootout', target]);
    const deadline = Date.now() + timeoutMs;
    while (await loaded()) {
      if (Date.now() >= deadline)
        throw Error(
          `The old daemon (${target}) was still loaded ${timeoutMs / 1000}s after bootout; nothing was started. Run the install again once \`launchctl print ${target}\` finds nothing.`,
        );
      await Bun.sleep(pollMs);
    }
  }
  const bootstrap = await run(['bootstrap', domain, plistPath]);
  if (bootstrap.exitCode !== 0)
    throw Error(
      `launchctl bootstrap ${domain} ${plistPath} failed (exit ${bootstrap.exitCode})${bootstrap.stderr ? `: ${bootstrap.stderr}` : ''}`,
    );
}
