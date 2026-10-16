import { isDeepStrictEqual } from 'node:util';
import {
  type AgentSettingsConfig,
  type DataSourceConfig,
  DEFAULT_EXECUTOR_ID,
  defaultAgents,
  type FoundryConfig,
  type LayerSettingsConfig,
} from '../viewer/config';

/**
 * The starter defaults older installs were seeded with, which wrapped every thread: a classifier and
 * a router ahead of prompt-only executors, and system / conventions / memory layers (the memory ones
 * reading Foundry's own signal log back as "memory"). A fresh install now has one executor and
 * nothing else (viewer/config.ts, defaultAgents). Doctor flags what is left of them and setup removes
 * it, but only items that still match a starter shape exactly: anything a user edited is kept.
 *
 * An item matches when it equals a starter shape apart from `provider`, `model` and `enabled`, which
 * setup filled in from the install's defaults. Paths the starter derived from a directory match any
 * directory.
 */

const SYSTEM_PROMPT =
  'You are a helpful engineering assistant.\nFollow project conventions. Ask clarifying questions when requirements are ambiguous.\nWrite clean, tested code.';
const CLASSIFIER_PROMPT =
  'Classify the incoming message into exactly one category.\nCategories: bug, feature, refactor, question, convention, general.\nRespond with JSON: {"category": "...", "subcategory": "...", "reasoning": "..."}';

const decisionRole = { temperature: 0, visibleLayers: ['system'], peers: [], maxDepth: 1 };
const startRole = {
  flowRole: 'context-routing',
  temperature: 0,
  tools: false,
  visibleLayers: ['system'],
  ownedLayers: [],
  peers: [],
  maxDepth: 1,
  invocation: 'always',
};
const promptExecutor = (id: string, prompt: string) => ({
  id,
  kind: 'executor',
  prompt,
  temperature: 0,
  visibleLayers: [],
  peers: [],
  maxDepth: 3,
});

/** `bun run setup` (setup.ts) and `bun run start` (start.ts) each seeded a generation; both are listed. */
const LEGACY_AGENTS: Record<string, object[]> = {
  classifier: [
    { id: 'classifier', kind: 'classifier', prompt: CLASSIFIER_PROMPT, ...decisionRole },
    { id: 'classifier', kind: 'classifier', prompt: CLASSIFIER_PROMPT, ...startRole },
  ],
  router: [
    {
      id: 'router',
      kind: 'router',
      prompt:
        'Route the classified message to the appropriate executor.\nAvailable executors: executor-fix (bugs), executor-build (features, refactors), executor-answer (questions, general).\nChoose context layers relevant to the task.\nRespond with JSON: {"destination": "...", "contextSlice": ["layer1"], "priority": 5, "reasoning": "..."}',
      ...decisionRole,
    },
    {
      id: 'router',
      kind: 'router',
      prompt:
        'Route the classified message to the Artificer with the right context layers.\nChoose which layers are relevant to the task.\nRespond with JSON: {"destination": "artificer", "contextSlice": ["layer1"], "priority": 5, "reasoning": "..."}',
      ...startRole,
    },
  ],
  'executor-fix': [
    promptExecutor(
      'executor-fix',
      'You are a bug-fixing assistant.\nAnalyze the reported issue, identify root cause, and propose a fix.\nInclude the reasoning behind your fix.',
    ),
  ],
  'executor-build': [
    promptExecutor(
      'executor-build',
      'You are a feature-building assistant.\nBreak down the request into subtasks, then implement.\nFollow project conventions. Write clean, tested code.',
    ),
  ],
  'executor-answer': [
    promptExecutor(
      'executor-answer',
      'You are a knowledgeable assistant.\nAnswer questions using project context and conventions.\nBe concise but thorough.',
    ),
  ],
  artificer: [
    {
      id: 'artificer',
      kind: 'executor',
      flowRole: 'execution',
      prompt:
        "You are the Artificer — the engineering agent.\n\nYou receive tasks that have already been classified and routed to you with the right context layers. Your job is to execute: read code, write code, run tests, fix bugs, build features, answer questions.\n\nYour workflow:\n1. Understand the task from the routed context and user message\n2. Explore the codebase to build the mental model you need\n3. Implement incrementally — build, test, iterate\n4. Verify your changes don't break existing tests\n\nFollow project conventions. Write clean, tested code. Prefer editing existing files over creating new ones. Explain your reasoning when it's non-obvious.",
      temperature: 0,
      tools: true,
      permissions: 'bypass',
      visibleLayers: [],
      ownedLayers: [],
      peers: [],
      maxDepth: 5,
      invocation: 'on-demand',
    },
  ],
};

