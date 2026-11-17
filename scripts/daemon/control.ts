#!/usr/bin/env bun
/**
 * @atlas
 * @kind entrypoint
 * @partOf feature:daemon
 */
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
/**
 * Daemon lifecycle — install, start, stop, status, logs, uninstall.
 *
 *   bun run daemon:install    write the LaunchAgent and start it
 *   bun run daemon:start      bun run daemon:stop      bun run daemon:status
 *   bun run daemon:logs       bun run daemon:uninstall
 */
import { $ } from 'bun';
import {
  daemonDomain,
  daemonPlistPath,
  daemonTarget,
  installedDaemon,
  supervised,
} from '../../packages/foundry/src/client/daemon';
import { clearHold, readHold, writeHold } from '../../packages/foundry/src/daemon/boot-record';
import { installDaemon } from '../../packages/foundry/src/daemon/install';

const repoRoot = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const home = homedir();
// The installed daemon's own checkout, not this one: run from a worktree, a hold written here would
// never reach the supervisor launchd runs.
const installed = () => installedDaemon(home);
const installedConfigDir = () => {
  const daemon = installed();
  return `${daemon?.readable ? daemon.workingDirectory : repoRoot}/.foundry`;
};
const plistPath = daemonPlistPath(home);
const target = daemonTarget();
const domain = daemonDomain();

const ok = (message: string) => console.log(`✓ ${message}`);
const info = (message: string) => console.log(`  ${message}`);

const isLoaded = async () => {
  try {
    await $`launchctl print ${target}`.quiet();
    return true;
  } catch {
    return false;
  }
};

const install = async () => {
  const port = Number.parseInt(process.env.VIEWER_PORT ?? '4500', 10);
  try {
    const { logDir } = await installDaemon({ workingDirectory: repoRoot, port, log: info });
    ok(`daemon installed and running — http://localhost:${port}`);
    info(`logs: ${logDir}/foundry.out.log`);
    info(
      'auto-update is off by default; set daemon.autoUpdate to "apply" in .foundry/settings.json',
    );
  } catch (error) {
    console.error((error as Error).message);
    console.error(
      '\nRun `bun run setup` to configure a provider, then `bun run start` to check it works.',
    );
    process.exit(1);
  }
};

const uninstall = async () => {
  const configDir = installedConfigDir();
  if (await isLoaded()) await $`launchctl bootout ${target}`.nothrow();
  await rm(plistPath, { force: true });
  clearHold(configDir);
  ok('daemon stopped and LaunchAgent removed');
};

const start = async () => {
  clearHold(installedConfigDir());
  if (!(await isLoaded())) {
    await $`launchctl bootstrap ${domain} ${plistPath}`;
    ok('daemon started');
    return;
  }
  await $`launchctl kickstart -k ${target}`;
  ok('daemon restarted');
};

// Stopped is a hold, not an unload: the supervisor stays up serving the status page, whose Start
// brings Foundry back (`daemon:uninstall` removes the LaunchAgent and frees the port). A daemon not
// run by the supervisor (one `foundry-acp setup` installed) has no page, so it is unloaded as before.
const stop = async () => {
  if (!(await isLoaded())) {
    console.log('daemon: not loaded');
    return;
  }
  if (!supervised(installed())) {
    await $`launchctl bootout ${target}`.nothrow();
    ok('daemon stopped');
    return;
  }
  const configDir = installedConfigDir();
  writeHold(configDir, { reason: 'stopped', since: Date.now() });
  const kick = await $`launchctl kickstart -k ${target}`.nothrow().quiet();
  if (kick.exitCode !== 0) {
    // Nothing restarted onto the hold: leave none behind for the next natural restart to find.
    clearHold(configDir);
    console.error(`could not restart the daemon to stop it: ${kick.stderr.toString().trim()}`);
    process.exit(1);
  }
  ok(
    `daemon stopped — start it from http://localhost:${process.env.VIEWER_PORT ?? '4500'} or \`bun run daemon:start\``,
  );
};

const status = async () => {
  if (!(await isLoaded())) {
    console.log('daemon: not loaded');
    return;
  }
  const out = await $`launchctl print ${target}`.quiet().text();
  const pid = out.match(/pid = (\d+)/)?.[1];
  const lastExit = out.match(/last exit code = (\d+)/)?.[1];
  const hold = readHold(installedConfigDir());
  console.log(
    `daemon: loaded${pid ? `, running (pid ${pid})` : ', not running'}${
      hold?.reason === 'stopped'
        ? ', stopped (bun run daemon:start)'
        : hold
          ? `, held after ${hold.failures} failed boots: ${hold.error}`
          : ''
    }`,
  );
  if (lastExit)
    info(`last exit code: ${lastExit}${lastExit === '75' ? ' (restarted for update)' : ''}`);
  info(`viewer: http://localhost:${process.env.VIEWER_PORT ?? '4500'}`);
};

const commands: Record<string, () => Promise<void>> = { install, uninstall, start, stop, status };

const command = process.argv[2];
const run = command ? commands[command] : undefined;
if (!run) {
  console.error(`usage: control.ts <${Object.keys(commands).join('|')}>`);
  process.exit(1);
}
await run();
