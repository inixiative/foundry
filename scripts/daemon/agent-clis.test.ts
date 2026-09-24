import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newestInstall } from "./agent-clis";

const home = await mkdtemp(join(tmpdir(), "foundry-agent-clis-"));
afterAll(() => rm(home, { recursive: true, force: true }));

const install = async (relative: string, script: string) => {
  const binary = join(home, relative);
  await mkdir(join(binary, ".."), { recursive: true });
  await writeFile(binary, `#!/bin/sh\n${script}\n`);
  await chmod(binary, 0o755);
  return binary;
};

test("picks the newest working install across install methods, comparing versions numerically", async () => {
  await install(".local/bin/fakecli", 'echo "1.9.0 (Fake)"');
  const bun = await install(".bun/bin/fakecli", 'echo "fakecli 1.10.0"');
  await install(".nvm/versions/node/v9.0.0/bin/fakecli", "exit 1");
  const chosen = await newestInstall("fakecli", home, directory => [directory, "/usr/bin", "/bin"]);
  expect(chosen).toEqual({ binary: bun, version: [1, 10, 0] });
});

test("skips installs that cannot launch under the daemon PATH", async () => {
  const native = await install(".local/bin/needsnode", 'echo "2.0.0"');
  await install(".bun/bin/needsnode", 'command -v fakenode >/dev/null || exit 127\necho "3.0.0"');
  const chosen = await newestInstall("needsnode", home, directory => [directory, "/usr/bin", "/bin"]);
  expect(chosen?.binary).toBe(native);
});
