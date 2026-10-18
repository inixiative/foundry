import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type CompletionOpts,
  ContextStack,
  claudemdSource,
  FileMemory,
  Harness,
  type LLMMessage,
  type LLMProvider,
} from '@inixiative/foundry-core';
import { oneCall } from '../src/agents/domain-librarian';
import { regionInstructions } from '../src/agents/region-roster';
import { invalidateComposition } from '../src/agents/role-layers';
import {
  buildAgents,
  buildLayers,
  createSourceResolver,
  ThreadFactory,
} from '../src/agents/thread-factory';
import { ThreadRuntimeManager } from '../src/agents/thread-runtime';
import { chartered } from '../src/classify';
import type { RoleComposition } from '../src/prompts/instruction-settings';
import {
  claudeProjectDirName,
  composeRoleView,
  compositionSource,
  instructionStackReport,
} from '../src/prompts/instruction-stack';
import { primedRequest } from '../src/providers/primed-decisions';
import { type FoundryConfig, starterConfig } from '../src/viewer/config';
import { writeRegions } from './helpers/regions';

/**
 * The composition view (docs/usage-and-context.md, "Composition view"): one ladder composes the
 * instructions and domain knowledge of every role, main thread and Warden alike.
 */

let root: string, home: string, claudeDir: string, org: string, repo: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'foundry-composition-view-')));
  home = join(root, 'home');
  claudeDir = join(home, '.claude');
  org = join(root, 'code', 'org');
  repo = join(org, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  // The machine's own instruction files never reach these tests.
  for (const key of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) saved[key] = process.env[key];
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.CODEX_HOME = join(home, '.codex');
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  rmSync(root, { recursive: true, force: true });
});

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const roleFile = (dir: string, role: string, slot: string, local = false) =>
  join(dir, '.foundry', 'roles', role, `${slot}${local ? '.local' : ''}.md`);
/** The project's one region, and so its one Warden (role and domain are the region id). */
const WARDEN = 'conventions';
const REGION = { id: WARDEN, title: 'Conventions', routing: 'Is this about how this repo works?' };
const REGION_RULES = regionInstructions(REGION);

/** Aron's machine in miniature: computer personal, org, project, project personal. */
function ladderFiles() {
  write(join(claudeDir, 'CLAUDE.md'), '# Me\n\nPERSONAL_GLOBAL');
  write(join(org, 'CLAUDE.md'), '# Org\n\nORG_RULES');
  write(join(repo, 'CLAUDE.md'), '# Project\n\nPROJECT_RULES');
  write(join(repo, 'CLAUDE.local.md'), '# Mine\n\nPROJECT_PERSONAL');
}

const view = (role: string, picks: RoleComposition = {}) =>
  composeRoleView({ cwd: repo, harness: 'claude', home, role, picks });

test('every role composes from the same ladder; everything that applies is on, a role opts out', async () => {
  ladderFiles();
  const main = await view('main');
  const warden = await view(WARDEN);
  for (const text of ['PERSONAL_GLOBAL', 'ORG_RULES', 'PROJECT_RULES', 'PROJECT_PERSONAL']) {
    expect(main.slots.instructions.text).toContain(text);
    expect(warden.slots.instructions.text).toContain(text);
  }
  // CLAUDE.md is instructions; a Warden's domain knowledge takes nothing it did not ask for.
  expect(warden.slots.domainKnowledge.text).toBe('');

  const optedOut = await view(WARDEN, { instructions: { exclude: ['global', 'local'] } });
  expect(optedOut.slots.instructions.text).not.toContain('PERSONAL_GLOBAL');
  expect(optedOut.slots.instructions.text).not.toContain('PROJECT_PERSONAL');
  expect(optedOut.slots.instructions.text).toContain('ORG_RULES');
  expect(optedOut.slots.instructions.excluded.map((file) => file.level).sort()).toEqual([
    'global',
    'local',
  ]);
  expect(
    instructionStackReport(optedOut, 'instructions', 'personal_private').omitted.map(
      (entry) => entry.reason,
    ),
  ).toContain(`excluded from instructions by composition.roles.${WARDEN}`);
  // Another role's opt-out is its own.
  expect((await view('main')).slots.instructions.text).toContain('PERSONAL_GLOBAL');
  expect((await view(WARDEN, { instructions: false })).slots.instructions.text).toBe('');
});

