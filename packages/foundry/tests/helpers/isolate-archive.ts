import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUN_ENV, stampRunDirectory } from '@inixiative/archive/exemption';
import { startFakeArchive } from './fake-archive';

/**
 * Points this test process's Archive client (`ARCHIVE_URL` / `ARCHIVE_TOKEN`) at one in-memory
 * fake, whatever the cwd and whatever the shell exported, so no test reaches the machine's live
 * Archive. Imported by the root and per-package preloads and by every test file or fixture that
 * builds a viewer or an Archive client (`archive-isolation.test.ts` enforces that).
 */
const key = Symbol.for('foundry.tests.fakeArchive');
const holder = globalThis as { [key]?: ReturnType<typeof startFakeArchive> };
holder[key] ??= startFakeArchive();
const archive = holder[key];
process.env.ARCHIVE_URL = archive.url;
process.env.ARCHIVE_TOKEN = archive.token;
// Everything a test writes or runs is stamped a test run for Archive: snapshots by ARCHIVE_RUN,
// native sessions by the stamped temp directory their workspaces are made in.
if (!process.env[RUN_ENV]) {
  process.env[RUN_ENV] = 'test';
  const stamped = mkdtempSync(join(tmpdir(), 'foundry-tests-'));
  stampRunDirectory(stamped, 'test');
  process.env.TMPDIR = stamped;
}

export const isolatedArchive = archive;
