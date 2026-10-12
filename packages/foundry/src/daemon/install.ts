import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { daemonDomain, daemonPlistPath, daemonTarget } from '../client/daemon';
import { installLocations, resolveDaemonPath } from './agent-clis';
import { buildPlist } from './plist';
import { checkReadiness } from './ready';

export const DAEMON_LOG_DIR = join(homedir(), 'Library', 'Logs', 'foundry');

export interface DaemonInstallOptions {
  /** A Foundry checkout, or an installed Foundry's home; its `.foundry/` holds the settings. */
  workingDirectory: string;
  /** Default: the checkout's supervisor. */
  program?: string[];
  port: number;
  log?: (message: string) => void;
}

/**
 * The installed LaunchAgent's working directory and program (read with `plutil`), or `readable: false`
 * when one exists that can't be read: callers treat it as someone else's daemon.
 */
export function installedDaemon(home = homedir()) {
  const plistPath = daemonPlistPath(home);
  if (!existsSync(plistPath)) return undefined;
  const read = Bun.spawnSync(['plutil', '-convert', 'json', '-o', '-', plistPath], {
    stderr: 'ignore',
  });
  try {
    const plist = JSON.parse(read.stdout.toString()) as {
      WorkingDirectory?: unknown;
      ProgramArguments?: unknown;
    };
    if (read.exitCode !== 0 || typeof plist.WorkingDirectory !== 'string') throw Error();
    return {
      plistPath,
      readable: true as const,
      workingDirectory: plist.WorkingDirectory,
      program: Array.isArray(plist.ProgramArguments)
        ? plist.ProgramArguments.filter((item): item is string => typeof item === 'string')
        : [],
    };
  } catch {
    return { plistPath, readable: false as const };
  }
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
  if (await daemonLoaded()) await $`launchctl bootout ${daemonTarget()}`.quiet().nothrow();
  await $`launchctl bootstrap ${daemonDomain()} ${plistPath}`.quiet();
  return { plistPath, logDir: DAEMON_LOG_DIR };
}
