/**
 * @atlas
 * @kind client
 * @partOf feature:daemon
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readHold } from '../daemon/boot-record';

/** The Foundry daemon's LaunchAgent label. */
export const DAEMON_LABEL = 'com.inixiative.foundry';

export const daemonPlistPath = (home = homedir()) =>
  join(home, 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`);
/** The user's launchd GUI domain, and the daemon's service target in it. */
export const daemonDomain = () => `gui/${process.getuid?.() ?? 501}`;
export const daemonTarget = () => `${daemonDomain()}/${DAEMON_LABEL}`;

async function launchctl(args: string[]): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(['launchctl', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: `${stdout}${stderr}`.trim() };
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

/** The installed daemon's config directory, where its release state and any hold live. */
export function installedConfigDirectory(home = homedir()): string | undefined {
  const installed = installedDaemon(home);
  return installed?.readable ? join(installed.workingDirectory, '.foundry') : undefined;
}

/** Whether the installed daemon runs under the supervisor, which serves the status page and honours holds. */
export const supervised = (installed: ReturnType<typeof installedDaemon>): boolean =>
  !!installed?.readable &&
  installed.program.some((arg) => arg.endsWith('scripts/daemon/supervisor.ts'));

/**
 * Start the installed daemon through launchd without restarting one that is already running:
 * `kickstart` when its LaunchAgent is loaded, `bootstrap` when it is installed but not loaded.
 * Throws when no LaunchAgent is installed.
 */
export async function startDaemon(): Promise<'kickstarted' | 'bootstrapped'> {
  const domain = daemonDomain();
  const target = daemonTarget();
  // A held daemon is up and serving its status page: a host never overrides the owner's stop.
  const configDirectory = installedConfigDirectory();
  const hold = configDirectory ? readHold(configDirectory) : undefined;
  const page = `http://localhost:${process.env.VIEWER_PORT ?? '4500'}`;
  if (hold?.reason === 'stopped')
    throw Error(`Foundry is stopped. Start it at ${page} or with \`bun run daemon:start\`.`);
  if (hold)
    throw Error(`Foundry can't start: ${hold.error}. See ${page}; it tries again by itself.`);
  if ((await launchctl(['print', target])).code === 0) {
    const kick = await launchctl(['kickstart', target]);
    if (kick.code !== 0) throw Error(`launchctl kickstart failed: ${kick.output.slice(0, 200)}`);
    return 'kickstarted';
  }
  const plist = daemonPlistPath();
  if (!existsSync(plist))
    throw Error(
      'The Foundry daemon is not installed. Run `bun run daemon:install` in the Foundry checkout.',
    );
  const boot = await launchctl(['bootstrap', domain, plist]);
  if (boot.code !== 0) throw Error(`launchctl bootstrap failed: ${boot.output.slice(0, 200)}`);
  return 'bootstrapped';
}
