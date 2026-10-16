import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonPlistPath } from '../src/client/daemon';
import { installedDaemon, type Launchctl, replaceService } from '../src/daemon/install';
import { buildPlist } from '../src/daemon/plist';

test.skipIf(process.platform !== 'darwin')(
  "reads the installed daemon, escapes included; an unreadable plist is someone else's",
  () => {
    const home = mkdtempSync(join(tmpdir(), 'foundry-daemon-'));
    try {
      expect(installedDaemon(home)).toBeUndefined();
      mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
      writeFileSync(
        daemonPlistPath(home),
        buildPlist({
          workingDirectory: '/a & b/foundry',
          program: ['/bin/bun', 'run', '/pkg/start.ts'],
          bunPath: '/bin/bun',
          logDir: '/tmp',
          port: 4500,
          pathEntries: ['/bin'],
        }),
      );
      expect(installedDaemon(home)).toMatchObject({
        readable: true,
        workingDirectory: '/a & b/foundry',
        program: ['/bin/bun', 'run', '/pkg/start.ts'],
      });
      writeFileSync(daemonPlistPath(home), 'not a plist');
      expect(installedDaemon(home)).toMatchObject({ readable: false });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

/** A fake launchctl whose service stays loaded for `lingers` prints after bootout, and refuses a bootstrap meanwhile (exit 5). */
function fakeLaunchctl(lingers: number, loadedAtStart = true) {
  const calls: string[] = [];
  let loaded = loadedAtStart,
    tearingDown = 0;
  const run: Launchctl = async ([verb]) => {
    calls.push(verb!);
    if (verb === 'print') {
      if (tearingDown > 0 && --tearingDown === 0) loaded = false;
      return { exitCode: loaded ? 0 : 113, stderr: '' };
    }
    if (verb === 'bootout') {
      tearingDown = lingers;
      if (lingers === 0) loaded = false;
      return { exitCode: 0, stderr: '' };
    }
    if (loaded) return { exitCode: 5, stderr: 'Bootstrap failed: 5: Input/output error' };
    loaded = true;
    return { exitCode: 0, stderr: '' };
  };
  return { run, calls };
}

test('reinstall waits for the old daemon to finish tearing down before bootstrapping', async () => {
  const f = fakeLaunchctl(3);
  await replaceService('/p.plist', { run: f.run, target: 't', domain: 'd', pollMs: 1 });
  expect(f.calls).toEqual(['print', 'bootout', 'print', 'print', 'print', 'bootstrap']);
});

test('a first install bootstraps at once; a daemon that never unloads fails without bootstrapping', async () => {
  const fresh = fakeLaunchctl(0, false);
  await replaceService('/p.plist', { run: fresh.run, target: 't', domain: 'd' });
  expect(fresh.calls).toEqual(['print', 'bootstrap']);

  const stuck = fakeLaunchctl(Number.POSITIVE_INFINITY);
  await expect(
    replaceService('/p.plist', {
      run: stuck.run,
      target: 't',
      domain: 'd',
      timeoutMs: 20,
      pollMs: 1,
    }),
  ).rejects.toThrow('still loaded');
  expect(stuck.calls).not.toContain('bootstrap');
});
