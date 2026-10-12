import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ClaudeCodeSessionConfig } from '@inixiative/agent-session';
import { ContextStack, FileMemory } from '@inixiative/foundry-core';
import { buildLayers, createSourceResolver } from '../src/agents/thread-factory';
import {
  CLAUDE_HARNESS_INSTRUCTIONS_OFF,
  claudeProjectDirName,
  composeInstructionStack,
  discoverInstructionStack,
  harnessLoadsInstructions,
  type InstructionStackOptions,
} from '../src/prompts/instruction-stack';
import { nativeTextEnvironment } from '../src/providers/native-text-environment';
import {
  ClaudeCodeSessionAdapter,
  InMemoryExternalSessionStore,
} from '../src/providers/session-adapter';
import {
  defaultProjectLayers,
  defaultProjectSources,
  type FoundryConfig,
  starterConfig,
} from '../src/viewer/config';

let root: string;
let home: string;
let claudeDir: string;
let codexHome: string;
let org: string;
let repo: string;
beforeEach(() => {
  // realpath: macOS tmp is a symlink, and discovery reports the paths it walked.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'foundry-instruction-stack-')));
  home = join(root, 'home');
  claudeDir = join(home, '.claude');
  codexHome = join(home, '.codex');
  org = join(root, 'org');
  repo = join(org, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const options = (cwd: string, harness: 'claude' | 'codex' = 'claude'): InstructionStackOptions => ({
  cwd,
  harness,
  home,
  claudeConfigDir: claudeDir,
  codexHome,
  managedPath: join(root, 'managed', 'CLAUDE.md'),
});
const memoryPath = (project: string) =>
  join(claudeDir, 'projects', claudeProjectDirName(project), 'memory', 'MEMORY.md');

test('discovery walks root to cwd in Claude Code order and maps every level onto a corpus tier', async () => {
  write(join(root, 'managed', 'CLAUDE.md'), 'managed');
  write(join(claudeDir, 'CLAUDE.md'), 'global @RTK.md');
  write(join(claudeDir, 'RTK.md'), 'global import');
  write(join(claudeDir, 'rules', 'style.md'), 'global rule');
  write(join(org, 'CLAUDE.md'), 'org');
  write(join(org, '.claude', 'rules', 'org-rule.md'), 'org rule');
  write(join(repo, 'CLAUDE.md'), 'project');
  write(join(repo, '.claude', 'CLAUDE.md'), 'project dot-claude');
  write(join(repo, '.claude', 'rules', 'always.md'), '---\ndescription: x\n---\nproject rule');
  write(join(repo, '.claude', 'rules', 'scoped.md'), '---\npaths:\n  - "src/**"\n---\nscoped');
  write(join(repo, 'AGENTS.md'), 'agents');
  write(join(repo, 'CLAUDE.local.md'), 'local');
  write(join(repo, 'pkg', 'CLAUDE.md'), 'package');
  write(memoryPath(repo), Array.from({ length: 250 }, (_, i) => `memory ${i}`).join('\n'));

  const stack = await discoverInstructionStack(options(join(repo, 'pkg')));
  expect(stack.map((file) => [file.path.slice(root.length), file.level, file.tier])).toEqual([
    ['/managed/CLAUDE.md', 'managed', 'org'],
    ['/home/.claude/CLAUDE.md', 'global', 'personal_private'],
    ['/home/.claude/RTK.md', 'global', 'personal_private'],
    ['/home/.claude/rules/style.md', 'global', 'personal_private'],
    ['/org/CLAUDE.md', 'org', 'org'],
    ['/org/.claude/rules/org-rule.md', 'org', 'org'],
    ['/org/repo/CLAUDE.md', 'project', 'team'],
    ['/org/repo/.claude/CLAUDE.md', 'project', 'team'],
    ['/org/repo/.claude/rules/always.md', 'project', 'team'],
    ['/org/repo/AGENTS.md', 'project', 'team'],
    ['/org/repo/CLAUDE.local.md', 'local', 'personal_private'],
    ['/org/repo/pkg/CLAUDE.md', 'project', 'team'],
    [memoryPath(repo).slice(root.length), 'memory', 'personal_private'],
  ]);
  expect(stack.find((file) => file.path.endsWith('always.md'))!.content).toBe('project rule');
  // Claude Code loads the first 200 lines of MEMORY.md.
  expect(stack.at(-1)!.content.split('\n')).toHaveLength(200);
});

test('a Codex session gets its own global AGENTS.md (the override first) and the same project stack', async () => {
  write(join(claudeDir, 'CLAUDE.md'), 'claude global');
  write(join(codexHome, 'AGENTS.md'), 'codex global');
  write(join(repo, 'CLAUDE.md'), 'project');
  const levels = async () =>
    (await discoverInstructionStack(options(repo, 'codex'))).map((file) => file.content);
  expect(await levels()).toEqual(['codex global', 'project']);
  write(join(codexHome, 'AGENTS.override.md'), 'codex override');
  expect(await levels()).toEqual(['codex override', 'project']);
});

test("a worktree's main checkout is the same repository: project level, one shared auto memory", async () => {
  const worktree = join(repo, '.worktrees', 'feature');
  rmSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, '.git', 'worktrees', 'feature'), { recursive: true });
  writeFileSync(join(repo, '.git', 'worktrees', 'feature', 'commondir'), '../..\n');
  write(join(worktree, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'feature')}\n`);
  write(join(repo, 'CLAUDE.md'), 'main checkout');
  write(join(worktree, 'CLAUDE.md'), 'worktree');
  write(memoryPath(repo), 'shared memory');
  const stack = await discoverInstructionStack(options(worktree));
  expect(stack.map((file) => [file.content, file.level])).toEqual([
    ['main checkout', 'project'],
    ['worktree', 'project'],
    ['shared memory', 'memory'],
  ]);
});

test('personal files never reach a team audience; org reaches every audience', async () => {
  write(join(claudeDir, 'CLAUDE.md'), 'PERSONAL_GLOBAL');
  write(join(org, 'CLAUDE.md'), 'ORG_RULES');
  write(join(repo, 'CLAUDE.md'), 'TEAM_RULES');
  write(join(repo, 'CLAUDE.local.md'), 'PERSONAL_LOCAL');
  write(memoryPath(repo), 'PERSONAL_MEMORY');
  const stack = await discoverInstructionStack(options(repo));
  const personal = ['PERSONAL_GLOBAL', 'PERSONAL_LOCAL', 'PERSONAL_MEMORY'];

  const own = composeInstructionStack(stack);
  for (const text of [...personal, 'ORG_RULES', 'TEAM_RULES']) expect(own).toContain(text);
  const team = composeInstructionStack(stack, 'team');
  for (const text of personal) expect(team).not.toContain(text);
  expect(team).toContain('TEAM_RULES');
  expect(team).toContain('ORG_RULES');
  const orgOnly = composeInstructionStack(stack, 'org');
  expect(orgOnly).toContain('ORG_RULES');
  expect(orgOnly).not.toContain('TEAM_RULES');
  expect(own).toContain(`Contents of ${join(repo, 'CLAUDE.md')} (project instructions`);
});

test('with home above the repository, home files stay personal and its .claude belongs to the harness', async () => {
  // A realistic layout: ~/code/org/repo, so the walk passes through the home directory.
  const nestedOrg = join(home, 'code', 'org');
  const nestedRepo = join(nestedOrg, 'repo');
  mkdirSync(join(nestedRepo, '.git'), { recursive: true });
  write(join(home, 'CLAUDE.md'), 'HOME_FILE');
  write(join(claudeDir, 'CLAUDE.md'), 'CLAUDE_GLOBAL');
  write(join(codexHome, 'AGENTS.md'), 'CODEX_GLOBAL');
  write(join(nestedOrg, 'CLAUDE.md'), 'ORG_RULES');
  write(join(nestedRepo, 'CLAUDE.md'), 'TEAM_RULES');
  for (const harness of ['claude', 'codex'] as const) {
    const stack = await discoverInstructionStack(options(nestedRepo, harness));
    const team = composeInstructionStack(stack, 'team');
    for (const text of ['HOME_FILE', 'CLAUDE_GLOBAL', 'CODEX_GLOBAL'])
      expect(team).not.toContain(text);
    expect(team).toContain('ORG_RULES');
    const own = composeInstructionStack(stack);
    expect(own).toContain(harness === 'claude' ? 'CLAUDE_GLOBAL' : 'CODEX_GLOBAL');
    expect(own).not.toContain(harness === 'claude' ? 'CODEX_GLOBAL' : 'CLAUDE_GLOBAL');
  }
});

test('an import keeps the narrower tier: a committed file importing CLAUDE.local.md does not publish it', async () => {
  write(join(repo, 'CLAUDE.md'), 'TEAM_RULES @CLAUDE.local.md');
  write(join(repo, 'CLAUDE.local.md'), 'LOCAL_SECRET');
  const stack = await discoverInstructionStack(options(repo));
  expect(stack.find((file) => file.content === 'LOCAL_SECRET')).toMatchObject({
    level: 'local',
    tier: 'personal_private',
  });
  expect(composeInstructionStack(stack, 'team')).not.toContain('LOCAL_SECRET');
});

test('the Codex global file is left to Codex when it runs on that same CODEX_HOME', async () => {
  write(join(codexHome, 'AGENTS.md'), 'CODEX_GLOBAL');
  write(join(repo, 'CLAUDE.md'), 'TEAM_RULES');
  const stack = await discoverInstructionStack({
    ...options(repo, 'codex'),
    harnessLoadsGlobal: true,
  });
  expect(stack.map((file) => file.content)).toEqual(['TEAM_RULES']);
});

test('an unreadable rule is skipped, not fatal', async () => {
  write(join(repo, '.claude', 'rules', 'locked.md'), 'locked');
  write(join(repo, 'CLAUDE.md'), 'TEAM_RULES');
  chmodSync(join(repo, '.claude', 'rules', 'locked.md'), 0o000);
  const stack = await discoverInstructionStack(options(repo));
  expect(stack.map((file) => file.content)).toEqual(['TEAM_RULES']);
});

test('each file reaches the stack once, however many ways it is reached', async () => {
  write(join(repo, 'CLAUDE.md'), 'Claude rules @AGENTS.md @shared.md');
  write(join(repo, 'CLAUDE.local.md'), 'mine @shared.md');
  write(join(repo, 'AGENTS.md'), 'AGENTS_ONCE');
  write(join(repo, 'shared.md'), 'SHARED_ONCE');
  const composed = composeInstructionStack(await discoverInstructionStack(options(repo)));
  expect(composed.split('AGENTS_ONCE')).toHaveLength(2);
  expect(composed.split('SHARED_ONCE')).toHaveLength(2);
});

test('a project file imports inside the repository only; personal files import from anywhere', async () => {
  write(join(root, 'elsewhere', 'outside.md'), 'OUTSIDE');
  write(join(org, 'sibling.md'), 'ORG_SIBLING');
  write(join(org, 'CLAUDE.md'), '@sibling.md');
  write(join(repo, 'CLAUDE.md'), `@${join(root, 'elsewhere', 'outside.md')} @docs/inside.md`);
  write(join(repo, 'docs', 'inside.md'), 'INSIDE');
  const project = composeInstructionStack(await discoverInstructionStack(options(repo)));
  expect(project).toContain('INSIDE');
  expect(project).toContain('ORG_SIBLING');
  expect(project).not.toContain('OUTSIDE');
  write(join(claudeDir, 'CLAUDE.md'), `@${join(root, 'elsewhere', 'outside.md')}`);
  expect(composeInstructionStack(await discoverInstructionStack(options(repo)))).toContain(
    'OUTSIDE',
  );
});

test('the instructions layer composes the stack for the thread cwd it is bound to', async () => {
  write(join(repo, 'CLAUDE.md'), 'THREAD_REPO_RULES');
  const previous = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  try {
    const config = starterConfig();
    config.layers = defaultProjectLayers();
    config.sources = defaultProjectSources(repo);
    const template = new ContextStack(
      buildLayers(config, {
        sourceResolver: createSourceResolver({ memory: new FileMemory(join(root, 'memory')) }),
      }),
    );
    const stack = template.clone({ threadId: 't', cwd: join(repo, 'pkg') });
    mkdirSync(join(repo, 'pkg'));
    await stack.getLayer('instructions')!.warm();
    expect(stack.getLayer('instructions')!.content).toContain('THREAD_REPO_RULES');
    // A project thread with no worktree works in its project's directory.
    config.projects.p = { id: 'p', path: repo };
    const projectStack = new ContextStack(
      buildLayers(config, {
        sourceResolver: createSourceResolver({ memory: new FileMemory(join(root, 'memory')) }),
      }),
    ).clone({ threadId: 'u', projectId: 'p' });
    await projectStack.getLayer('instructions')!.warm();
    expect(projectStack.getLayer('instructions')!.content).toContain('THREAD_REPO_RULES');
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test('harness loading is suppressed exactly when Foundry composes the stack, unless set explicitly', () => {
  const composing = starterConfig();
  composing.layers = defaultProjectLayers();
  composing.sources = defaultProjectSources(repo);
  expect(harnessLoadsInstructions(composing)).toBe(false);

  const legacy: FoundryConfig = structuredClone(composing);
  delete legacy.sources.instructions;
  expect(harnessLoadsInstructions(legacy)).toBe(true);
  legacy.instructions = { harnessLoading: 'suppress' };
  expect(harnessLoadsInstructions(legacy)).toBe(false);

  const disabled: FoundryConfig = structuredClone(composing);
  disabled.layers.instructions!.enabled = false;
  expect(harnessLoadsInstructions(disabled)).toBe(true);

  // One project that does not compose keeps the harness loading for everyone: never neither.
  const mixed: FoundryConfig = structuredClone(composing);
  mixed.projects.p = {
    id: 'p',
    path: repo,
    layers: { instructions: { enabled: false } },
  };
  expect(harnessLoadsInstructions(mixed)).toBe(true);

  composing.instructions = { harnessLoading: 'load' };
  expect(harnessLoadsInstructions(composing)).toBe(true);
});

test('the Claude off switch reaches the native process through the subscription environment allowlist', async () => {
  const launches: Array<Record<string, string | undefined>> = [];
  const spawn: NonNullable<ClaudeCodeSessionConfig['spawn']> = (_cmd, opts) => {
    const env = nativeTextEnvironment(opts.env);
    launches.push(env);
    let exit!: (code: number) => void;
    return {
      stdin: { write() {}, flush() {}, end() {} },
      stdout: new ReadableStream<Uint8Array>({ start() {} }),
      stderr: new ReadableStream<Uint8Array>({ start() {} }),
      exited: new Promise<number>((resolve) => {
        exit = resolve;
      }),
      kill: () => exit(143),
    };
  };
  const adapter = (env?: Record<string, string | undefined>) =>
    new ClaudeCodeSessionAdapter({
      store: new InMemoryExternalSessionStore(),
      defaults: { spawn, ...(env ? { env } : {}) },
    });
  // Explicitly unset in the second case, so a shell that exports the variable cannot pass the test.
  for (const env of [
    { ...CLAUDE_HARNESS_INSTRUCTIONS_OFF },
    { CLAUDE_CODE_DISABLE_CLAUDE_MDS: undefined },
  ]) {
    const session = await adapter(env).createSession({ threadId: 'main', cwd: repo });
    await session.start();
    session.kill();
  }
  expect(launches.map((env) => env.CLAUDE_CODE_DISABLE_CLAUDE_MDS)).toEqual(['1', undefined]);
});