test('role files are templated by role and slot at every rung, and stay with their role', async () => {
  write(join(home, '.foundry', 'roles', WARDEN, 'instructions.md'), 'COMPUTER_WARDEN_INSTRUCTIONS');
  write(roleFile(org, WARDEN, 'domainKnowledge'), 'ORG_WARDEN_KNOWLEDGE');
  write(roleFile(repo, WARDEN, 'instructions'), 'PROJECT_WARDEN_INSTRUCTIONS');
  write(roleFile(repo, WARDEN, 'domainKnowledge', true), 'PERSONAL_WARDEN_KNOWLEDGE');
  write(roleFile(repo, 'main', 'instructions'), 'MAIN_ONLY_INSTRUCTIONS');
  const warden = await view(WARDEN);
  expect(warden.slots.instructions.files.map((file) => [file.content, file.level])).toEqual([
    ['COMPUTER_WARDEN_INSTRUCTIONS', 'global'],
    ['PROJECT_WARDEN_INSTRUCTIONS', 'project'],
  ]);
  expect(warden.slots.domainKnowledge.files.map((file) => [file.content, file.level])).toEqual([
    ['ORG_WARDEN_KNOWLEDGE', 'org'],
    ['PERSONAL_WARDEN_KNOWLEDGE', 'local'],
  ]);
  expect(warden.slots.domainKnowledge.files.at(-1)!.tier).toBe('personal_private');
  const main = await view('main');
  expect(main.slots.instructions.text).toContain('MAIN_ONLY_INSTRUCTIONS');
  expect(main.slots.instructions.text).not.toContain('WARDEN');
  expect(warden.slots.instructions.text).not.toContain('MAIN_ONLY');
});

test('a narrow role keeps its role files at every rung while picking which general files it reads', async () => {
  ladderFiles();
  write(roleFile(org, WARDEN, 'instructions'), 'ORG_WARDEN_INSTRUCTIONS');
  write(roleFile(repo, WARDEN, 'instructions'), 'PROJECT_WARDEN_INSTRUCTIONS');
  const narrow = await view(WARDEN, { instructions: { general: ['global'] } });
  const text = narrow.slots.instructions.text;
  for (const kept of ['PERSONAL_GLOBAL', 'ORG_WARDEN_INSTRUCTIONS', 'PROJECT_WARDEN_INSTRUCTIONS'])
    expect(text).toContain(kept);
  for (const dropped of ['ORG_RULES', 'PROJECT_RULES', 'PROJECT_PERSONAL'])
    expect(text).not.toContain(dropped);
  // `exclude`, by contrast, drops a node whole: its role files too.
  const excluded = await view(WARDEN, { instructions: { exclude: ['org'] } });
  expect(excluded.slots.instructions.text).not.toContain('ORG_WARDEN_INSTRUCTIONS');
  expect(excluded.slots.instructions.text).toContain('PROJECT_WARDEN_INSTRUCTIONS');
});

test('a role reads a file once: one it pulls into domain knowledge leaves its instructions', async () => {
  ladderFiles();
  const warden = await view(WARDEN, { domainKnowledge: { general: ['org', 'project'] } });
  expect(warden.slots.domainKnowledge.text).toContain('ORG_RULES');
  expect(warden.slots.domainKnowledge.text).toContain('PROJECT_RULES');
  expect(warden.slots.instructions.text).not.toContain('ORG_RULES');
  expect(warden.slots.instructions.text).not.toContain('PROJECT_RULES');
  expect(warden.slots.instructions.text).toContain('PERSONAL_GLOBAL');
  const report = instructionStackReport(warden, 'instructions', 'personal_private');
  expect(report.omitted.filter((entry) => entry.duplicateOf)).toEqual([
    expect.objectContaining({
      id: join(org, 'CLAUDE.md'),
      duplicateOf: `${join(org, 'CLAUDE.md')} (org, domainKnowledge)`,
    }),
    expect.objectContaining({
      id: join(repo, 'CLAUDE.md'),
      duplicateOf: `${join(repo, 'CLAUDE.md')} (project, domainKnowledge)`,
    }),
  ]);
  const included = instructionStackReport(warden, 'domainKnowledge', 'personal_private');
  expect(included.selected[0]!.reason).toContain(
    `[included in domainKnowledge by composition.roles.${WARDEN}]`,
  );
  // The main thread is a separate role: its instructions keep every file.
  expect((await view('main')).slots.instructions.text).toContain('ORG_RULES');
});

