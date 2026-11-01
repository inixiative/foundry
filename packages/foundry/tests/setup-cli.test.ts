import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SETUP = join(import.meta.dir, '../src/setup.ts');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** First-run `bun run setup` in a fresh repo, every answer piped in at once. */
async function setup(answers: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), 'foundry-setup-'));
  roots.push(cwd);
  writeFileSync(join(cwd, 'CLAUDE.md'), '# The repo’s own instructions\n');
  const child = Bun.spawn(['bun', SETUP], {
    cwd,
    stdin: new TextEncoder().encode(`${answers.join('\n')}\n`),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '' },
  });
  const output = await new Response(child.stdout).text();
  return { cwd, code: await child.exited, output };
}

// Foundry name, provider (default), model (default), port, Archive.
const answers = ['Scratch Foundry', '', '', '4599', 'n'];

test("piped answers each reach their question; the repo's own instruction files are never written", async () => {
  const { cwd, code, output } = await setup(answers);
  expect(code).toBe(0);
  expect(readFileSync(join(cwd, '.env.local'), 'utf8')).toContain('VIEWER_PORT=4599');
  expect(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8')).toBe('# The repo’s own instructions\n');
  for (const file of ['.cursorrules', 'CODEX.md', 'AGENTS.md', '.foundry/prompts'])
    expect(existsSync(join(cwd, file))).toBe(false);
  expect(output).not.toContain('Composed');
  const settings = JSON.parse(readFileSync(join(cwd, '.foundry/settings.json'), 'utf8'));
  const executors = Object.values(settings.agents as Record<string, { kind: string }>).filter(
    (agent) => agent.kind === 'executor',
  );
  expect(executors.length).toBeGreaterThan(0);
  for (const agent of executors) expect(agent).not.toHaveProperty('model');
  // The first answer names this Foundry: Kingdom pairing uses it, Settings → Profile edits it.
  expect(settings.installationName).toBe('Scratch Foundry');
  expect(settings.vendors.anthropic.subscription.enabled).toBe(true);
});

test('input that ends early fails with a reason instead of hanging', async () => {
  const { code } = await setup(['', '', '']);
  expect(code).toBe(1);
});
