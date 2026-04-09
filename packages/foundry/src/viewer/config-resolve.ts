import type {
  AgentSettingsConfig,
  AgentSettingsOverride,
  BrowserConfig,
  BrowserConfigOverride,
  FoundryConfig,
  InvocationCondition,
  InvocationConditionOverride,
  LayerSettingsConfig,
  LayerSettingsOverride,
  ListPatch,
} from "./config";

export type MergeOrigin = "global" | "project" | "merged";
export type MergeStrategy =
  | "inherit"
  | "override"
  | "replace"
  | "merge"
  | "clear"
  | "project-only";

export interface FieldProvenance {
  origin: MergeOrigin;
  strategy: MergeStrategy;
  globalValue?: unknown;
  projectValue?: unknown;
  resolvedValue: unknown;
}

export interface ResolvedLayerDefinition {
  id: string;
  scope: "global" | "project-override" | "project-only";
  config: LayerSettingsConfig;
  fields: Record<string, FieldProvenance>;
}

export interface ResolvedProjectView {
  config: FoundryConfig;
  layers: ResolvedLayerDefinition[];
}

function dedupe<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function isListPatch<T>(value: unknown): value is ListPatch<T> {
  return !!value && !Array.isArray(value) && typeof value === "object";
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return Object.fromEntries(entries) as T;
}

function validateListPatch<T>(value: ListPatch<T> | undefined, label: string): ListPatch<T> | undefined {
  if (value === undefined) return undefined;
  if (!isListPatch<T>(value)) {
    throw new Error(
      `[config] ${label} must use explicit list patch syntax: { replace: [...] } or { append/remove: [...] }`,
    );
  }

  const record = value as Record<string, unknown>;
  const hasReplace = "replace" in record;
  const hasAppend = "append" in record;
  const hasRemove = "remove" in record;

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
  if (!hasReplace && !(record.append as unknown[] | undefined)?.length && !(record.remove as unknown[] | undefined)?.length) {
    throw new Error(`[config] ${label} must append or remove at least one value`);
  }

  return value;
}

function scalarField<T>(
  base: T | undefined,
  override: T | undefined,
  scope: ResolvedLayerDefinition["scope"] | "agent-override" | "agent-only",
): { value: T | undefined; provenance: FieldProvenance } {
  if (override === undefined) {
    return {
      value: base,
      provenance: {
        origin: scope === "project-only" || scope === "agent-only" ? "project" : "global",
        strategy: scope === "project-only" || scope === "agent-only" ? "project-only" : "inherit",
        globalValue: base,
        resolvedValue: base,
      },
    };
  }

  return {
    value: override,
    provenance: {
      origin: base === undefined ? "project" : "project",
      strategy: base === undefined ? "project-only" : "override",
      globalValue: base,
      projectValue: override,
      resolvedValue: override,
    },
  };
}

