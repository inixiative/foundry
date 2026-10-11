import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
 * Start the installed daemon through launchd without restarting one that is already running:
 * `kickstart` when its LaunchAgent is loaded, `bootstrap` when it is installed but not loaded.
 * Throws when no LaunchAgent is installed.
 */
export async function startDaemon(): Promise<'kickstarted' | 'bootstrapped'> {
  const domain = daemonDomain();
  const target = daemonTarget();
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
