import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DEFAULT_URL } from '@inixiative/archive/remote';

const packages = join(import.meta.dir, '../..');
const repo = join(packages, '..');
/** Anything that builds a viewer, an Archive client or a daemon reaches the configured Archive. */
const reachesArchive =
  /createViewer\(|registerArchiveRoutes\(|localArchive\(|ArchiveContextSource|runArchiveSetup|inspectReadiness\(|src\/start\.ts/;

const testFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : testFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });

test('every test file, fixture or probe script that can reach an Archive imports the fake-Archive isolation', () => {
  // Probe scripts start real Foundry instances; scripts/daemon is the machine's own daemon.
  const missing = [
    ...['foundry/tests', 'acp/tests'].flatMap((dir) => testFiles(join(packages, dir))),
    ...testFiles(join(repo, 'scripts')).filter((file) => !file.includes('/scripts/daemon/')),
  ]
    .filter((file) => !/isolate-archive\.ts$|archive-isolation\.test\.ts$/.test(file))
    .filter((file) => {
      const source = readFileSync(file, 'utf8');
      return reachesArchive.test(source) && !source.includes('isolate-archive');
    })
    .map((file) => relative(repo, file));
  expect(missing).toEqual([]);
});

test('a bun test run from a package directory never points at the live Archive', async () => {
  const probeDir = mkdtempSync(join(tmpdir(), 'foundry-archive-probe-'));
  const probe = join(probeDir, 'probe.test.ts');
  writeFileSync(
    probe,
    `import { expect, test } from 'bun:test';
import { localArchiveUrl } from ${JSON.stringify(join(packages, 'foundry/src/archives/local.ts'))};
test('probe', () => {
  expect(localArchiveUrl()).not.toBe(${JSON.stringify(DEFAULT_URL)});
  expect(process.env.ARCHIVE_TOKEN).not.toBe('live-token-from-the-shell');
});
`,
  );
  try {
    for (const cwd of ['foundry', 'acp'].map((name) => join(packages, name))) {
      // A shell that exports the live Archive must still be overridden by the package preload.
      const child = Bun.spawn([process.execPath, 'test', probe], {
        cwd,
        env: {
          ...process.env,
          ARCHIVE_URL: DEFAULT_URL,
          ARCHIVE_TOKEN: 'live-token-from-the-shell',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      expect({ cwd: relative(packages, cwd), code, errors: code ? errors : '' }).toEqual({
        cwd: relative(packages, cwd),
        code: 0,
        errors: '',
      });
    }
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}, 60_000);
