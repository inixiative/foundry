import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ChorusLayerRegions,
  type ChorusRegion,
  chorusLayers,
  composeChorus,
  countRegions,
  type MissingRegionDoc,
  missingRegionDocs,
  REPOSITORY_SETTINGS_FILE,
  type RegionRole,
  type RegionSummary,
  regionWardens,
} from '../agents/region-roster';
import { DEFAULT_STAGES, type StageConfig, validateStages } from '../classify';
import {
  type AgentExtension,
  type AgentSettingsConfig,
  type BrowserConfig,
  type BrowserConfigOverride,
  type ChorusSettings,
  type FoundryConfig,
  type InvocationCondition,
  type InvocationConditionOverride,
  isAgentExtension,
  type LayerSettingsConfig,
  type LayerSettingsOverride,
  type ListPatch,
  type ProjectSettingsConfig,
  validateChorusSettings,
} from './config';

export type MergeOrigin = 'global' | 'project' | 'merged';
export type MergeStrategy =
  | 'inherit'
  | 'override'
  | 'replace'
  | 'merge'
  | 'extend'
  | 'clear'
  | 'project-only'
  /** Derived from the project's regions directory, never written in settings. */
  | 'generated';

/** Where one composed chunk of a resolved value came from. */
export interface ChunkProvenance {
  origin: 'global' | 'project';
  /** Global agent or layer id, or project id. */
  from: string;
  heading: string;
  value: unknown;
}

export interface FieldProvenance {
  origin: MergeOrigin;
  strategy: MergeStrategy;
  globalValue?: unknown;
  projectValue?: unknown;
  resolvedValue: unknown;
  /** Composed values only: each chunk, in order. */
  chunks?: ChunkProvenance[];
}

export interface ResolvedAgentDefinition {
  id: string;
  scope: 'global' | 'project-extension' | 'project-standalone' | 'project-generated';
  /** The global agent a project extension composes with. */
  extends?: string;
  /** A generated region Warden: the `region.json` it was derived from. */
  generatedFrom?: string;
  config: AgentSettingsConfig;
  fields: Record<string, FieldProvenance>;
}

/** Which layer a project setting's value came from: personal settings cascade over the repository's, over the default. */
export type SettingLayer = 'settings' | 'repository' | 'default';

/** The chorus a project view carries: whether its region Wardens run, what they were built from, and why. */
export interface ResolvedChorus {
  /** Whether region Wardens run: the chorus is enabled and its layers held regions. Off, the project has no Wardens. */
  on: boolean;
  /** What was asked for (`chorus.enabled`; false when neither the settings nor the repository say). */
  enabled: boolean;
  /** Which layer `chorus.enabled` came from: the machine's (personal) project settings, the repository's `.foundry/project.json`, or neither. */
  enabledBy: SettingLayer;
  /** Which layer the directories (`regions` or `layers`, one unit) came from. */
  directoriesFrom: SettingLayer;
  /** The consumed trigger: whether it is on, and which layer said so. */
  consumed: { enabled: boolean; from: SettingLayer };
  /** The reception charter: whether threads of this chorus hold it, and which layer said so. */
  reception: { on: boolean; from: SettingLayer };
  /**
   * How each role's regions classify: the resolved stages (defaults filled) and which layer gave
   * them. Heralds are not built: their regions never run, and `built: false` says so.
   */
  roles: {
    warden: { stages: readonly StageConfig[]; from: SettingLayer; regions: number };
    herald: { stages: readonly StageConfig[]; from: SettingLayer; regions: number; built: false };
  };
  /** Docs a region lacks for its role's stages: while any is missing the chorus is not built. */
  missingDocs?: MissingRegionDoc[];
  /** The repository's `.foundry/project.json`, when it exists: what it said, or why it was not read. */
  repository?: { file: string; chorus?: ChorusSettings; error?: string };
  /** Regions present in the configured layers but not run, because the chorus is not enabled. */
  available?: number;
  /** When enabled: each layer as read, in order, missing or empty directories included. */
  layers: ChorusLayerRegions[];
  /** The composed chorus, in id order: each region with the layer it came from. */
  regions: ChorusRegion[];
  /** Why no Warden runs although regions were asked for or are present: nothing is skipped silently. */
  reason?: string;
}

export interface ResolvedLayerDefinition {
  id: string;
  scope: 'global' | 'project-override' | 'project-only';
  config: LayerSettingsConfig;
  fields: Record<string, FieldProvenance>;
}

export interface ResolvedProjectView {
  config: FoundryConfig;
  layers: ResolvedLayerDefinition[];
  agents: ResolvedAgentDefinition[];
  chorus: ResolvedChorus;
}

/**
 * A region Warden in the project view: a standalone project agent whose every field was derived from
 * its region (`region.json`, `knowledge.md`); its provenance says so, per field.
 */
