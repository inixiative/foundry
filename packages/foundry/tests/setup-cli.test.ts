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

// provider (default), model (default), port, project name, description, Claude/Cursor/Codex, Archive.
const answers = (claude: string, cursor: string, codex: string) => [
  '',
  '',
  '4599',
  'scratch',
  'A scratch repo',
  claude,
  cursor,
  codex,
  'n',
];

test('piped answers each reach their question; answering no writes nothing for that runtime', async () => {
  const { cwd, code, output } = await setup(answers('n', 'n', 'n'));
  expect(code).toBe(0);
  expect(readFileSync(join(cwd, '.env.local'), 'utf8')).toContain('VIEWER_PORT=4599');
  expect(readFileSync(join(cwd, '.foundry/prompts/common.md'), 'utf8')).toContain('# scratch');
  expect(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8')).toBe('# The repo’s own instructions\n');
  expect(existsSync(join(cwd, '.cursorrules'))).toBe(false);
  expect(existsSync(join(cwd, 'CODEX.md'))).toBe(false);
  expect(output).not.toContain('Composed');
});

test('a chosen runtime is composed alone, and executors inherit the default model', async () => {
  const { cwd, code } = await setup(answers('n', 'y', 'n'));
  expect(code).toBe(0);
  expect(existsSync(join(cwd, '.cursorrules'))).toBe(true);
  expect(existsSync(join(cwd, 'CODEX.md'))).toBe(false);
  expect(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8')).toBe('# The repo’s own instructions\n');
  const settings = JSON.parse(readFileSync(join(cwd, '.foundry/settings.json'), 'utf8'));
  const executors = Object.values(settings.agents as Record<string, { kind: string }>).filter(
    (agent) => agent.kind === 'executor',
  );
  expect(executors.length).toBeGreaterThan(0);
  for (const agent of executors) expect(agent).not.toHaveProperty('model');
});

test('input that ends early fails with a reason instead of hanging', async () => {
  const { code } = await setup(['', '']);
  expect(code).toBe(1);
});