const LEGACY_LAYERS: Record<string, object[]> = {
  system: [
    {
      id: 'system',
      prompt: 'Core system instructions.',
      sourceIds: ['system-prompt'],
      staleness: 0,
    },
  ],
  instructions: [
    {
      id: 'instructions',
      prompt:
        'Standing instructions: personal, organization and project instruction files, and auto memory.',
      sourceIds: ['instructions'],
      staleness: 60_000,
    },
  ],
  conventions: [
    {
      id: 'conventions',
      prompt: 'Project conventions and coding standards.',
      sourceIds: ['conventions-src'],
      staleness: 60_000,
    },
  ],
  memory: [
    {
      id: 'memory',
      prompt: 'Working memory — recent context, signals, decisions.',
      sourceIds: ['memory-src'],
      staleness: 30_000,
    },
  ],
  project: [
    {
      id: 'project',
      prompt: "This project's own documentation and agent conventions.",
      sourceIds: ['project-docs', 'project-ai'],
      staleness: 300_000,
    },
  ],
};

/** A starter source; `under` matches a uri the starter derived from a directory: `<any dir>/<under>`. */
type SourceShape = Omit<DataSourceConfig, 'enabled'> & { under?: string };
const LEGACY_SOURCES: Record<string, SourceShape[]> = {
  'system-prompt': [
    { id: 'system-prompt', type: 'inline', label: 'System prompt', uri: SYSTEM_PROMPT },
  ],
  instructions: [
    {
      id: 'instructions',
      type: 'instructions',
      label: 'Instruction files (CLAUDE.md, AGENTS.md, auto memory)',
      uri: '',
    },
  ],
  'conventions-src': [
    { id: 'conventions-src', type: 'file', label: 'Conventions store', uri: '.foundry/memory' },
    {
      id: 'conventions-src',
      type: 'markdown',
      label: 'Project conventions',
      uri: '',
      under: 'docs',
    },
  ],
  'memory-src': [
    { id: 'memory-src', type: 'file', label: 'Working memory', uri: '.foundry/memory' },
    { id: 'memory-src', type: 'file', label: 'Working memory', uri: '', under: '.foundry/memory' },
  ],
};

/** A project's own sources the starter added for the `project` layer, under the project's path. */
const LEGACY_PROJECT_SOURCES: Record<string, { label: string; dir: string }> = {
  'project-docs': { label: 'Project docs', dir: 'docs' },
  'project-ai': { label: 'Project agent conventions', dir: 'AI' },
};

const FILLED = new Set(['provider', 'model', 'enabled']);
const canonical = (item: object) =>
  Object.fromEntries(Object.entries(item).filter(([key]) => !FILLED.has(key)));
const matches = (item: object | undefined, shapes: object[] | undefined) =>
  !!item && !!shapes?.some((shape) => isDeepStrictEqual(canonical(item), canonical(shape)));
const sourceMatches = (source: DataSourceConfig | undefined, shapes: SourceShape[] | undefined) =>
  !!source &&
  !!shapes?.some(({ under, ...shape }) => {
    const { uri, ...rest } = canonical(source) as DataSourceConfig;
    const { uri: shapeUri, ...shapeRest } = canonical(shape) as DataSourceConfig;
    if (!isDeepStrictEqual(rest, shapeRest)) return false;
    return under ? uri.endsWith(`/${under}`) : uri === shapeUri;
  });

export interface LegacyStarterItem {
  section: 'agents' | 'layers' | 'sources';
  id: string;
  /** Set for a project's own source (`projects[projectId].sources`). */
  projectId?: string;
}

export interface LegacyStarterRemoval {
  removed: LegacyStarterItem[];
  /** The starter executor added because no enabled executor remained. */
  addedExecutor: boolean;
}

/**
 * The starter items still in `config`, exactly as seeded. One that anything kept still uses (an agent
 * a project extends, a layer a kept agent reads, a source a kept layer or Warden reads) stays.
 */