function generatedAgent(
  agent: AgentSettingsConfig,
  region: RegionSummary,
): ResolvedAgentDefinition {
  const fields: Record<string, FieldProvenance> = {};
  for (const [key, value] of Object.entries(agent))
    if (key !== 'id')
      fields[key] = {
        origin: 'project',
        strategy: 'generated',
        projectValue: value,
        resolvedValue: value,
        chunks: [{ origin: 'project', from: region.path, heading: `Region ${region.id}`, value }],
      };
  return {
    id: agent.id,
    scope: 'project-generated',
    generatedFrom: region.path,
    config: agent,
    fields,
  };
}

function dedupe<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function isListPatch<T>(value: unknown): value is ListPatch<T> {
  return !!value && !Array.isArray(value) && typeof value === 'object';
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return Object.fromEntries(entries) as T;
}

function validateListPatch<T>(
  value: ListPatch<T> | undefined,
  label: string,
): ListPatch<T> | undefined {
  if (value === undefined) return undefined;
  if (!isListPatch<T>(value)) {
    throw new Error(
      `[config] ${label} must use explicit list patch syntax: { replace: [...] } or { append/remove: [...] }`,
    );
  }

  const record = value as Record<string, unknown>;
  const hasReplace = 'replace' in record;
  const hasAppend = 'append' in record;
  const hasRemove = 'remove' in record;

  if (!hasReplace && !hasAppend && !hasRemove) {
    throw new Error(`[config] ${label} must include replace, append, or remove`);
  }
  if (hasReplace && (hasAppend || hasRemove)) {
    throw new Error(`[config] ${label} cannot mix replace with append/remove`);
  }
  if (hasReplace && !Array.isArray(record.replace)) {
    throw new Error(`[config] ${label}.replace must be an array`);
  }
  if (hasAppend && !Array.isArray(record.append)) {
    throw new Error(`[config] ${label}.append must be an array`);
  }
  if (hasRemove && !Array.isArray(record.remove)) {
    throw new Error(`[config] ${label}.remove must be an array`);
  }
  if (
    !hasReplace &&
    !(record.append as unknown[] | undefined)?.length &&
    !(record.remove as unknown[] | undefined)?.length
  ) {
    throw new Error(`[config] ${label} must append or remove at least one value`);
  }

  return value;
}

function scalarField<T>(
  base: T | undefined,
  override: T | undefined,
  scope: ResolvedLayerDefinition['scope'] | 'agent-override' | 'agent-only',
): { value: T | undefined; provenance: FieldProvenance } {
  if (override === undefined) {
    return {
      value: base,
      provenance: {
        origin: scope === 'project-only' || scope === 'agent-only' ? 'project' : 'global',
        strategy: scope === 'project-only' || scope === 'agent-only' ? 'project-only' : 'inherit',
        globalValue: base,
        resolvedValue: base,
      },
    };
  }

  return {
    value: override,
    provenance: {
      origin: base === undefined ? 'project' : 'project',
      strategy: base === undefined ? 'project-only' : 'override',
      globalValue: base,
      projectValue: override,
      resolvedValue: override,
    },
  };
}

function listField<T>(
  base: T[] | undefined,
  override: ListPatch<T> | undefined,
  scope: ResolvedLayerDefinition['scope'] | 'agent-override' | 'agent-only',
  label: string,
): { value: T[] | undefined; provenance: FieldProvenance } {
  const patch = validateListPatch(override, label);

  if (patch === undefined) {
    return {
      value: base ? [...base] : base,
      provenance: {
        origin: scope === 'project-only' || scope === 'agent-only' ? 'project' : 'global',
        strategy: scope === 'project-only' || scope === 'agent-only' ? 'project-only' : 'inherit',
        globalValue: base,
        resolvedValue: base,
      },
    };
  }

  if ('replace' in patch) {
    const replaced = dedupe(patch.replace);
    return {
      value: replaced,
      provenance: {
        origin: 'project',
        strategy: base === undefined ? 'project-only' : 'replace',
        globalValue: base,
        projectValue: patch,
        resolvedValue: replaced,
      },
    };
  }

  if (base === undefined && !patch.append?.length) {
    throw new Error(`[config] ${label} cannot remove from an undefined base list`);
  }

  let current = base ? [...base] : [];

  if (patch.append?.length) {
    current = dedupe([...current, ...patch.append]);
  }

  if (patch.remove?.length) {
    const removals = new Set(patch.remove);
    current = current.filter((item) => !removals.has(item));
  }

  const result = current.length > 0 ? current : base === undefined ? undefined : current;

  return {
    value: result,
    provenance: {
      origin: base === undefined ? 'project' : 'merged',
      strategy: base === undefined ? 'project-only' : 'merge',
      globalValue: base,
      projectValue: patch,
      resolvedValue: result,
    },
  };
}

