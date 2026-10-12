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

export const isolatedArchive = archive;