export function findLegacyStarter(config: FoundryConfig): LegacyStarterItem[] {
  const projects = Object.values(config.projects ?? {});
  const agents = Object.entries(config.agents ?? {}).filter(
    ([id, agent]) =>
      matches(agent, LEGACY_AGENTS[id]) &&
      !projects.some((project) => {
        const own = project.agents?.[id] as { extends?: string } | undefined;
        return (
          !!own ||
          Object.values(project.agents ?? {}).some(
            (a) => (a as { extends?: string }).extends === id,
          )
        );
      }),
  );
  const goneAgents = new Set(agents.map(([id]) => id));
  const keptAgents = [
    ...Object.entries(config.agents ?? {})
      .filter(([id]) => !goneAgents.has(id))
      .map(([, agent]) => agent as Partial<AgentSettingsConfig>),
    ...projects.flatMap((project) =>
      Object.values(project.agents ?? {}).map((agent) => agent as Partial<AgentSettingsConfig>),
    ),
  ];
  const starterSource = (id: string) =>
    !config.sources?.[id] || sourceMatches(config.sources[id], LEGACY_SOURCES[id]);
  const layers = Object.entries(config.layers ?? {}).filter(
    ([id, layer]) =>
      matches(layer, LEGACY_LAYERS[id]) &&
      // A layer over an edited source still delivers what the user edited; it stays with it.
      layer.sourceIds.every(starterSource) &&
      !keptAgents.some(
        (agent) => agent.visibleLayers?.includes(id) || agent.ownedLayers?.includes(id),
      ) &&
      !projects.some((project) => project.layers?.[id]),
  );
  const goneLayers = new Set(layers.map(([id]) => id));
  const keptLayers = [
    ...Object.entries(config.layers ?? {})
      .filter(([id]) => !goneLayers.has(id))
      .map(([, layer]) => layer as Partial<LayerSettingsConfig>),
    ...projects.flatMap((project) =>
      Object.values(project.layers ?? {}).map((layer) => layer as Partial<LayerSettingsConfig>),
    ),
  ];
  const used = (id: string) =>
    keptLayers.some((layer) => layer.sourceIds?.includes(id)) ||
    keptAgents.some((agent) => agent.domainKnowledge?.includes(id));
  const sources = Object.entries(config.sources ?? {}).filter(
    ([id, source]) => sourceMatches(source, LEGACY_SOURCES[id]) && !used(id),
  );
  const projectSources = Object.entries(config.projects ?? {}).flatMap(([projectId, project]) =>
    Object.entries(project.sources ?? {})
      .filter(([id, source]) => {
        const shape = LEGACY_PROJECT_SOURCES[id];
        return (
          !!shape &&
          !used(id) &&
          isDeepStrictEqual(canonical(source), {
            id,
            type: 'markdown',
            label: shape.label,
            uri: `${project.path.replace(/\/+$/, '')}/${shape.dir}`,
          })
        );
      })
      .map(([id]) => ({ section: 'sources' as const, id, projectId })),
  );
  return [
    ...agents.map(([id]) => ({ section: 'agents' as const, id })),
    ...layers.map(([id]) => ({ section: 'layers' as const, id })),
    ...sources.map(([id]) => ({ section: 'sources' as const, id })),
    ...projectSources,
  ];
}

/**
 * Remove the starter items `findLegacyStarter` finds from `config`, in place. When that removes the
 * last enabled executor, the starter executor takes their place.
 */
export function removeLegacyStarter(config: FoundryConfig): LegacyStarterRemoval {
  const removed = findLegacyStarter(config);
  const removedExecutor = removed.some(
    (item) => item.section === 'agents' && config.agents[item.id]?.kind === 'executor',
  );
  for (const item of removed) {
    if (item.projectId) delete config.projects[item.projectId]?.sources?.[item.id];
    else delete config[item.section][item.id];
  }
  const addedExecutor =
    removedExecutor &&
    !config.agents[DEFAULT_EXECUTOR_ID] &&
    !Object.values(config.agents).some((agent) => agent.kind === 'executor' && agent.enabled);
  if (addedExecutor) Object.assign(config.agents, defaultAgents());
  return { removed, addedExecutor };
}

/** One line per item: `agents.classifier`, `projects.<id>.sources.project-docs`. */
export function describeLegacyItem(item: LegacyStarterItem): string {
  return item.projectId
    ? `projects.${item.projectId}.sources.${item.id}`
    : `${item.section}.${item.id}`;
}