function conditionField(
  base: InvocationCondition | undefined,
  override: InvocationConditionOverride | null | undefined,
  scope: ResolvedLayerDefinition['scope'] | 'agent-override' | 'agent-only',
  label: string,
): { value: InvocationCondition | undefined; provenance: FieldProvenance } {
  if (override === undefined) {
    return {
      value: base ? { ...base } : undefined,
      provenance: {
        origin: scope === 'project-only' || scope === 'agent-only' ? 'project' : 'global',
        strategy: scope === 'project-only' || scope === 'agent-only' ? 'project-only' : 'inherit',
        globalValue: base,
        resolvedValue: base,
      },
    };
  }

  if (override === null) {
    return {
      value: undefined,
      provenance: {
        origin: 'project',
        strategy: 'clear',
        globalValue: base,
        projectValue: null,
        resolvedValue: undefined,
      },
    };
  }

  const categories = listField(base?.categories, override.categories, scope, `${label}.categories`);
  const tags = listField(base?.tags, override.tags, scope, `${label}.tags`);
  const routes = listField(base?.routes, override.routes, scope, `${label}.routes`);

  const value = pruneUndefined({
    categories: categories.value,
    tags: tags.value,
    routes: routes.value,
  }) as InvocationCondition;

  const hasAny = Object.keys(value).length > 0;
  const origin = [categories, tags, routes].some((f) => f.provenance.origin === 'merged')
    ? 'merged'
    : [categories, tags, routes].some((f) => f.provenance.origin === 'project')
      ? 'project'
      : 'global';
  const strategy = [categories, tags, routes].some((f) => f.provenance.strategy === 'merge')
    ? 'merge'
    : base === undefined
      ? 'project-only'
      : 'override';

  return {
    value: hasAny ? value : undefined,
    provenance: {
      origin,
      strategy,
      globalValue: base,
      projectValue: override,
      resolvedValue: hasAny ? value : undefined,
    },
  };
}

function browserField(
  base: BrowserConfig | undefined,
  override: BrowserConfigOverride | null | undefined,
  scope: ResolvedLayerDefinition['scope'] | 'agent-override' | 'agent-only',
  label: string,
): { value: BrowserConfig | undefined; provenance: FieldProvenance } {
  if (override === undefined) {
    return {
      value: base ? { ...base } : undefined,
      provenance: {
        origin: scope === 'project-only' || scope === 'agent-only' ? 'project' : 'global',
        strategy: scope === 'project-only' || scope === 'agent-only' ? 'project-only' : 'inherit',
        globalValue: base,
        resolvedValue: base,
      },
    };
  }

  if (override === null) {
    return {
      value: undefined,
      provenance: {
        origin: 'project',
        strategy: 'clear',
        globalValue: base,
        projectValue: null,
        resolvedValue: undefined,
      },
    };
  }

  const mode = scalarField(base?.mode, override.mode, scope);
  const shareSession = scalarField(base?.shareSession, override.shareSession, scope);
  const screenshots = scalarField(base?.screenshots, override.screenshots, scope);
  const maxNavigations = scalarField(base?.maxNavigations, override.maxNavigations, scope);
  const allowedUrls = listField(
    base?.allowedUrls,
    override.allowedUrls,
    scope,
    `${label}.allowedUrls`,
  );
  const blockedUrls = listField(
    base?.blockedUrls,
    override.blockedUrls,
    scope,
    `${label}.blockedUrls`,
  );

  const value = pruneUndefined({
    mode: mode.value,
    shareSession: shareSession.value,
    screenshots: screenshots.value,
    maxNavigations: maxNavigations.value,
    allowedUrls: allowedUrls.value,
    blockedUrls: blockedUrls.value,
  }) as BrowserConfig;

  const hasAny = Object.keys(value).length > 0;
  const origin = [mode, shareSession, screenshots, maxNavigations, allowedUrls, blockedUrls].some(
    (f) => f.provenance.origin === 'merged',
  )
    ? 'merged'
    : [mode, shareSession, screenshots, maxNavigations, allowedUrls, blockedUrls].some(
          (f) => f.provenance.origin === 'project',
        )
      ? 'project'
      : 'global';
  const strategy = [allowedUrls, blockedUrls].some((f) => f.provenance.strategy === 'merge')
    ? 'merge'
    : base === undefined
      ? 'project-only'
      : 'override';

  return {
    value: hasAny ? value : undefined,
    provenance: {
      origin,
      strategy,
      globalValue: base,
      projectValue: override,
      resolvedValue: hasAny ? value : undefined,
    },
  };
}

const projectName = (projectId: string, project: ProjectSettingsConfig) =>
  project.label || projectId;

/** Concatenates chunks under a heading each; a single chunk stands alone. */
export function composeChunks(chunks: ReadonlyArray<{ heading: string; text: string }>): string {
  const present = chunks.filter((chunk) => chunk.text.trim());
  if (present.length < 2) return present[0]?.text ?? '';
  return present.map((chunk) => `## ${chunk.heading}\n\n${chunk.text.trim()}`).join('\n\n');
}

function globalAgent(id: string, agent: AgentSettingsConfig): ResolvedAgentDefinition {
  const fields: Record<string, FieldProvenance> = {};
  for (const [key, value] of Object.entries(agent))
    if (key !== 'id')
      fields[key] = {
        origin: 'global',
        strategy: 'inherit',
        globalValue: value,
        resolvedValue: value,
      };
  return { id, scope: 'global', config: agent, fields };
}