test('a personal node never reaches a team audience, in either slot, even when opted in', async () => {
  ladderFiles();
  write(roleFile(repo, WARDEN, 'domainKnowledge', true), 'PERSONAL_WARDEN_KNOWLEDGE');
  write(join(home, '.foundry', 'roles', WARDEN, 'domainKnowledge.md'), 'COMPUTER_PERSONAL');
  const team = await view(WARDEN, {
    audience: 'team',
    domainKnowledge: { general: ['org', 'project', 'local', 'global'] },
  });
  const all = `${team.slots.instructions.text}\n${team.slots.domainKnowledge.text}`;
  for (const text of [
    'PERSONAL_GLOBAL',
    'PROJECT_PERSONAL',
    'PERSONAL_WARDEN_KNOWLEDGE',
    'COMPUTER_PERSONAL',
  ])
    expect(all).not.toContain(text);
  expect(all).toContain('ORG_RULES');
  expect(all).toContain('PROJECT_RULES');
  expect(
    instructionStackReport(team, 'domainKnowledge', 'team').omitted.map((entry) => entry.reason),
  ).toContain('not visible to team');
});

// ---------------------------------------------------------------------------
// Runtime: Wardens, the Cartographer and the main thread take their slots from the view.
// ---------------------------------------------------------------------------

interface Call {
  phase: 'central' | 'advise' | 'guard' | 'review' | 'route';
  messages: LLMMessage[];
  opts: CompletionOpts;
}

/**
 * A region Warden takes no general files by default (`instructions.general: []` in its view); these
 * tests give it the whole ladder (`instructions: {}`), as any other role has, unless they pick.
 */
function config(picks: RoleComposition = { instructions: {} }): FoundryConfig {
  const c = starterConfig('central', 'central-model');
  c.agents = {
    worker: {
      id: 'worker',
      kind: 'executor',
      prompt: 'WORKER',
      provider: 'central',
      model: 'central-model',
      visibleLayers: [],
      peers: [],
      maxDepth: 1,
      enabled: true,
    },
  };
  c.layers = {
    instructions: {
      id: 'instructions',
      prompt: 'Standing instructions.',
      sourceIds: ['instructions'],
      staleness: 60_000,
      enabled: true,
    },
  };
  c.sources = {
    instructions: { id: 'instructions', type: 'instructions', label: 'I', uri: '', enabled: true },
  };
  c.projects.P = { id: 'P', path: repo };
  c.composition = { roles: { [WARDEN]: picks } };
  return c;
}

