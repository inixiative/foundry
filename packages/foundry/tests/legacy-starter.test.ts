import './helpers/isolate-archive';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectReadiness } from '../src/readiness';
import {
  describeLegacyItem,
  findLegacyStarter,
  removeLegacyStarter,
} from '../src/setup/legacy-starter';
import { ConfigStore, defaultConfig, type FoundryConfig } from '../src/viewer/config';

const SYSTEM_PROMPT =
  'You are a helpful engineering assistant.\nFollow project conventions. Ask clarifying questions when requirements are ambiguous.\nWrite clean, tested code.';

/** What `bun run setup` seeded, as an install that has run for a while holds it (executors' models since dropped). */
function setupStarter(): FoundryConfig {
  const config = defaultConfig();
  config.layers = {
    system: {
      id: 'system',
      prompt: 'Core system instructions.',
      sourceIds: ['system-prompt'],
      staleness: 0,
      enabled: true,
    },
    conventions: {
      id: 'conventions',
      prompt: 'Project conventions and coding standards.',
      sourceIds: ['conventions-src'],
      staleness: 60_000,
      enabled: true,
    },
    memory: {
      id: 'memory',
      prompt: 'Working memory — recent context, signals, decisions.',
      sourceIds: ['memory-src'],
      staleness: 30_000,
      enabled: true,
    },
  };
  const decision = { provider: 'subscription-decisions', model: 'claude-haiku-5-5' };
  const executor = (id: string, prompt: string) => ({
    id,
    kind: 'executor' as const,
    prompt,
    provider: 'claude-code',
    temperature: 0,
    visibleLayers: [],
    peers: [],
    maxDepth: 3,
    enabled: true,
  });
  config.agents = {
    classifier: {
      id: 'classifier',
      kind: 'classifier',
      prompt:
        'Classify the incoming message into exactly one category.\nCategories: bug, feature, refactor, question, convention, general.\nRespond with JSON: {"category": "...", "subcategory": "...", "reasoning": "..."}',
      ...decision,
      temperature: 0,
      visibleLayers: ['system'],
      peers: [],
      maxDepth: 1,
      enabled: true,
    },
    router: {
      id: 'router',
      kind: 'router',
      prompt:
        'Route the classified message to the appropriate executor.\nAvailable executors: executor-fix (bugs), executor-build (features, refactors), executor-answer (questions, general).\nChoose context layers relevant to the task.\nRespond with JSON: {"destination": "...", "contextSlice": ["layer1"], "priority": 5, "reasoning": "..."}',
      ...decision,
      temperature: 0,
      visibleLayers: ['system'],
      peers: [],
      maxDepth: 1,
      enabled: true,
    },
    'executor-fix': executor(
      'executor-fix',
      'You are a bug-fixing assistant.\nAnalyze the reported issue, identify root cause, and propose a fix.\nInclude the reasoning behind your fix.',
    ),
    'executor-build': executor(
      'executor-build',
      'You are a feature-building assistant.\nBreak down the request into subtasks, then implement.\nFollow project conventions. Write clean, tested code.',
    ),
    'executor-answer': executor(
      'executor-answer',
      'You are a knowledgeable assistant.\nAnswer questions using project context and conventions.\nBe concise but thorough.',
    ),
  };
  config.sources = {
    'system-prompt': {
      id: 'system-prompt',
      type: 'inline',
      label: 'System prompt',
      uri: SYSTEM_PROMPT,
      enabled: true,
    },
    'conventions-src': {
      id: 'conventions-src',
      type: 'file',
      label: 'Conventions store',
      uri: '.foundry/memory',
      enabled: true,
    },
    'memory-src': {
      id: 'memory-src',
      type: 'file',
      label: 'Working memory',
      uri: '.foundry/memory',
      enabled: true,
    },
  };
  config.projects = {
    P: {
      id: 'P',
      path: '/work/repo',
      label: 'Repo',
      enabled: true,
      sources: {
        'project-docs': {
          id: 'project-docs',
          type: 'markdown',
          label: 'Project docs',
          uri: '/work/repo/docs',
          enabled: true,
        },
      },
    },
  };
  return config;
}

test('the whole unedited starter stack is found and removed, leaving one executor', () => {
  const config = setupStarter();
  expect(findLegacyStarter(config).map(describeLegacyItem)).toEqual([
    'agents.classifier',
    'agents.router',
    'agents.executor-fix',
    'agents.executor-build',
    'agents.executor-answer',
    'layers.system',
    'layers.conventions',
    'layers.memory',
    'sources.system-prompt',
    'sources.conventions-src',
    'sources.memory-src',
    'projects.P.sources.project-docs',
  ]);
  const { removed, addedExecutor } = removeLegacyStarter(config);
  expect(removed).toHaveLength(12);
  expect(addedExecutor).toBe(true);
  expect(Object.keys(config.agents)).toEqual(['executor']);
  expect(config.agents.executor).toMatchObject({ kind: 'executor', prompt: '' });
  expect(config.layers).toEqual({});
  expect(config.sources).toEqual({});
  expect(config.projects.P!.sources).toEqual({});
  // Nothing is left to find: the removal is idempotent.
  expect(removeLegacyStarter(config)).toEqual({ removed: [], addedExecutor: false });
});