function standaloneAgent(
  id: string,
  agent: AgentSettingsConfig,
  base: AgentSettingsConfig | undefined,
): ResolvedAgentDefinition {
  if (
    typeof agent.kind !== 'string' ||
    typeof agent.prompt !== 'string' ||
    !Array.isArray(agent.visibleLayers) ||
    !Array.isArray(agent.peers) ||
    typeof agent.maxDepth !== 'number' ||
    typeof agent.enabled !== 'boolean'
  )
    throw new Error(
      `[config] project agent ${JSON.stringify(id)} is standalone and needs a full definition (kind, prompt, visibleLayers, peers, maxDepth, enabled), or "extends" a global agent`,
    );
  const config = { ...agent, id };
  const fields: Record<string, FieldProvenance> = {};
  for (const [key, value] of Object.entries(config))
    if (key !== 'id')
      fields[key] = {
        origin: 'project',
        strategy: base ? 'replace' : 'project-only',
        ...(base ? { globalValue: (base as unknown as Record<string, unknown>)[key] } : {}),
        projectValue: value,
        resolvedValue: value,
      };
  return { id, scope: 'project-standalone', config, fields };
}

const EXTENSION_KEYS = new Set([
  'extends',
  'prompt',
  'domainKnowledge',
  'override',
  'provider',
  'model',
  'temperature',
  'maxDepth',
  'tools',
  'thinking',
  'permissions',
  'executionEnv',
  'timeout',
  'cacheControl',
  'enabled',
  'invocation',
  'description',
  'visibleLayers',
  'guardTriggers',
  'peers',
  'browser',
  'condition',
]);

/** A project agent extending a global one. Instructions compose here; domain knowledge on its layer. */
function extendAgent(
  id: string,
  base: AgentSettingsConfig,
  extension: AgentExtension,
  projectId: string,
  project: ProjectSettingsConfig,
  known: ReadonlySet<string>,
): ResolvedAgentDefinition {
  const scope = 'agent-override';
  const fields: Record<string, FieldProvenance> = {};
  const resolved: AgentSettingsConfig = { ...base, id };
  const label = `project.agents.${id}`;
  for (const key of Object.keys(extension))
    if (!EXTENSION_KEYS.has(key))
      throw new Error(
        `[config] ${label}.${key} cannot be set on an extension; identity comes from ${JSON.stringify(extension.extends)}`,
      );
  const overrides = new Set(extension.override ?? []);
  for (const chunk of overrides)
    if (chunk !== 'instructions' && chunk !== 'domainKnowledge')
      throw new Error(`[config] ${label}.override names unknown chunk ${JSON.stringify(chunk)}`);
  if (overrides.has('instructions') && typeof extension.prompt !== 'string')
    throw new Error(`[config] ${label} overrides instructions without a prompt`);

  const chunks: ChunkProvenance[] = [
    ...(overrides.has('instructions')
      ? []
      : [
          {
            origin: 'global' as const,
            from: extension.extends,
            heading: `Global instructions (${extension.extends})`,
            value: base.prompt,
          },
        ]),
    ...(extension.prompt?.trim()
      ? [
          {
            origin: 'project' as const,
            from: projectId,
            heading: `Project instructions (${projectName(projectId, project)})`,
            value: extension.prompt,
          },
        ]
      : []),
  ];
  resolved.prompt = composeChunks(
    chunks.map((chunk) => ({ heading: chunk.heading, text: String(chunk.value) })),
  );
  fields.prompt = {
    origin: chunks.every((chunk) => chunk.origin === 'global')
      ? 'global'
      : chunks.every((chunk) => chunk.origin === 'project')
        ? 'project'
        : 'merged',
    strategy: overrides.has('instructions')
      ? 'override'
      : extension.prompt?.trim()
        ? 'extend'
        : 'inherit',
    globalValue: base.prompt,
    ...(extension.prompt !== undefined ? { projectValue: extension.prompt } : {}),
    resolvedValue: resolved.prompt,
    chunks,
  };

  const knowledge = domainKnowledgeField(extension, base, projectId, project, label, known);
  if (knowledge) {
    resolved.domainKnowledge = knowledge.value;
    fields.domainKnowledge = knowledge.provenance;
  }

  const scalars = [
    'provider',
    'model',
    'temperature',
    'maxDepth',
    'tools',
    'thinking',
    'permissions',
    'executionEnv',
    'timeout',
    'cacheControl',
    'enabled',
    'invocation',
    'description',
  ] as const;
  const target = resolved as unknown as Record<string, unknown>;
  for (const key of scalars) {
    const field = scalarField<unknown>(base[key], extension[key], scope);
    if (field.value === undefined) delete target[key];
    else target[key] = field.value;
    fields[key] = field.provenance;
  }
  const visibleLayers = listField(
    base.visibleLayers,
    extension.visibleLayers,
    scope,
    `${label}.visibleLayers`,
  );
  resolved.visibleLayers = visibleLayers.value ?? [];
  fields.visibleLayers = visibleLayers.provenance;
  const guardTriggers = listField(
    base.guardTriggers,
    extension.guardTriggers,
    scope,
    `${label}.guardTriggers`,
  );
  if (guardTriggers.value === undefined) delete resolved.guardTriggers;
  else resolved.guardTriggers = guardTriggers.value;
  fields.guardTriggers = guardTriggers.provenance;
  const peers = listField(base.peers, extension.peers, scope, `${label}.peers`);
  resolved.peers = peers.value ?? [];
  fields.peers = peers.provenance;
  const browser = browserField(base.browser, extension.browser, scope, `${label}.browser`);
  if (browser.value === undefined) delete resolved.browser;
  else resolved.browser = browser.value;
  fields.browser = browser.provenance;
  const condition = conditionField(
    base.condition,
    extension.condition,
    scope,
    `${label}.condition`,
  );
  if (condition.value === undefined) delete resolved.condition;
  else resolved.condition = condition.value;
  fields.condition = condition.provenance;
  return { id, scope: 'project-extension', extends: extension.extends, config: resolved, fields };
}