function setup(
  c: FoundryConfig,
  advice: { snippets: string[] } = { snippets: [] },
  routeLayers: string[] = [],
) {
  writeRegions(repo, [{ ...REGION, knowledge: 'REGION_KNOWLEDGE' }]);
  const calls: Call[] = [];
  const provider = (id: string): LLMProvider => ({
    id,
    async complete(messages, opts = {}) {
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      const phase: Call['phase'] = opts.threadId?.endsWith(':cartographer')
        ? 'route'
        : user.includes('## Completed work')
          ? 'review'
          : user.includes('## Tool observation')
            ? 'guard'
            : opts.threadId?.includes(':aux:')
              ? 'advise'
              : 'central';
      calls.push({ phase, messages: structuredClone(messages), opts: { ...opts } });
      const content =
        phase === 'route'
          ? JSON.stringify({ layers: routeLayers, domains: ['conventions'], confidence: 1 })
          : phase === 'advise'
            ? advice.snippets.length
              ? JSON.stringify({ layers: [], snippets: advice.snippets, confidence: 1 })
              : 'NO_COMMENT'
            : phase === 'guard' || phase === 'review'
              ? 'NO_COMMENT'
              : 'done';
      return { model: 'controlled', content };
    },
  });
  const central = provider('central'),
    flow = provider('flow');
  const providers = new Map([central, flow].map((p) => [p.id, p]));
  const sourceResolver = createSourceResolver({ memory: new FileMemory(join(root, 'memory')) });
  const stack = new ContextStack(buildLayers(c, { sourceResolver }));
  const manager = new ThreadRuntimeManager({
    config: c,
    llm: flow,
    providers,
    log() {},
    warn() {},
    learning: { timeoutMs: 20, hardTimeoutMs: 1000 },
  });
  const deps = { provider: central, providers };
  const factory = new ThreadFactory({
    stack,
    agents: buildAgents(c, stack, deps),
    runtime: manager,
    configuration: { config: c, layers: { sourceResolver }, agents: deps },
  });
  const thread = factory.create('t', { projectId: 'P', cwd: repo });
  const runtime = manager.get('t')!;
  const last = (phase: Call['phase']) => calls.filter((call) => call.phase === phase).at(-1)!;
  return {
    factory,
    thread,
    runtime,
    calls,
    last,
    lib: runtime.domainLibrarians.get('conventions')!,
    async close() {
      await runtime.learningSettled();
      manager.disposeAll();
    },
  };
}

test('a Warden and the main thread take their slots from the view; the Warden slots stay private', async () => {
  ladderFiles();
  write(roleFile(repo, WARDEN, 'domainKnowledge'), 'PROJECT_WARDEN_KNOWLEDGE');
  const f = setup(config());
  try {
    await f.thread.dispatch('worker', 'Add a script', undefined, { messageId: 'm1' });
    const advise = f.last('advise');
    expect(advise.messages[0]!.content).toStartWith(chartered(REGION_RULES));
    expect(advise.messages[0]!.content).toContain('PROJECT_RULES');
    expect(advise.messages[1]!.content).toContain('REGION_KNOWLEDGE');
    expect(advise.messages[1]!.content).toContain('PROJECT_WARDEN_KNOWLEDGE');
    const central = JSON.stringify(f.last('central').messages);
    expect(central).toContain('PROJECT_RULES');
    // Role files and Warden slots never reach the executor.
    expect(central).not.toContain('PROJECT_WARDEN_KNOWLEDGE');
    expect(central).not.toContain('REGION_KNOWLEDGE');
    expect(central).not.toContain(REGION_RULES);
    expect(f.thread.stack.layers.some((layer) => layer.id.startsWith('role:'))).toBe(false);
  } finally {
    await f.close();
  }
});

test('a composition over the role budget is a clear reported error in every phase; nothing is sent', async () => {
  ladderFiles();
  write(join(org, 'CLAUDE.md'), `# Org\n\n${'ORG_POLICY '.repeat(400)}`);
  const f = setup(config({ budget: 3_000, domainKnowledge: { general: ['org'] } }));
  try {
    await f.thread.dispatch('worker', 'Add a script', undefined, { messageId: 'm1' });
    expect(f.calls.filter((call) => call.phase === 'advise')).toHaveLength(0);
    const advice = await f.lib.advise('Add a script');
    expect(advice.error).toContain('exceed its budget of 3000');
    expect(advice.error).toContain(`composition.roles.${WARDEN}.budget`);
    expect(advice.error).toContain(`${join(org, 'CLAUDE.md')} (domainKnowledge`);
    expect(advice.error).toContain('opted in');
    const guard = await f.lib.guard(oneCall({ tool: 'Write', input: { file_path: 'a.ts' } }));
    expect(guard.status).toBe('not-admitted');
    expect(guard.error).toContain('exceed its budget');
    expect(guard.request).toMatchObject({ status: 'not-sent' });
    await f.runtime.learningSettled();
    const reviewed = f.lib.threadKnowledge.history.at(-1)!;
    expect(reviewed.decision).toBe('error');
    expect(reviewed.reason).toContain('exceed its budget');
    expect(f.calls.filter((call) => call.phase !== 'central' && call.phase !== 'route')).toEqual(
      [],
    );
  } finally {
    await f.close();
  }
});