function listField<T>(
  base: T[] | undefined,
  override: ListPatch<T> | undefined,
  scope: ResolvedLayerDefinition["scope"] | "agent-override" | "agent-only",
  label: string,
): { value: T[] | undefined; provenance: FieldProvenance } {
  const patch = validateListPatch(override, label);

  if (patch === undefined) {
    return {
      value: base ? [...base] : base,
      provenance: {
        origin: scope === "project-only" || scope === "agent-only" ? "project" : "global",
        strategy: scope === "project-only" || scope === "agent-only" ? "project-only" : "inherit",
        globalValue: base,
        resolvedValue: base,
      },
    };
  }

  if ("replace" in patch) {
    const replaced = dedupe(patch.replace);
    return {
      value: replaced,
      provenance: {
        origin: "project",
        strategy: base === undefined ? "project-only" : "replace",
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

  const result = current.length > 0 ? current : (base === undefined ? undefined : current);

  return {
    value: result,
    provenance: {
      origin: base === undefined ? "project" : "merged",
      strategy: base === undefined ? "project-only" : "merge",
      globalValue: base,
      projectValue: patch,
      resolvedValue: result,
    },
  };
}

function conditionField(
  base: InvocationCondition | undefined,
  override: InvocationConditionOverride | null | undefined,
  scope: ResolvedLayerDefinition["scope"] | "agent-override" | "agent-only",
  label: string,
): { value: InvocationCondition | undefined; provenance: FieldProvenance } {
  if (override === undefined) {
    return {
      value: base ? { ...base } : undefined,
      provenance: {
        origin: scope === "project-only" || scope === "agent-only" ? "project" : "global",
        strategy: scope === "project-only" || scope === "agent-only" ? "project-only" : "inherit",
        globalValue: base,
        resolvedValue: base,
      },
    };
  }

  if (override === null) {
    return {
      value: undefined,
      provenance: {
        origin: "project",
        strategy: "clear",
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
  const origin = [categories, tags, routes].some((f) => f.provenance.origin === "merged")
    ? "merged"
    : [categories, tags, routes].some((f) => f.provenance.origin === "project")
      ? "project"
      : "global";
  const strategy = [categories, tags, routes].some((f) => f.provenance.strategy === "merge")
    ? "merge"
    : base === undefined
      ? "project-only"
      : "override";

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
  scope: ResolvedLayerDefinition["scope"] | "agent-override" | "agent-only",
  label: string,
): { value: BrowserConfig | undefined; provenance: FieldProvenance } {
  if (override === undefined) {
    return {
      value: base ? { ...base } : undefined,
      provenance: {
        origin: scope === "project-only" || scope === "agent-only" ? "project" : "global",
        strategy: scope === "project-only" || scope === "agent-only" ? "project-only" : "inherit",
        globalValue: base,
        resolvedValue: base,
      },
    };
  }

  if (override === null) {
    return {
      value: undefined,
      provenance: {
        origin: "project",
        strategy: "clear",
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
  const allowedUrls = listField(base?.allowedUrls, override.allowedUrls, scope, `${label}.allowedUrls`);
  const blockedUrls = listField(base?.blockedUrls, override.blockedUrls, scope, `${label}.blockedUrls`);

  const value = pruneUndefined({
    mode: mode.value,
    shareSession: shareSession.value,
    screenshots: screenshots.value,
    maxNavigations: maxNavigations.value,
    allowedUrls: allowedUrls.value,
    blockedUrls: blockedUrls.value,
  }) as BrowserConfig;

  const hasAny = Object.keys(value).length > 0;
  const origin = [mode, shareSession, screenshots, maxNavigations, allowedUrls, blockedUrls]
    .some((f) => f.provenance.origin === "merged")
    ? "merged"
    : [mode, shareSession, screenshots, maxNavigations, allowedUrls, blockedUrls]
        .some((f) => f.provenance.origin === "project")
      ? "project"
      : "global";
  const strategy = [allowedUrls, blockedUrls].some((f) => f.provenance.strategy === "merge")
    ? "merge"
    : base === undefined
      ? "project-only"
      : "override";

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

function resolveAgentDefinition(
  id: string,
  base: AgentSettingsConfig | undefined,
  override: AgentSettingsOverride,
): AgentSettingsConfig {
  const scope = base ? "agent-override" : "agent-only";
  const resolved: Partial<AgentSettingsConfig> = { id };

  resolved.kind = scalarField(base?.kind, override.kind, scope).value;
  resolved.flowRole = scalarField(base?.flowRole, override.flowRole, scope).value;
  resolved.domain = scalarField(base?.domain, override.domain, scope).value;
  resolved.prompt = scalarField(base?.prompt, override.prompt, scope).value;
  resolved.provider = scalarField(base?.provider, override.provider, scope).value;
  resolved.model = scalarField(base?.model, override.model, scope).value;
  resolved.temperature = scalarField(base?.temperature, override.temperature, scope).value;
  resolved.maxTokens = scalarField(base?.maxTokens, override.maxTokens, scope).value;
  resolved.visibleLayers = listField(base?.visibleLayers, override.visibleLayers, scope, `project.agents.${id}.visibleLayers`).value ?? [];
  resolved.ownedLayers = listField(base?.ownedLayers, override.ownedLayers, scope, `project.agents.${id}.ownedLayers`).value;
  resolved.peers = listField(base?.peers, override.peers, scope, `project.agents.${id}.peers`).value ?? [];
  resolved.maxDepth = scalarField(base?.maxDepth, override.maxDepth, scope).value;
  resolved.tools = scalarField(base?.tools, override.tools, scope).value;
  resolved.thinking = scalarField(base?.thinking, override.thinking, scope).value;
  resolved.permissions = scalarField(base?.permissions, override.permissions, scope).value;
  resolved.executionEnv = scalarField(base?.executionEnv, override.executionEnv, scope).value;
  resolved.browser = browserField(base?.browser, override.browser, scope, `project.agents.${id}.browser`).value;
  resolved.timeout = scalarField(base?.timeout, override.timeout, scope).value;
  resolved.cacheControl = scalarField(base?.cacheControl, override.cacheControl, scope).value;
  resolved.enabled = scalarField(base?.enabled, override.enabled, scope).value;
  resolved.invocation = scalarField(base?.invocation, override.invocation, scope).value;
  resolved.condition = conditionField(base?.condition, override.condition, scope, `project.agents.${id}.condition`).value;

  return resolved as AgentSettingsConfig;
}

function resolveLayerDefinition(
  id: string,
  base: LayerSettingsConfig | undefined,
  override: LayerSettingsOverride | undefined,
): ResolvedLayerDefinition {
  const scope: ResolvedLayerDefinition["scope"] = base
    ? override ? "project-override" : "global"
    : "project-only";

  const project = override ?? {};
  const resolved: Partial<LayerSettingsConfig> = { id };
  const fields: Record<string, FieldProvenance> = {};

  const domain = scalarField(base?.domain, project.domain, scope);
  resolved.domain = domain.value;
  fields.domain = domain.provenance;

  const prompt = scalarField(base?.prompt, project.prompt, scope);
  resolved.prompt = prompt.value;
  fields.prompt = prompt.provenance;

  const sourceIds = listField(base?.sourceIds, project.sourceIds, scope, `project.layers.${id}.sourceIds`);
  resolved.sourceIds = sourceIds.value ?? [];
  fields.sourceIds = sourceIds.provenance;

  const trust = scalarField(base?.trust, project.trust, scope);
  resolved.trust = trust.value;
  fields.trust = trust.provenance;

  const staleness = scalarField(base?.staleness, project.staleness, scope);
  resolved.staleness = staleness.value;
  fields.staleness = staleness.provenance;

  const maxTokens = scalarField(base?.maxTokens, project.maxTokens, scope);
  resolved.maxTokens = maxTokens.value;
  fields.maxTokens = maxTokens.provenance;

  const writers = listField(base?.writers, project.writers, scope, `project.layers.${id}.writers`);
  resolved.writers = writers.value;
  fields.writers = writers.provenance;

  const enabled = scalarField(base?.enabled, project.enabled, scope);
  resolved.enabled = enabled.value;
  fields.enabled = enabled.provenance;

  const activation = scalarField(base?.activation, project.activation, scope);
  resolved.activation = activation.value;
  fields.activation = activation.provenance;

  const condition = conditionField(base?.condition, project.condition, scope, `project.layers.${id}.condition`);
  resolved.condition = condition.value;
  fields.condition = condition.provenance;

  return {
    id,
    scope,
    config: resolved as LayerSettingsConfig,
    fields,
  };
}

export function resolveProjectView(
  config: FoundryConfig,
  projectId: string,
): ResolvedProjectView | null {
  const project = config.projects[projectId];
  if (!project) return null;

  const resolved: FoundryConfig = {
    defaults: { ...config.defaults, ...project.defaults },
    providers: config.providers,
    agents: { ...config.agents },
    layers: { ...config.layers },
    sources: { ...config.sources, ...project.sources },
    projects: config.projects,
  };

  if (project.agents) {
    for (const [id, override] of Object.entries(project.agents)) {
      resolved.agents[id] = resolveAgentDefinition(id, resolved.agents[id], override);
    }
  }

  const layerIds = dedupe([
    ...Object.keys(config.layers),
    ...Object.keys(project.layers ?? {}),
  ]);
  const layers = layerIds.map((id) => resolveLayerDefinition(id, config.layers[id], project.layers?.[id]));
  resolved.layers = Object.fromEntries(layers.map((layer) => [layer.id, layer.config]));

  return { config: resolved, layers };
}
