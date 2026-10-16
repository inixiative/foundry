import { afterAll, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAgentClisOnPath, newestInstall } from '../../packages/foundry/src/daemon/agent-clis';

const home = await mkdtemp(join(tmpdir(), 'foundry-agent-clis-'));
afterAll(() => rm(home, { recursive: true, force: true }));

const install = async (relative: string, script: string) => {
  const binary = join(home, relative);
  await mkdir(join(binary, '..'), { recursive: true });
  await writeFile(binary, `#!/bin/sh\n${script}\n`);
  await chmod(binary, 0o755);
  return binary;
};

test('picks the newest working install across install methods, comparing versions numerically', async () => {
  await install('.local/bin/fakecli', 'echo "1.9.0 (Fake)"');
  const bun = await install('.bun/bin/fakecli', 'echo "fakecli 1.10.0"');
  await install('.nvm/versions/node/v9.0.0/bin/fakecli', 'exit 1');
  const chosen = await newestInstall('fakecli', home, (directory) => [
    directory,
    '/usr/bin',
    '/bin',
  ]);
  expect(chosen).toEqual({ binary: bun, version: [1, 10, 0] });
});

test('skips installs that cannot launch under the daemon PATH', async () => {
  const native = await install('.local/bin/needsnode', 'echo "2.0.0"');
  await install('.bun/bin/needsnode', 'command -v fakenode >/dev/null || exit 127\necho "3.0.0"');
  const chosen = await newestInstall('needsnode', home, (directory) => [
    directory,
    '/usr/bin',
    '/bin',
  ]);
  expect(chosen?.binary).toBe(native);
});

test('finds the codex CLI inside the Codex desktop app, with no symlink on PATH', async () => {
  const bundled = await install(
    'Applications/Codex.app/Contents/Resources/codex',
    'echo "codex-cli 999.0.0"',
  );
  const chosen = await newestInstall('codex', home, (directory) => [directory, '/usr/bin', '/bin']);
  expect(chosen).toEqual({ binary: bundled, version: [999, 0, 0] });
});

test('finds the Claude Code the Claude desktop app manages under Application Support', async () => {
  const managed = await install(
    'Library/Application Support/Claude/claude-code/999.1.0/claude.app/Contents/MacOS/claude',
    'echo "999.1.0 (Claude Code)"',
  );
  const chosen = await newestInstall('claude', home, (directory) => [
    directory,
    '/usr/bin',
    '/bin',
  ]);
  expect(chosen).toEqual({ binary: managed, version: [999, 1, 0] });
});

test('on a version tie a standalone install beats the app bundle copy', async () => {
  await install('Applications/Codex.app/Contents/Resources/codex', 'echo "codex-cli 999.2.0"');
  const standalone = await install('.local/bin/codex', 'echo "codex-cli 999.2.0"');
  // The bundle is first on PATH, as cmux's claude wrapper is in a cmux terminal.
  const path = process.env.PATH;
  process.env.PATH = `${join(home, 'Applications/Codex.app/Contents/Resources')}:/usr/bin:/bin`;
  try {
    const chosen = await newestInstall('codex', home, (directory) => [
      directory,
      '/usr/bin',
      '/bin',
    ]);
    expect(chosen?.binary).toBe(standalone);
  } finally {
    process.env.PATH = path;
  }
});

test('a CLI found off PATH joins the PATH after the existing entries; one on PATH is left alone', async () => {
  const offPath = await install('.bun/bin/offpathcli', 'echo "4.2.0"');
  const env = { PATH: '/usr/bin:/bin', HOME: home };
  const resolved = await ensureAgentClisOnPath(['offpathcli'], env, home);
  expect(resolved.get('offpathcli')).toEqual({ binary: offPath, version: [4, 2, 0] });
  expect(env.PATH).toBe(`/usr/bin:/bin:${join(home, '.bun/bin')}`);

  const again = await ensureAgentClisOnPath(['offpathcli'], env, home);
  expect(again.get('offpathcli')?.binary).toBe(offPath);
  expect(env.PATH).toBe(`/usr/bin:/bin:${join(home, '.bun/bin')}`);
});
