import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ClaudeCodeSessionConfig } from '@inixiative/agent-session';
import { ContextStack, FileMemory } from '@inixiative/foundry-core';
import type { CorpusTier } from '../src/agents/corpus-compiler';
import { buildLayers, createSourceResolver } from '../src/agents/thread-factory';
import {
  type CompositionSettings,
  DEFAULT_INSTRUCTION_LADDER,
  resolveInstructionLadder,
} from '../src/prompts/instruction-settings';
import {
  CLAUDE_HARNESS_INSTRUCTIONS_OFF,
  claudeProjectDirName,
  composeRoleView,
  discoverInstructionStack,
  harnessLoadsInstructions,
  type InstructionStackOptions,
  instructionStackReport,
  instructionStackSource,
  roleViewChanged,
} from '../src/prompts/instruction-stack';
import { nativeTextEnvironment } from '../src/providers/native-text-environment';
import {
  ClaudeCodeSessionAdapter,
  InMemoryExternalSessionStore,
} from '../src/providers/session-adapter';
import { type FoundryConfig, starterConfig, validateConfig } from '../src/viewer/config';

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
/** The main thread's instructions slot for `opts`, as one audience sees it. */
const compose = async (
  opts: InstructionStackOptions,
  audience?: CorpusTier,
  dedupe?: { content?: boolean; sections?: boolean },
) =>
  (
    await composeRoleView({
      ...opts,
      role: 'main',
      picks: audience ? { audience } : {},
      ...(dedupe ? { dedupe } : {}),
    })
  ).slots.instructions;
/** Opt in to Foundry composing the instruction files: an `instructions` layer over its source. */
const composeInstructions = (config: FoundryConfig) => {
  config.layers.instructions = {
    id: 'instructions',
    prompt: 'Standing instructions.',
    sourceIds: ['instructions'],
    staleness: 60_000,
    enabled: true,
  };
  config.sources.instructions = {
    id: 'instructions',
    type: 'instructions',
    label: 'Instruction files',
    uri: '',
    enabled: true,
  };
  return config;
};
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
  expect(stack.files.map((file) => [file.path.slice(root.length), file.level, file.tier])).toEqual([
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
  expect(stack.files.find((file) => file.path.endsWith('always.md'))!.content).toBe('project rule');
  // Claude Code loads the first 200 lines of MEMORY.md.
  expect(stack.files.at(-1)!.content.split('\n')).toHaveLength(200);
});

