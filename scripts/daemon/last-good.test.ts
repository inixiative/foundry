import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordBooted, restoreAfterFailedBoot } from './last-good';

const withDir = async (run: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'foundry-last-good-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('a failed boot on changed settings sets them aside and restores the settings that booted', () =>
  withDir(async (dir) => {
    await writeFile(join(dir, 'settings.json'), 'booted');
    await recordBooted(dir);
    await writeFile(join(dir, 'settings.json'), 'broken');
    const rejected = await restoreAfterFailedBoot(dir, 42);
    expect(rejected).toBe(join(dir, 'settings.rejected-42.json'));
    expect(await readFile(rejected!, 'utf8')).toBe('broken');
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe('booted');
  }));

test('nothing is restored when the failing settings are the ones that booted, or none ever booted', () =>
  withDir(async (dir) => {
    await writeFile(join(dir, 'settings.json'), 'same');
    expect(await restoreAfterFailedBoot(dir)).toBeUndefined();
    await recordBooted(dir);
    expect(await restoreAfterFailedBoot(dir)).toBeUndefined();
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe('same');
  }));