test('the start.ts generation (instructions and project layers, the Artificer) is found too', () => {
  const config = defaultConfig();
  config.layers = {
    instructions: {
      id: 'instructions',
      prompt:
        'Standing instructions: personal, organization and project instruction files, and auto memory.',
      sourceIds: ['instructions'],
      staleness: 60_000,
      enabled: true,
    },
    project: {
      id: 'project',
      prompt: "This project's own documentation and agent conventions.",
      sourceIds: ['project-docs', 'project-ai'],
      staleness: 300_000,
      enabled: true,
    },
  };
  config.sources = {
    instructions: {
      id: 'instructions',
      type: 'instructions',
      label: 'Instruction files (CLAUDE.md, AGENTS.md, auto memory)',
      uri: '',
      enabled: true,
    },
    'conventions-src': {
      id: 'conventions-src',
      type: 'markdown',
      label: 'Project conventions',
      uri: '/work/repo/docs',
      enabled: true,
    },
    'memory-src': {
      id: 'memory-src',
      type: 'file',
      label: 'Working memory',
      uri: '/work/repo/.foundry/memory',
      enabled: true,
    },
  };
  config.agents.artificer = {
    id: 'artificer',
    kind: 'executor',
    flowRole: 'execution',
    prompt:
      "You are the Artificer — the engineering agent.\n\nYou receive tasks that have already been classified and routed to you with the right context layers. Your job is to execute: read code, write code, run tests, fix bugs, build features, answer questions.\n\nYour workflow:\n1. Understand the task from the routed context and user message\n2. Explore the codebase to build the mental model you need\n3. Implement incrementally — build, test, iterate\n4. Verify your changes don't break existing tests\n\nFollow project conventions. Write clean, tested code. Prefer editing existing files over creating new ones. Explain your reasoning when it's non-obvious.",
    provider: 'claude-code',
    temperature: 0,
    tools: true,
    permissions: 'bypass',
    visibleLayers: [],
    ownedLayers: [],
    peers: [],
    maxDepth: 5,
    invocation: 'on-demand',
    enabled: true,
  };
  expect(findLegacyStarter(config).map(describeLegacyItem)).toEqual([
    'agents.artificer',
    'layers.instructions',
    'layers.project',
    'sources.instructions',
    'sources.conventions-src',
    'sources.memory-src',
  ]);
  expect(removeLegacyStarter(config).addedExecutor).toBe(true);
  expect(Object.keys(config.agents)).toEqual(['executor']);
});

test('edited items, and what kept items still use, are never removed', () => {
  const config = setupStarter();
  // An edited prompt is the user's executor now.
  config.agents['executor-build']!.prompt += '\nAlways run the tests.';
  // A kept agent reads the system layer, so the layer and its source stay.
  config.agents.reviewer = {
    id: 'reviewer',
    kind: 'classifier',
    prompt: 'Review.',
    visibleLayers: ['system'],
    peers: [],
    maxDepth: 1,
    enabled: true,
  };
  // An edited source stays, and so does the layer that delivers it.
  config.sources['memory-src']!.uri = '/elsewhere/memory';
  // A project that extends the router keeps it.
  config.projects.P!.agents = {
    router: { extends: 'router', prompt: 'Prefer the build executor.' },
  };

  const found = findLegacyStarter(config).map(describeLegacyItem);
  expect(found).not.toContain('agents.executor-build');
  expect(found).not.toContain('agents.router');
  expect(found).not.toContain('layers.system');
  expect(found).not.toContain('sources.system-prompt');
  expect(found).not.toContain('sources.memory-src');
  expect(found).not.toContain('layers.memory');
  expect(found).toContain('layers.conventions');
  expect(found).toContain('agents.classifier');

  const { addedExecutor } = removeLegacyStarter(config);
  expect(addedExecutor).toBe(false);
  expect(config.agents['executor-build']!.prompt).toContain('Always run the tests.');
  expect(config.layers.system).toBeDefined();
  expect(config.sources['memory-src']!.uri).toBe('/elsewhere/memory');
});

test('doctor flags the starter defaults as a warning and names the removal command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'foundry-legacy-starter-'));
  try {
    const config = setupStarter();
    // API-token mode keeps readiness off this machine's subscription logins.
    config.apiTokens = true;
    config.defaults = { provider: 'openai', model: 'gpt-6-luna' };
    for (const agent of Object.values(config.agents)) agent.provider = 'openai';
    await new ConfigStore(directory).save(config);
    const loaded = await new ConfigStore(directory).load();
    const report = await inspectReadiness(loaded, {
      environment: { OPENAI_API_KEY: 'key' },
      which: () => '/controlled/cli',
      configDir: directory,
    });
    const issue = report.issues.find((item) => item.code === 'legacy-starter-defaults');
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain('agents.classifier');
    expect(issue?.message).toContain('bun run setup --remove-legacy-defaults');

    const clean = await inspectReadiness(
      (() => {
        removeLegacyStarter(loaded);
        return loaded;
      })(),
      {
        environment: { OPENAI_API_KEY: 'key' },
        which: () => '/controlled/cli',
        configDir: directory,
      },
    );
    expect(clean.issues.some((item) => item.code === 'legacy-starter-defaults')).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