test('a Codex session gets its own global AGENTS.md (the override first) and the same project stack', async () => {
  write(join(claudeDir, 'CLAUDE.md'), 'claude global');
  write(join(codexHome, 'AGENTS.md'), 'codex global');
  write(join(repo, 'CLAUDE.md'), 'project');
  const levels = async () =>
    (await discoverInstructionStack(options(repo, 'codex'))).files.map((file) => file.content);
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
  expect(stack.files.map((file) => [file.content, file.level])).toEqual([
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
  const personal = ['PERSONAL_GLOBAL', 'PERSONAL_LOCAL', 'PERSONAL_MEMORY'];

  const own = (await compose(options(repo))).text;
  for (const text of [...personal, 'ORG_RULES', 'TEAM_RULES']) expect(own).toContain(text);
  const team = (await compose(options(repo), 'team')).text;
  for (const text of personal) expect(team).not.toContain(text);
  expect(team).toContain('TEAM_RULES');
  expect(team).toContain('ORG_RULES');
  const orgOnly = (await compose(options(repo), 'org')).text;
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
    const team = (await compose(options(nestedRepo, harness), 'team')).text;
    for (const text of ['HOME_FILE', 'CLAUDE_GLOBAL', 'CODEX_GLOBAL'])
      expect(team).not.toContain(text);
    expect(team).toContain('ORG_RULES');
    const own = (await compose(options(nestedRepo, harness))).text;
    expect(own).toContain(harness === 'claude' ? 'CLAUDE_GLOBAL' : 'CODEX_GLOBAL');
    expect(own).not.toContain(harness === 'claude' ? 'CODEX_GLOBAL' : 'CLAUDE_GLOBAL');
  }
});

test('an import keeps the narrower tier: a committed file importing CLAUDE.local.md does not publish it', async () => {
  write(join(repo, 'CLAUDE.md'), 'TEAM_RULES @CLAUDE.local.md');
  write(join(repo, 'CLAUDE.local.md'), 'LOCAL_SECRET');
  const stack = await discoverInstructionStack(options(repo));
  expect(stack.files.find((file) => file.content === 'LOCAL_SECRET')).toMatchObject({
    level: 'local',
    tier: 'personal_private',
  });
  expect((await compose(options(repo), 'team')).text).not.toContain('LOCAL_SECRET');
});

test('the Codex global file is left to Codex when it runs on that same CODEX_HOME', async () => {
  write(join(codexHome, 'AGENTS.md'), 'CODEX_GLOBAL');
  write(join(repo, 'CLAUDE.md'), 'TEAM_RULES');
  const stack = await discoverInstructionStack({
    ...options(repo, 'codex'),
    harnessLoadsGlobal: true,
  });
  expect(stack.files.map((file) => file.content)).toEqual(['TEAM_RULES']);
});

test('an unreadable rule is skipped, not fatal', async () => {
  write(join(repo, '.claude', 'rules', 'locked.md'), 'locked');
  write(join(repo, 'CLAUDE.md'), 'TEAM_RULES');
  chmodSync(join(repo, '.claude', 'rules', 'locked.md'), 0o000);
  const stack = await discoverInstructionStack(options(repo));
  expect(stack.files.map((file) => file.content)).toEqual(['TEAM_RULES']);
});

test('each file reaches the stack once, however many ways it is reached', async () => {
  write(join(repo, 'CLAUDE.md'), 'Claude rules @AGENTS.md @shared.md');
  write(join(repo, 'CLAUDE.local.md'), 'mine @shared.md');
  write(join(repo, 'AGENTS.md'), 'AGENTS_ONCE');
  write(join(repo, 'shared.md'), 'SHARED_ONCE');
  const composed = (await compose(options(repo))).text;
  expect(composed.split('AGENTS_ONCE')).toHaveLength(2);
  expect(composed.split('SHARED_ONCE')).toHaveLength(2);
});

test('a project file imports inside the repository only; personal files import from anywhere', async () => {
  write(join(root, 'elsewhere', 'outside.md'), 'OUTSIDE');
  write(join(org, 'sibling.md'), 'ORG_SIBLING');
  write(join(org, 'CLAUDE.md'), '@sibling.md');
  write(join(repo, 'CLAUDE.md'), `@${join(root, 'elsewhere', 'outside.md')} @docs/inside.md`);
  write(join(repo, 'docs', 'inside.md'), 'INSIDE');
  const project = (await compose(options(repo))).text;
  expect(project).toContain('INSIDE');
  expect(project).toContain('ORG_SIBLING');
  expect(project).not.toContain('OUTSIDE');
  write(join(claudeDir, 'CLAUDE.md'), `@${join(root, 'elsewhere', 'outside.md')}`);
  expect((await compose(options(repo))).text).toContain('OUTSIDE');
});

test('the instructions layer composes the stack for the thread cwd it is bound to', async () => {
  write(join(repo, 'CLAUDE.md'), 'THREAD_REPO_RULES');
  const previous = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  try {
    const config = composeInstructions(starterConfig());
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
  const composing = composeInstructions(starterConfig());
  expect(harnessLoadsInstructions(composing)).toBe(false);

  const legacy: FoundryConfig = structuredClone(composing);
  delete legacy.sources.instructions;
  expect(harnessLoadsInstructions(legacy)).toBe(true);
  legacy.composition = { harnessLoading: 'suppress' };
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

  composing.composition = { harnessLoading: 'load' };
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

/** Aron's ladder over the default preset: org and org personal, a project and project personal. */
const aronSettings = (): CompositionSettings => ({
  nodes: {
    inixiative: {
      scope: 'org',
      personal: false,
      when: { paths: [org] },
      sources: [{ path: '{anchor}/docs/org/*.md' }],
    },
    'inixiative-personal': {
      scope: 'org',
      personal: true,
      parent: 'inixiative',
      sources: [{ path: '~/.foundry/instructions/inixiative.md' }],
    },
    app: {
      scope: 'project',
      personal: false,
      parent: 'inixiative',
      when: { projects: ['app'] },
      anchor: '{projectPath}',
      sources: [{ path: 'docs/agents/*.md' }],
    },
    'app-personal': {
      scope: 'project',
      personal: true,
      parent: 'app',
      sources: [{ path: '~/.foundry/instructions/app.md' }],
    },
  },
});

test('the default ladder is the preset when nothing is configured; nodes merge over it by id', () => {
  expect(resolveInstructionLadder(undefined)).toEqual([...DEFAULT_INSTRUCTION_LADDER]);
  expect(resolveInstructionLadder({ harnessLoading: 'load' })).toEqual([
    ...DEFAULT_INSTRUCTION_LADDER,
  ]);
  const ids = resolveInstructionLadder({
    nodes: {
      memory: { scope: 'project', personal: true, enabled: false, sources: [] },
      org: { scope: 'org', personal: false, label: 'mine', sources: [{ path: 'x.md' }] },
      extra: { scope: 'computer', personal: true, sources: [{ path: '~/x.md' }] },
    },
  });
  expect(ids.map((node) => node.id)).toEqual([
    'managed',
    'global',
    'org',
    'project',
    'local',
    'extra',
  ]);
  expect(ids.find((node) => node.id === 'org')!.label).toBe('mine');
  expect(resolveInstructionLadder({ preset: 'none', ...aronSettings() }).map((n) => n.id)).toEqual([
    'inixiative',
    'inixiative-personal',
    'app',
    'app-personal',
  ]);
});

test('instruction settings are validated: tiers, parents, cycles, sources', () => {
  const config = (composition: unknown) =>
    ({ ...starterConfig(), composition }) as unknown as FoundryConfig;
  expect(() => validateConfig(config(aronSettings()))).not.toThrow();
  const node = { scope: 'org', personal: false, sources: [{ path: 'x.md' }] };
  for (const [instructions, message] of [
    [{ nodes: { a: { ...node, parent: 'missing' } } }, 'is not a node'],
    [{ nodes: { a: { ...node, parent: 'b' }, b: { ...node, parent: 'a' } } }, 'parent cycle'],
    [{ nodes: { a: { ...node, personal: true, tier: 'team' } } }, "personal node's tier"],
    [{ nodes: { a: { ...node, tier: 'public' } } }, 'tier must be one of'],
    [{ nodes: { a: { ...node, sources: [] } } }, 'at least one source'],
    [{ nodes: { a: { ...node, sources: [{ walk: [] }] } } }, 'walk must list'],
    [{ nodes: { a: { ...node, when: { cwd: ['x'] } } } }, 'when.cwd'],
    [{ preset: 'cursor' }, 'composition.preset'],
    [{ dedupe: { lines: true } }, 'composition.dedupe'],
    [{ nodes: { a: { ...node, when: { slots: ['thread'] } } } }, 'when.slots names thread'],
    [{ roles: { main: { instructions: { exclude: ['nope'] } } } }, 'unknown nodes: nope'],
    [{ roles: { main: { budget: 0 } } }, 'budget must be a positive'],
    [{ roles: { main: { audience: 'public' } } }, 'audience must be one of'],
    [{ roles: { main: { slots: {} } } }, 'unknown field slots'],
  ] as const)
    expect(() => validateConfig(config(instructions))).toThrow(message);
  expect(() =>
    validateConfig({ ...starterConfig(), instructions: {} } as unknown as FoundryConfig),
  ).toThrow('is now "composition"');
});

test("a registered ladder composes every applicable level, in order, for the thread's location", async () => {
  const app = join(org, 'app');
  mkdirSync(join(app, '.git'), { recursive: true });
  write(join(org, 'CLAUDE.md'), 'ORG_CLAUDE');
  write(join(org, 'docs', 'org', 'policy.md'), 'ORG_POLICY');
  write(join(home, '.foundry', 'instructions', 'inixiative.md'), 'ORG_PERSONAL');
  write(join(app, 'CLAUDE.md'), 'APP_CLAUDE');
  write(join(app, 'docs', 'agents', 'style.md'), 'APP_STYLE');
  write(join(app, 'CLAUDE.local.md'), 'APP_LOCAL');
  write(join(home, '.foundry', 'instructions', 'app.md'), 'APP_PERSONAL');
  write(join(claudeDir, 'CLAUDE.md'), 'COMPUTER_PERSONAL');
  const ladder = resolveInstructionLadder(aronSettings());
  const discover = (cwd: string, projectId?: string) =>
    discoverInstructionStack({
      ...options(cwd),
      ladder,
      ...(projectId ? { projectId, projectPath: app } : {}),
    });

  const project = await discover(app, 'app');
  expect(project.files.map((file) => [file.content, file.level, file.tier])).toEqual([
    ['COMPUTER_PERSONAL', 'global', 'personal_private'],
    ['ORG_CLAUDE', 'org', 'org'],
    ['ORG_POLICY', 'inixiative', 'org'],
    ['ORG_PERSONAL', 'inixiative-personal', 'personal_private'],
    ['APP_CLAUDE', 'project', 'team'],
    ['APP_STYLE', 'app', 'team'],
    ['APP_LOCAL', 'local', 'personal_private'],
    ['APP_PERSONAL', 'app-personal', 'personal_private'],
  ]);
  // Org only: no project thread, so neither project node applies.
  const orgOnly = await discover(org);
  expect(orgOnly.files.map((file) => file.content)).toEqual([
    'COMPUTER_PERSONAL',
    'ORG_CLAUDE',
    'ORG_POLICY',
    'ORG_PERSONAL',
  ]);
  // A team audience never sees a personal level.
  const appOptions = { ...options(app), ladder, projectId: 'app', projectPath: app };
  const team = (await compose(appOptions, 'team')).text;
  for (const text of ['COMPUTER_PERSONAL', 'ORG_PERSONAL', 'APP_LOCAL', 'APP_PERSONAL'])
    expect(team).not.toContain(text);
  for (const text of ['ORG_CLAUDE', 'ORG_POLICY', 'APP_CLAUDE', 'APP_STYLE'])
    expect(team).toContain(text);
  expect((await compose(appOptions)).text).toContain(
    `Contents of ${join(app, 'docs', 'agents', 'style.md')} (project instructions (app))`,
  );
});

test('dedupe runs after the audience filter: a personal copy never hides the shared one from a team', async () => {
  const section = '## Merging\n\nMerge once green.';
  write(join(org, 'CLAUDE.md'), `# Rules\n\n${section}\n\n## Ports\n\nFrom the registry.`);
  write(join(repo, 'CLAUDE.local.md'), `# Rules\n\n${section}`);
  const own = await compose(options(repo));
  expect(own.text.split('Merge once green.')).toHaveLength(2);
  expect(own.duplicates).toEqual([
    {
      kind: 'section',
      path: join(org, 'CLAUDE.md'),
      node: 'org',
      heading: 'Merging',
      chars: section.length + 1, // the section runs to the next heading
      keptPath: join(repo, 'CLAUDE.local.md'),
      keptNode: 'local',
    },
  ]);
  const team = await compose(options(repo), 'team');
  expect(team.text).toContain('Merge once green.');
  expect(team.duplicates).toEqual([]);
});

test('a worktree and its main checkout with the same CLAUDE.md compose it once, from the worktree', async () => {
  const worktree = join(repo, '.worktrees', 'feature');
  rmSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, '.git', 'worktrees', 'feature'), { recursive: true });
  writeFileSync(join(repo, '.git', 'worktrees', 'feature', 'commondir'), '../..\n');
  write(join(worktree, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'feature')}\n`);
  write(join(repo, 'CLAUDE.md'), '# Foundry\n\nSAME_RULES');
  write(join(worktree, 'CLAUDE.md'), '# Foundry\n\nSAME_RULES\n');
  const composed = await compose(options(worktree));
  expect(composed.text.split('SAME_RULES')).toHaveLength(2);
  expect(composed.files.map((file) => file.path)).toEqual([join(worktree, 'CLAUDE.md')]);
  expect(composed.duplicates.map((d) => [d.kind, d.path])).toEqual([
    ['content', join(repo, 'CLAUDE.md')],
  ]);
  // Dedupe off: today's discovery, both copies.
  const raw = await compose(options(worktree), undefined, { content: false, sections: false });
  expect(raw.text.split('SAME_RULES')).toHaveLength(3);
});

test('the source reports what it composed and what it deduped, for the Selection panel', async () => {
  write(join(repo, 'CLAUDE.md'), 'TEAM @AGENTS.md');
  write(join(repo, 'AGENTS.md'), 'AGENTS');
  write(join(repo, 'CLAUDE.local.md'), 'MINE');
  const previous = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  try {
    const source = instructionStackSource('instructions', {
      harness: 'claude',
      picks: { audience: 'team' },
      managedPath: join(root, 'managed', 'CLAUDE.md'),
    }).bind!({ threadId: 't', cwd: repo });
    const text = await source.load();
    expect(text).toContain('AGENTS');
    const report = source.report!()!;
    expect(report.subject).toBe('instructions');
    expect(report.selected.map((s) => [s.id, s.kind])).toEqual([
      [join(repo, 'CLAUDE.md'), 'project'],
      [join(repo, 'AGENTS.md'), 'project'],
    ]);
    expect(report.omitted).toEqual([
      { id: join(repo, 'CLAUDE.local.md'), reason: 'not visible to team', chars: 4, kind: 'local' },
      {
        id: join(repo, 'AGENTS.md'),
        reason: 'same file reached again',
        chars: 0,
        kind: 'project',
        duplicateOf: `${join(repo, 'AGENTS.md')} (project)`,
      },
    ]);
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test('an identified dispatch is not refused because the instructions layer reports its composition', async () => {
  const { ThreadFactory, buildAgents } = await import('../src/agents/thread-factory');
  const { ThreadRuntimeManager } = await import('../src/agents/thread-runtime');
  const { ToolRegistry } = await import('@inixiative/foundry-core');
  write(join(repo, 'CLAUDE.md'), '# P\n\nproject rule\n');
  const agent = {
    provider: 'mock',
    model: 'mock',
    temperature: 0,
    maxTokens: 256,
    visibleLayers: [],
    peers: [],
    maxDepth: 1,
    enabled: true,
  };
  const config = {
    defaults: { provider: 'mock', model: 'mock' },
    vendors: {},
    agents: { worker: { ...agent, id: 'worker', kind: 'executor', prompt: 'Execute' } },
    layers: {
      instructions: {
        id: 'instructions',
        prompt: 'Standing',
        sourceIds: ['instructions'],
        staleness: 60_000,
        enabled: true,
      },
    },
    sources: {
      instructions: {
        id: 'instructions',
        type: 'instructions',
        label: 'I',
        uri: '',
        enabled: true,
      },
    },
    projects: { P: { id: 'P', path: repo, enabled: true } },
  } as unknown as FoundryConfig;
  const provider = {
    id: 'mock',
    complete: async () => ({ model: 'mock', content: 'ok' }),
  } as unknown as Parameters<typeof buildAgents>[2]['provider'];
  const template = new ContextStack(
    buildLayers(config, {
      sourceResolver: createSourceResolver({ memory: new FileMemory(join(root, 'memory')) }),
    }),
  );
  await template.warmAll();
  const agents = buildAgents(config, template, { provider, tools: new ToolRegistry() });
  const runtime = new ThreadRuntimeManager({
    config,
    domains: [],
    log: () => {},
    warn: () => {},
    llm: provider,
    signalSinks: [],
  } as unknown as ConstructorParameters<typeof ThreadRuntimeManager>[0]);
  const factory = new ThreadFactory({ stack: template, agents, runtime });
  const thread = factory.create('work', { projectId: 'P', cwd: repo });
  try {
    for (const messageId of ['first', 'second'])
      await thread.dispatch('worker', 'hello', undefined, { messageId });
    expect(thread.stack.getLayer('instructions')!.selection?.sources[0]?.report.subject).toBe(
      'instructions',
    );
  } finally {
    thread.dispose();
    runtime.disposeAll();
  }
});

test('glob characters in a directory name are literal; only the configured pattern globs', async () => {
  const route = join(repo, 'app', '[slug]');
  write(join(route, 'CLAUDE.md'), 'ROUTE');
  write(join(repo, 'app', 's', 'CLAUDE.md'), 'SIBLING');
  const contents = (await discoverInstructionStack(options(route))).files.map((f) => f.content);
  expect(contents).toEqual(['ROUTE']);
});

test("a shared node's glob never publishes a file a personal node owns", async () => {
  write(join(repo, 'sub', 'CLAUDE.local.md'), 'SECRET_LOCAL');
  write(join(repo, 'sub', 'notes.md'), 'TEAM_NOTES');
  const ladder = resolveInstructionLadder({
    nodes: {
      notes: {
        scope: 'project',
        personal: false,
        when: { paths: [repo] },
        sources: [{ path: '{anchor}/sub/*.md' }],
      },
    },
  });
  const stack = await discoverInstructionStack({ ...options(repo), ladder });
  expect(stack.files.find((f) => f.content === 'SECRET_LOCAL')).toMatchObject({
    level: 'local',
    tier: 'personal_private',
  });
  const team = (await compose({ ...options(repo), ladder }, 'team')).text;
  expect(team).toContain('TEAM_NOTES');
  expect(team).not.toContain('SECRET_LOCAL');
});

test('a shared file first reached through a personal import still reaches the team', async () => {
  write(join(claudeDir, 'CLAUDE.md'), `@${join(org, 'CLAUDE.md')} @${join(repo, 'CLAUDE.md')}`);
  write(join(org, 'CLAUDE.md'), 'ORG_RULES');
  write(join(repo, 'CLAUDE.md'), 'TEAM_RULES');
  const stack = await discoverInstructionStack(options(repo));
  const team = (await compose(options(repo), 'team')).text;
  expect(team).toContain('ORG_RULES');
  expect(team).toContain('TEAM_RULES');
  expect(stack.duplicates.map((d) => d.kind)).toEqual(['path', 'path']);
});

test('fail closed: an unresolvable exclusion, anchor or symlinked secret loads nothing', async () => {
  write(join(repo, 'CLAUDE.md'), 'TEAM_RULES');
  write(join(org, 'NOTES.md'), 'ORG_NOTES');
  write(join(home, '.aws', 'credentials'), 'SECRET_AWS');
  symlinkSync(join(home, '.aws', 'credentials'), join(repo, 'NOTES.md'));
  const ladder = resolveInstructionLadder({
    preset: 'none',
    nodes: {
      wide: {
        scope: 'org',
        personal: false,
        sources: [{ walk: [{ path: 'CLAUDE.md' }], span: { outside: ['{projectPath}'] } }],
      },
      parent: {
        scope: 'org',
        personal: false,
        when: { paths: [org] },
        sources: [{ path: '{project}/NOTES.md' }],
      },
      child: {
        scope: 'project',
        personal: false,
        parent: 'parent',
        anchor: '{projectPath}',
        sources: [{ path: '{anchor}/NOTES.md' }],
      },
    },
  });
  const stack = await discoverInstructionStack({ ...options(repo), ladder });
  expect(stack.files).toEqual([]);
});

test('settings that would crash a warm are refused when saved', () => {
  const config = (nodes: unknown) =>
    ({ ...starterConfig(), composition: { nodes } }) as unknown as FoundryConfig;
  const node = { scope: 'org', personal: false, sources: [{ path: 'x.md' }] };
  for (const [nodes, message] of [
    [{ a: { ...node, owns: { within: '~/x' } } }, 'owns.within'],
    [{ a: { ...node, anchor: 5 } }, 'anchor'],
    [
      { a: { ...node, sources: [{ walk: [{ path: 'X.md', when: { paths: 'oops' } }] }] } },
      'when.paths',
    ],
    [{ a: { ...node, sources: [null] } }, 'must be an object'],
    [{ a: { ...node, sources: [{ path: 'x.md', maxLines: 5 }] } }, 'raw sources only'],
    [{ a: { ...node, sources: [{ path: 'x.md', glob: '*' }] } }, 'unknown field glob'],
  ] as const)
    expect(() => validateConfig(config(nodes))).toThrow(message);
});

test('a symlink never widens a personal file: ownership is judged on where it leads', async () => {
  write(join(claudeDir, 'CLAUDE.md'), 'PERSONAL_GLOBAL');
  symlinkSync(join(claudeDir, 'CLAUDE.md'), join(repo, 'CLAUDE.md'));
  write(join(repo, 'CLAUDE.local.md'), 'PERSONAL_LOCAL');
  symlinkSync(join(repo, 'CLAUDE.local.md'), join(repo, 'AGENTS.md'));
  for (const harnessLoadsGlobal of [false, true]) {
    const team = (await compose({ ...options(repo), harnessLoadsGlobal }, 'team')).text;
    expect(team).not.toContain('PERSONAL_GLOBAL');
    expect(team).not.toContain('PERSONAL_LOCAL');
  }
});

test('a committed CLAUDE.md symlinked to a credential file or out of the repository never loads', async () => {
  write(join(home, '.config', 'gh', 'hosts.yml'), 'oauth_token: gho_FAKE_SECRET');
  write(join(root, 'elsewhere', 'NOTES.md'), 'OUTSIDE_NOTES');
  write(join(repo, 'AI', 'ENTRYPOINT.md'), 'IN_REPO_ENTRY');
  symlinkSync(join(home, '.config', 'gh', 'hosts.yml'), join(repo, 'CLAUDE.md'));
  symlinkSync(join(root, 'elsewhere', 'NOTES.md'), join(repo, 'AGENTS.md'));
  mkdirSync(join(repo, '.claude'), { recursive: true });
  // A symlink that stays inside the repository (Kingdom's CLAUDE.md -> AI/ENTRYPOINT.md) is fine.
  symlinkSync(join(repo, 'AI', 'ENTRYPOINT.md'), join(repo, '.claude', 'CLAUDE.md'));
  const stack = await discoverInstructionStack(options(repo));
  expect(stack.files.map((file) => file.content)).toEqual(['IN_REPO_ENTRY']);
  expect(stack.refused.map((refusal) => [refusal.path.slice(repo.length), refusal.reason])).toEqual(
    [
      ['/CLAUDE.md', 'secret'],
      ['/AGENTS.md', 'outside-boundary'],
    ],
  );
  for (const audience of ['team', 'personal_private'] as const) {
    const text = (await compose(options(repo), audience)).text;
    expect(text).not.toContain('gho_FAKE_SECRET');
    expect(text).not.toContain('OUTSIDE_NOTES');
  }
  // The refusal is reported in the Selection panel, never silently dropped.
  const view = await composeRoleView({ ...options(repo), role: 'main' });
  const report = instructionStackReport(view, 'instructions', 'personal_private');
  expect(report.omitted.map((omitted) => omitted.reason)).toEqual(
    expect.arrayContaining([
      expect.stringContaining('credential directory'),
      expect.stringContaining('outside its level'),
    ]),
  );
});

test('every credential directory is refused, but a harness home under ~/.config still loads', async () => {
  for (const dir of ['.config/gh', '.local/share/archive', '.git', '.azure', '.cargo']) {
    // The global file may import from anywhere: only the credential check stands between it and the token.
    write(join(home, dir, 'token.md'), `SECRET in ${dir}`);
    write(join(claudeDir, 'CLAUDE.md'), `GLOBAL @~/${dir}/token.md`);
    const text = (await compose(options(repo))).text;
    expect(text).toContain('GLOBAL');
    expect(text).not.toContain('SECRET');
  }
  const xdgClaude = join(home, '.config', 'claude');
  write(join(xdgClaude, 'CLAUDE.md'), 'XDG_GLOBAL @rules-extra.md');
  write(join(xdgClaude, 'rules-extra.md'), 'XDG_IMPORT');
  const text = (await compose({ ...options(repo), claudeConfigDir: xdgClaude })).text;
  expect(text).toContain('XDG_GLOBAL');
  expect(text).toContain('XDG_IMPORT');
});

test('legitimate symlinks still load: ~/.claude into ~/.config, CLAUDE.local.md to private notes, a rule added in a new subdirectory', async () => {
  const xdg = join(home, '.config', 'claude');
  write(join(xdg, 'CLAUDE.md'), 'DOTFILES_GLOBAL');
  mkdirSync(home, { recursive: true });
  symlinkSync(xdg, claudeDir);
  write(join(root, 'notes', 'private.md'), 'PRIVATE_NOTES');
  symlinkSync(join(root, 'notes', 'private.md'), join(repo, 'CLAUDE.local.md'));
  const text = (await compose(options(repo))).text;
  expect(text).toContain('DOTFILES_GLOBAL');
  expect(text).toContain('PRIVATE_NOTES');
  // A personal file never reaches a team audience, wherever it points.
  expect((await compose(options(repo), 'team')).text).not.toContain('PRIVATE_NOTES');

  write(join(repo, '.claude', 'rules', 'sub', 'README.txt'), 'not a rule');
  // A file written as composition starts leaves the view unfingerprinted (re-read once); not here.
  await Bun.sleep(5);
  const view = await composeRoleView({ ...options(repo), role: 'main' });
  expect(roleViewChanged(view)).toBe(false);
  write(join(repo, '.claude', 'rules', 'sub', 'new.md'), 'NEW_RULE');
  expect(roleViewChanged(view)).toBe(true);
});

test('a composed slot re-reads when its thread moves to another cwd', async () => {
  const other = join(org, 'other');
  mkdirSync(join(other, '.git'), { recursive: true });
  write(join(repo, 'CLAUDE.md'), 'REPO_RULES');
  write(join(other, 'CLAUDE.md'), 'OTHER_RULES');
  await Bun.sleep(5);
  const scope = { threadId: 't', cwd: repo };
  const source = instructionStackSource(
    'instructions',
    { harness: 'claude', home, claudeConfigDir: claudeDir, codexHome },
    scope,
  );
  expect(await source.load()).toContain('REPO_RULES');
  expect(source.changed?.()).toBe(false);
  scope.cwd = other;
  expect(source.changed?.()).toBe(true);
  expect(await source.load()).toContain('OTHER_RULES');
});