/** The extension's domain knowledge sources appended to (or, with `override`, replacing) the parent's. */
function domainKnowledgeField(
  extension: AgentExtension,
  base: AgentSettingsConfig,
  projectId: string,
  project: ProjectSettingsConfig,
  label: string,
  known: ReadonlySet<string>,
): { value: string[]; provenance: FieldProvenance } | undefined {
  const override = extension.override?.includes('domainKnowledge') ?? false;
  if (extension.domainKnowledge === undefined) {
    if (override) throw new Error(`[config] ${label} overrides domainKnowledge without sources`);
    return undefined;
  }
  if (
    !Array.isArray(extension.domainKnowledge) ||
    extension.domainKnowledge.some((id) => typeof id !== 'string' || !id)
  )
    throw new Error(`[config] ${label}.domainKnowledge must be source ids`);
  const unknown = extension.domainKnowledge.filter((id) => !known.has(id));
  if (unknown.length)
    throw new Error(
      `[config] ${label}.domainKnowledge names unknown sources: ${unknown.join(', ')}`,
    );
  const inherited = base.domainKnowledge ?? [];
  // A source the parent already loads is not loaded twice.
  const added = [...new Set(extension.domainKnowledge)].filter(
    (id) => override || !inherited.includes(id),
  );
  const value = override ? added : [...inherited, ...added];
  return {
    value,
    provenance: {
      origin: override || !inherited.length ? 'project' : 'merged',
      strategy: override ? 'override' : 'extend',
      globalValue: inherited,
      projectValue: extension.domainKnowledge,
      resolvedValue: value,
      chunks: [
        ...(override || !inherited.length
          ? []
          : [
              {
                origin: 'global' as const,
                from: extension.extends,
                heading: `Global domain knowledge (${extension.extends})`,
                value: inherited,
              },
            ]),
        {
          origin: 'project' as const,
          from: projectId,
          heading: `Project domain knowledge (${projectName(projectId, project)})`,
          value: added,
        },
      ],
    },
  };
}

function resolveLayerDefinition(
  id: string,
  base: LayerSettingsConfig | undefined,
  override: LayerSettingsOverride | undefined,
): ResolvedLayerDefinition {
  const scope: ResolvedLayerDefinition['scope'] = base
    ? override
      ? 'project-override'
      : 'global'
    : 'project-only';

  const project = override ?? {};
  const resolved: Partial<LayerSettingsConfig> = { id };
  const fields: Record<string, FieldProvenance> = {};

  const domain = scalarField(base?.domain, project.domain, scope);
  resolved.domain = domain.value;
  fields.domain = domain.provenance;

  const prompt = scalarField(base?.prompt, project.prompt, scope);
  resolved.prompt = prompt.value;
  fields.prompt = prompt.provenance;

  // Content segment follows the same scalar policy as every other layer field
  // (inherit, override, project-only). The key is written only when a value is
  // declared, so legacy definitions without metadata stay without it.
  const segment = scalarField(base?.segment, project.segment, scope);
  if (segment.value !== undefined) resolved.segment = segment.value;
  fields.segment = segment.provenance;

  const sourceIds = listField(
    base?.sourceIds,
    project.sourceIds,
    scope,
    `project.layers.${id}.sourceIds`,
  );
  resolved.sourceIds = sourceIds.value ?? [];
  fields.sourceIds = sourceIds.provenance;

  const staleness = scalarField(base?.staleness, project.staleness, scope);
  resolved.staleness = staleness.value;
  fields.staleness = staleness.provenance;

  const writers = listField(base?.writers, project.writers, scope, `project.layers.${id}.writers`);
  resolved.writers = writers.value;
  fields.writers = writers.provenance;

  const enabled = scalarField(base?.enabled, project.enabled, scope);
  resolved.enabled = enabled.value;
  fields.enabled = enabled.provenance;

  const activation = scalarField(base?.activation, project.activation, scope);
  resolved.activation = activation.value;
  fields.activation = activation.provenance;

  const condition = conditionField(
    base?.condition,
    project.condition,
    scope,
    `project.layers.${id}.condition`,
  );
  resolved.condition = condition.value;
  fields.condition = condition.provenance;

  return {
    id,
    scope,
    config: resolved as LayerSettingsConfig,
    fields,
  };
}