test('the Cartographer composes too, and over its budget routing reports an error', async () => {
  ladderFiles();
  const c = config();
  c.composition = { roles: { ...c.composition!.roles, cartographer: { budget: 50 } } };
  const f = setup(c);
  try {
    const turn = await f.thread.dispatch('worker', 'Route me', undefined, { messageId: 'm1' });
    expect(f.calls.filter((call) => call.phase === 'route')).toHaveLength(0);
    const plan = turn.meta?.injection as {
      plan?: { routing: { status: string; reason?: string } };
    };
    expect(plan.plan!.routing.status).toBe('error');
    expect(plan.plan!.routing.reason).toContain('composition.roles.cartographer.budget');
  } finally {
    await f.close();
  }
  const g = setup(config());
  try {
    await g.thread.dispatch('worker', 'Route me', undefined, { messageId: 'm1' });
    expect(g.last('route').messages[0]!.content).toContain('ORG_RULES');
  } finally {
    await g.close();
  }
});

test('a Warden primes its composed prefix and re-primes only when the composition changes', async () => {
  ladderFiles();
  write(roleFile(repo, WARDEN, 'domainKnowledge'), 'KNOWLEDGE_V1');
  const f = setup(config());
  const primed = () => {
    const call = f.last('advise');
    return primedRequest(call.messages, call.opts, 'domain:conventions');
  };
  try {
    await f.thread.dispatch('worker', 'First', undefined, { messageId: 'm1' });
    const first = primed();
    // The primed prefix is the composed instructions and domain knowledge; the turn is the input.
    expect(first.spec.instructions).toContain('PROJECT_RULES');
    expect(first.spec.context).toContain('KNOWLEDGE_V1');
    expect(first.input).toContain('First');
    expect(first.input).not.toContain('KNOWLEDGE_V1');
    await f.thread.dispatch('worker', 'Second', undefined, { messageId: 'm2' });
    expect(primed().spec.hash).toBe(first.spec.hash);
    write(roleFile(repo, WARDEN, 'domainKnowledge'), 'KNOWLEDGE_V2');
    expect(invalidateComposition()).toBeGreaterThan(0);
    await f.thread.dispatch('worker', 'Third', undefined, { messageId: 'm3' });
    const third = primed();
    expect(third.spec.context).toContain('KNOWLEDGE_V2');
    expect(third.spec.hash).not.toBe(first.spec.hash);
  } finally {
    await f.close();
  }
});

test("a Warden that chimes in is appended to the end of the user's message, not the context", async () => {
  const f = setup(config(), { snippets: ['Use the existing script runner.'] });
  write(roleFile(repo, WARDEN, 'domainKnowledge'), 'KNOWLEDGE');
  try {
    await f.thread.dispatch('worker', 'Add a script', undefined, { messageId: 'm1' });
    const messages = f.last('central').messages;
    const user = messages.filter((m) => m.role === 'user').at(-1)!.content;
    expect(user).toStartWith('Add a script');
    expect(user).toEndWith('The conventions Warden chimed in:\n- Use the existing script runner.');
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    // The context holds the reception charter (how to read a chime), never the chime itself.
    expect(system).toContain('# Chimes from the Warden chorus');
    expect(system).not.toContain('Use the existing script runner.');
  } finally {
    await f.close();
  }
});

