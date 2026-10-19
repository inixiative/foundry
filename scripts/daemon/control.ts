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
} from '../../packages/foundry/src/client/daemon';
import { installDaemon } from '../../packages/foundry/src/daemon/install';

const repoRoot = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const home = homedir();
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
  if (await isLoaded()) await $`launchctl bootout ${target}`.nothrow();
  await rm(plistPath, { force: true });
  ok('daemon stopped and LaunchAgent removed');
};

const start = async () => {
  if (!(await isLoaded())) {
    await $`launchctl bootstrap ${domain} ${plistPath}`;
    ok('daemon started');
    return;
  }
  await $`launchctl kickstart -k ${target}`;
  ok('daemon restarted');
};

const stop = async () => {
  await $`launchctl bootout ${target}`.nothrow();
  ok('daemon stopped');
};

const status = async () => {
  if (!(await isLoaded())) {
    console.log('daemon: not loaded');
    return;
  }
  const out = await $`launchctl print ${target}`.quiet().text();
  const pid = out.match(/pid = (\d+)/)?.[1];
  const lastExit = out.match(/last exit code = (\d+)/)?.[1];
  console.log(`daemon: loaded${pid ? `, running (pid ${pid})` : ', not running'}`);
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