/**
 * The repository's own settings (`<project>/.foundry/project.json`): `{ "chorus"?, "$comment"? }`. A
 * file that is missing reads as none; one that is malformed is reported, not thrown, so a repository's
 * checkout never stops the daemon or turns its chorus on.
 */
export function readRepositorySettings(
  projectPath: string,
): { file: string; chorus?: ChorusSettings; error?: string } | undefined {
  const file = join(projectPath, REPOSITORY_SETTINGS_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw Error('must be an object: { "chorus"? }');
    const settings = raw as Record<string, unknown>;
    for (const key of Object.keys(settings))
      if (key !== 'chorus' && key !== '$comment')
        throw Error(`${key} is not a repository setting (chorus, $comment)`);
    validateChorusSettings('chorus', settings.chorus);
    return settings.chorus === undefined
      ? { file }
      : { file, chorus: settings.chorus as ChorusSettings };
  } catch (error) {
    return { file, error: (error as Error).message };
  }
}

/**
 * A project's chorus setting: the machine's project settings over the repository's `chorus`, key by
 * key. `enabled` from whichever says it; the directories (`regions` or `layers`, one unit) likewise.
 */
export function projectChorus(project: Pick<ProjectSettingsConfig, 'path' | 'chorus'>): {
  chorus: ChorusSettings;
  enabledBy: SettingLayer;
  directoriesFrom: SettingLayer;
  consumedFrom: SettingLayer;
  receptionFrom: SettingLayer;
  /** Per role: the stage list as written (the machine's replaces the repository's whole), and its layer. */
  stagesFrom: Record<RegionRole, SettingLayer>;
  repository?: ResolvedChorus['repository'];
} {
  const repository = readRepositorySettings(project.path);
  const mine = project.chorus ?? {};
  const theirs = repository?.chorus ?? {};
  const where = (c: ChorusSettings): ChorusSettings =>
    c.layers ? { layers: c.layers } : c.regions ? { regions: c.regions } : {};
  const directories = mine.layers || mine.regions ? where(mine) : where(theirs);
  const enabled = mine.enabled ?? theirs.enabled;
  // The consumed trigger merges key by key too: the machine's `enabled`, `tools`, `paths` or `maxChars` over the repository's.
  const consumed =
    mine.consumed || theirs.consumed ? { ...theirs.consumed, ...mine.consumed } : undefined;
  const reception = mine.reception ?? theirs.reception;
  const from = (mineSet: boolean, theirsSet: boolean): SettingLayer =>
    mineSet ? 'settings' : theirsSet ? 'repository' : 'default';
  // A role's stages are one unit: the machine's list replaces the repository's whole.
  const wardens = mine.wardens?.stages ?? theirs.wardens?.stages;
  const heralds = mine.heralds?.stages ?? theirs.heralds?.stages;
  return {
    chorus: {
      ...(enabled !== undefined ? { enabled } : {}),
      ...directories,
      ...(consumed ? { consumed } : {}),
      ...(reception !== undefined ? { reception } : {}),
      ...(wardens ? { wardens: { stages: wardens } } : {}),
      ...(heralds ? { heralds: { stages: heralds } } : {}),
    },
    stagesFrom: {
      warden: from(mine.wardens?.stages !== undefined, theirs.wardens?.stages !== undefined),
      herald: from(mine.heralds?.stages !== undefined, theirs.heralds?.stages !== undefined),
    },
    // Whether the trigger is on is what the view reports, so its provenance is the `enabled` key's.
    consumedFrom: from(
      mine.consumed?.enabled !== undefined,
      theirs.consumed?.enabled !== undefined,
    ),
    receptionFrom: from(mine.reception !== undefined, theirs.reception !== undefined),
    enabledBy: from(mine.enabled !== undefined, theirs.enabled !== undefined),
    directoriesFrom:
      mine.layers || mine.regions
        ? 'settings'
        : theirs.layers || theirs.regions
          ? 'repository'
          : 'default',
    ...(repository ? { repository } : {}),
  };
}

/** A role's stages as written, defaults filled; absent, today's single-stage Warden. */
function stagesOf(written: unknown): readonly StageConfig[] {
  return written === undefined ? DEFAULT_STAGES : validateStages('stages', written);
}

