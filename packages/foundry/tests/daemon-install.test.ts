import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonPlistPath } from '../src/client/daemon';
import { installedDaemon } from '../src/daemon/install';
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