test("the Convention Warden's knowledge is unchanged under the default config: org and project CLAUDE.md", async () => {
  // Today: a conventions-src markdown source (the org CLAUDE.md) on the Warden's owned layer, and
  // each project's project-claude-md through its extension. The view reads the same files.
  write(join(org, 'CLAUDE.md'), '# inixiative\n\nMerge once green. @docs/ports.md');
  write(join(org, 'docs', 'ports.md'), 'Ports come from the registry.');
  write(join(repo, 'CLAUDE.md'), '# Foundry\n\nThe daemon runs from the shared checkout.');
  const before = [
    await claudemdSource('conventions-src', join(org, 'CLAUDE.md')).load(),
    await claudemdSource('project-claude-md', join(repo, 'CLAUDE.md')).load(),
  ];
  const f = setup(config({ domainKnowledge: { general: ['org', 'project'] } }));
  try {
    await f.thread.dispatch('worker', 'Add a script', undefined, { messageId: 'm1' });
    const knowledge = f.last('advise').messages[1]!.content;
    // Every line the old sources loaded, imports included; only the per-file headings differ.
    const lines = before
      .flatMap((text) => text.split('\n'))
      .filter((line) => line.trim() && !line.startsWith('Contents of '));
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) expect(knowledge).toContain(line);
    expect(knowledge).toContain('Ports come from the registry.');
  } finally {
    await f.close();
  }
});

test("a role never reads more personal files than the main thread's audience allows", async () => {
  ladderFiles();
  write(roleFile(repo, WARDEN, 'domainKnowledge'), 'KNOWLEDGE');
  // The Warden's notes reach main's message, so a team main thread makes the Warden team too.
  const c = config();
  c.composition = { roles: { ...c.composition!.roles, main: { audience: 'team' } } };
  const f = setup(c);
  try {
    await f.thread.dispatch('worker', 'Add a script', undefined, { messageId: 'm1' });
    const advise = JSON.stringify(f.last('advise').messages);
    expect(advise).toContain('ORG_RULES');
    expect(advise).not.toContain('PERSONAL_GLOBAL');
    expect(advise).not.toContain('PROJECT_PERSONAL');
  } finally {
    await f.close();
  }
});

test('a home role file symlinked into the repository stays personal', async () => {
  write(join(home, '.foundry', 'roles', 'main', 'instructions.md'), 'HOME_ROLE_SECRET');
  mkdirSync(join(repo, '.foundry', 'roles', 'main'), { recursive: true });
  symlinkSync(
    join(home, '.foundry', 'roles', 'main', 'instructions.md'),
    roleFile(repo, 'main', 'instructions'),
  );
  const team = await view('main', { audience: 'team' });
  expect(team.slots.instructions.text).not.toContain('HOME_ROLE_SECRET');
  expect((await view('main')).slots.instructions.text).toContain('HOME_ROLE_SECRET');
});

test('a slot the role does not receive is not composed, so dedupe never moves text into it', async () => {
  write(join(repo, 'CLAUDE.md'), '# Project\n\n## Rules\n\nKEEP_ME');
  write(roleFile(repo, 'main', 'domainKnowledge'), '# Project\n\n## Rules\n\nKEEP_ME');
  const c = config();
  // The main thread receives instructions only (its one instructions source).
  const source = compositionSource(c, 'main-instructions', 'main', 'instructions', ['instructions'])
    .bind!({ threadId: 't', cwd: repo });
  expect(await source.load()).toContain('KEEP_ME');
  // A role receiving both slots reads it once, in domain knowledge.
  const both = await view('main');
  expect(both.slots.instructions.text).not.toContain('KEEP_ME');
  expect(both.slots.domainKnowledge.text).toContain('KEEP_ME');
});

test('a composition edit reaches the main thread on its next turn', async () => {
  ladderFiles();
  const c = config();
  const f = setup(c);
  try {
    await f.thread.dispatch('worker', 'First', undefined, { messageId: 'm1' });
    expect(JSON.stringify(f.last('central').messages)).toContain('PERSONAL_GLOBAL');
    const next = structuredClone(c);
    next.composition = { roles: { main: { instructions: { exclude: ['global'] } } } };
    await f.factory.reconfigure(next);
    await f.thread.dispatch('worker', 'Second', undefined, { messageId: 'm2' });
    expect(JSON.stringify(f.last('central').messages)).not.toContain('PERSONAL_GLOBAL');
  } finally {
    await f.close();
  }
});