export function resolveProjectView(
  config: FoundryConfig,
  projectId: string,
): ResolvedProjectView | null {
  const project = config.projects[projectId];
  if (!project) return null;

  const resolved: FoundryConfig = {
    ...(config.learning !== undefined ? { learning: structuredClone(config.learning) } : {}),
    ...(config.composition !== undefined
      ? { composition: structuredClone(config.composition) }
      : {}),
    defaults: { ...config.defaults, ...project.defaults },
    vendors: config.vendors,
    agents: { ...config.agents },
    layers: { ...config.layers },
    sources: { ...config.sources, ...project.sources },
    projects: config.projects,
  };

  // The chorus: one generated Warden per composed region, the only Wardens there are (settings declare
  // none: the hand-named roster was retired on 2026-10-17). Opt-in (Aron, 2026-10-16): region Wardens
  // run only when the settings or the repository's `.foundry/project.json` enable them; regions merely
  // present are reported as off, and a project without them has no chorus.
  const setting = projectChorus(project);
  const enabled = setting.chorus.enabled === true;
  const configuredLayers = chorusLayers({ path: project.path, chorus: setting.chorus });
  const asked = {
    enabled,
    enabledBy: setting.enabledBy,
    directoriesFrom: setting.directoriesFrom,
    consumed: { enabled: setting.chorus.consumed?.enabled === true, from: setting.consumedFrom },
    // Settled below, once what runs is known: the reception charter goes with a running chorus.
    reception: { on: false, from: setting.receptionFrom },
    roles: {
      warden: {
        stages: stagesOf(setting.chorus.wardens?.stages),
        from: setting.stagesFrom.warden,
        regions: 0,
      },
      herald: {
        stages: stagesOf(setting.chorus.heralds?.stages),
        from: setting.stagesFrom.herald,
        regions: 0,
        built: false as const,
      },
    },
    ...(setting.repository ? { repository: setting.repository } : {}),
  };
  const unread = setting.repository?.error
    ? `; ${setting.repository.file} was not read (${setting.repository.error})`
    : '';
  const dirs = configuredLayers.map((l) => l.regionsDir).join(', ');
  let chorus: ResolvedChorus = { on: false, ...asked, layers: [], regions: [] };
  let generated: ReturnType<typeof regionWardens> = [];
  if (enabled) {
    const composed = composeChorus(configuredLayers);
    const wardenRegions = composed.regions.filter((r) => r.role === 'warden');
    const heraldRegions = composed.regions.filter((r) => r.role === 'herald');
    const roles = {
      warden: { ...asked.roles.warden, regions: wardenRegions.length },
      herald: { ...asked.roles.herald, regions: heraldRegions.length },
    };
    // Checked on the composed chorus: a later layer's region replaces an earlier one whole, docs included.
    const missingDocs = missingRegionDocs(wardenRegions, () => roles.warden.stages);
    const heralds = heraldRegions.length
      ? `; ${heraldRegions.length} Herald region${heraldRegions.length === 1 ? '' : 's'} (${heraldRegions.map((r) => r.id).join(', ')}) not run: Heralds are not built`
      : '';
    chorus = missingDocs.length
      ? {
          on: false,
          ...asked,
          roles,
          ...composed,
          missingDocs,
          reason: `the chorus is not built: ${missingDocs.map((m) => `region ${m.region} has no ${m.doc} (stage ${m.stages.map((i) => i + 1).join(', ')} of chorus.wardens.stages)`).join('; ')}${heralds}${unread}`,
        }
      : wardenRegions.length
        ? {
            on: true,
            ...asked,
            roles,
            ...composed,
            ...(heralds ? { reason: heralds.slice(2) } : {}),
          }
        : {
            on: false,
            ...asked,
            roles,
            ...composed,
            reason: `${heraldRegions.length ? `no Warden regions at ${dirs}${heralds}` : `no regions at ${dirs} (no <id>/region.json)`}; this project has no chorus${unread}`,
          };
    generated = chorus.on ? regionWardens(wardenRegions, roles.warden.stages) : [];
  } else {
    const available = configuredLayers.reduce((n, l) => n + countRegions(l.regionsDir), 0);
    if (available || unread)
      chorus = {
        ...chorus,
        ...(available ? { available } : {}),
        reason: available
          ? `the chorus is off: ${available} regions at ${dirs} are not enabled (set "chorus": { "enabled": true } in ${join(project.path, REPOSITORY_SETTINGS_FILE)} or in this project's settings)${unread}`
          : `this project has no chorus${unread}`,
      };
  }
  // The view's project entry carries the effective chorus, normalized. The setting is valid and, on a
  // raw config, resolves to the same chorus (an off chorus names no layers; the layers read stay on
  // `view.chorus`). A view config itself is not re-resolvable: it carries the generated agents.
  const consumed = setting.chorus.consumed ? { consumed: setting.chorus.consumed } : {};
  // The reception charter goes with a running chorus, unless turned off.
  const receptionOn = chorus.on && setting.chorus.reception !== false;
  chorus = { ...chorus, reception: { on: receptionOn, from: setting.receptionFrom } };
  const effectiveChorus: ChorusSettings = chorus.on
    ? {
        enabled: true,
        layers: configuredLayers.map((l) => ({ label: l.label, regions: l.regionsDir })),
        ...consumed,
        ...(setting.chorus.reception !== undefined ? { reception: setting.chorus.reception } : {}),
        ...(setting.chorus.wardens ? { wardens: setting.chorus.wardens } : {}),
        ...(setting.chorus.heralds ? { heralds: setting.chorus.heralds } : {}),
      }
    : { enabled: false, ...consumed };
  const agents = new Map<string, ResolvedAgentDefinition>(
    Object.entries(config.agents).map(([id, agent]) => [id, globalAgent(id, agent)]),
  );
  const extended = new Set<string>();
  /** Superseded parent id → the project agent that replaces it as a layer writer. */
  const renamed = new Map<string, string>();
  const entries = Object.entries(project.agents ?? {});
  if (chorus.on) {
    for (const { agent, sources, region } of generated) {
      if (config.agents[agent.id])
        throw new Error(
          `[config] region ${region.id} (${region.path}) has the id of global agent ${JSON.stringify(agent.id)}`,
        );
      const taken = sources.find((source) => resolved.sources[source.id]);
      if (project.agents?.[agent.id] || taken)
        throw new Error(
          `[config] region ${region.id} (${region.path}) collides with project agent or source ${JSON.stringify(taken?.id ?? agent.id)}`,
        );
      // A Warden is a decision role: it runs on the project's decision provider and model, never on the
      // main-thread default (an agent with no model resolves to defaults.model, the executor's).
      const decision = {
        ...(resolved.defaults.classifierProvider
          ? { provider: resolved.defaults.classifierProvider }
          : {}),
        ...(resolved.defaults.classifierModel ? { model: resolved.defaults.classifierModel } : {}),
      };
      agents.set(agent.id, generatedAgent({ ...agent, ...decision }, region));
      for (const source of sources) resolved.sources[source.id] = source;
    }
    // A region Warden's instructions are its prompt and the role files for its region, not the whole
    // CLAUDE.md stack (the ladder's default for the instructions slot); its knowledge is the region.
    // A role entry written in settings for the region wins, field by field.
    const roles = { ...resolved.composition?.roles };
    for (const { agent } of generated)
      roles[agent.id] = { instructions: { general: [] }, ...roles[agent.id] };
    resolved.composition = { ...resolved.composition, roles };
  }
  // The view's project carries the effective chorus and the generated agents, so a region's settings
  // prompt is attributed per project (`prompt:agent:<region>@project:<id>`) like any project agent's.
  resolved.projects = {
    ...config.projects,
    [projectId]: {
      ...project,
      chorus: effectiveChorus,
      ...(generated.length
        ? {
            agents: {
              ...project.agents,
              ...Object.fromEntries(generated.map((g) => [g.agent.id, g.agent])),
            },
          }
        : {}),
    },
  };
  const targets = new Set(
    entries.flatMap(([, entry]) => (isAgentExtension(entry) ? [entry.extends] : [])),
  );
  for (const [id, entry] of entries) {
    if (!isAgentExtension(entry)) {
      agents.set(id, standaloneAgent(id, entry, config.agents[id]));
      continue;
    }
    const base = config.agents[entry.extends];
    if (!base)
      throw new Error(
        `[config] project.agents.${id} extends ${JSON.stringify(entry.extends)}, which is not a global agent`,
      );
    if (extended.has(entry.extends))
      throw new Error(`[config] two project agents extend ${JSON.stringify(entry.extends)}`);
    extended.add(entry.extends);
    if (id !== entry.extends && (config.agents[id] || targets.has(id)))
      throw new Error(
        `[config] project.agents.${id} extends ${JSON.stringify(entry.extends)} but its id names another agent; use the parent's id or a new one`,
      );
    // The extension is this project's version of its parent.
    if (id !== entry.extends) {
      agents.delete(entry.extends);
      renamed.set(entry.extends, id);
    }
    agents.set(
      id,
      extendAgent(id, base, entry, projectId, project, new Set(Object.keys(resolved.sources))),
    );
  }
  resolved.agents = Object.fromEntries([...agents].map(([id, agent]) => [id, agent.config]));

  const layerIds = dedupe([...Object.keys(config.layers), ...Object.keys(project.layers ?? {})]);
  const layers = layerIds.map((id) => {
    const resolvedLayer = resolveLayerDefinition(id, config.layers[id], project.layers?.[id]);
    const writers = resolvedLayer.config.writers;
    const layer =
      writers && writers.some((writer) => renamed.has(writer))
        ? {
            ...resolvedLayer,
            config: {
              ...resolvedLayer.config,
              writers: writers.map((writer) => renamed.get(writer) ?? writer),
            },
          }
        : resolvedLayer;
    return layer;
  });
  resolved.layers = Object.fromEntries(layers.map((layer) => [layer.id, layer.config]));

  return { config: resolved, layers, agents: [...agents.values()], chorus };
}