test('an edited CLAUDE.md, a new MEMORY.md and an edited role file reach a running thread and its Warden on the next turn', async () => {
  ladderFiles();
  write(roleFile(repo, WARDEN, 'domainKnowledge'), 'KNOWLEDGE_V1');
  const f = setup(config());
  const primed = () => {
    const call = f.last('advise');
    return primedRequest(call.messages, call.opts, 'domain:conventions');
  };
  try {
    await f.thread.dispatch('worker', 'First', undefined, { messageId: 'm1' });
    const first = primed();
    expect(JSON.stringify(f.last('central').messages)).toContain('PROJECT_RULES');
    // Nobody calls invalidateComposition(): the edits are found by the slots' own file check.
    write(join(repo, 'CLAUDE.md'), '# Project\n\nPROJECT_RULES_V2');
    write(
      join(claudeDir, 'projects', claudeProjectDirName(repo), 'memory', 'MEMORY.md'),
      'REMEMBERED_FACT',
    );
    write(roleFile(repo, WARDEN, 'domainKnowledge'), 'KNOWLEDGE_V2');
    await f.thread.dispatch('worker', 'Second', undefined, { messageId: 'm2' });
    const central = JSON.stringify(f.last('central').messages);
    expect(central).toContain('PROJECT_RULES_V2');
    expect(central).toContain('REMEMBERED_FACT');
    const second = primed();
    expect(second.spec.instructions).toContain('PROJECT_RULES_V2');
    expect(second.spec.context).toContain('KNOWLEDGE_V2');
    expect(second.spec.hash).not.toBe(first.spec.hash);
    // Nothing changed: the next turn neither re-composes into a new hash nor re-primes.
    await f.thread.dispatch('worker', 'Third', undefined, { messageId: 'm3' });
    expect(primed().spec.hash).toBe(second.spec.hash);
  } finally {
    await f.close();
  }
});

test("invalidateComposition() also refreshes the main thread's instructions slot", async () => {
  ladderFiles();
  const f = setup(config());
  try {
    await f.thread.dispatch('worker', 'First', undefined, { messageId: 'm1' });
    const layer = f.thread.stack.getLayer('instructions')!;
    expect(layer.checkStaleness()).toBe('warm');
    invalidateComposition();
    expect(layer.checkStaleness()).toBe('stale');
    // A stale standing layer keeps its last content in assembly until it re-warms.
    expect(f.thread.stack.assemble().text).toContain('PROJECT_RULES');
  } finally {
    await f.close();
  }
});

test('an on-demand layer the Cartographer routes to reaches the executor; one it does not, never does', async () => {
  ladderFiles();
  const c = config();
  c.layers.playbook = {
    id: 'playbook',
    prompt: 'On-demand playbook.',
    sourceIds: ['playbook'],
    staleness: 0,
    activation: 'on-demand',
    enabled: true,
  };
  c.sources.playbook = {
    id: 'playbook',
    type: 'inline',
    label: 'Playbook',
    uri: 'ON_DEMAND_PLAYBOOK',
    enabled: true,
  };
  // The turn path: a Harness applies each layer's activation (turn-service.ts).
  const send = async (f: ReturnType<typeof setup>) => {
    const harness = new Harness(f.thread);
    harness.setDefaultExecutor('worker');
    harness.loadModes(c.agents, c.layers);
    await harness.send({ id: 'm1', payload: 'First' });
    return JSON.stringify(f.last('central').messages);
  };
  const quiet = setup(c);
  try {
    expect(await send(quiet)).not.toContain('ON_DEMAND_PLAYBOOK');
  } finally {
    await quiet.close();
  }
  const routed = setup(c, { snippets: [] }, ['playbook']);
  try {
    expect(await send(routed)).toContain('ON_DEMAND_PLAYBOOK');
  } finally {
    await routed.close();
  }
});
