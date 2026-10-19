/**
 * @atlas
 * @kind helper
 * @partOf feature:composition, primitive:contextLayers
 */
import {
  ContextLayer,
  type ContextSource,
  type OwnershipScope,
  type SourceSegment,
  type SourceSelectionReport,
  segmentsText,
} from '@inixiative/foundry-core';
import type { CompositionSlot } from '../prompts/instruction-settings';
import { compositionSource, forgetSharedRoleViews } from '../prompts/instruction-stack';
import type { FoundryConfig } from '../viewer/config';

/** Turns a configured source id into a ContextSource (thread-factory's `SourceResolver`). */
export type ResolveSource = (sourceId: string, config: FoundryConfig) => ContextSource | null;

/** A middleware role's two composed slots: private layers, never on the thread's stack. */
export interface RoleLayers {
  readonly instructions: ContextLayer;
  readonly domainKnowledge: ContextLayer;
}

/** Generated layer ids of a role's slots. The prefix is reserved: settings never define one. */
export const roleLayerId = (role: string, slot: CompositionSlot): string => `role:${role}:${slot}`;
export const isRoleLayerId = (id: string): boolean => id.startsWith('role:');

export interface RoleLayerOptions {
  resolveSource?: ResolveSource;
  /** Instructions to use when the role's settings carry none. */
  builtIn?: string;
  scope?: OwnershipScope;
  /** The domain knowledge sources in place of the role's own (a later classify stage's doc). */
  domainKnowledge?: readonly string[];
}

/**
 * A Warden's slots from the composition view (docs/usage-and-context.md, "Composition view").
 * Instructions: the role's settings instructions (`builtIn` when it has none), then the ladder's
 * files for it. Domain knowledge: each of its `domainKnowledge` sources under its label, then the
 * ladder's files. Bound to `scope`, they follow the thread's cwd and project.
 */
export function buildRoleLayers(
  config: FoundryConfig,
  role: string,
  options: RoleLayerOptions = {},
): RoleLayers {
  return {
    instructions: buildRoleLayer(config, role, 'instructions', BOTH, options),
    domainKnowledge: buildRoleLayer(config, role, 'domainKnowledge', BOTH, options),
  };
}

const BOTH: readonly CompositionSlot[] = ['instructions', 'domainKnowledge'];

/**
 * The domain knowledge a later classify stage reads: the role's slot composed the same way (its
 * overlays and general files included), from that stage's doc source in place of the role's own.
 */
export function buildStageKnowledge(
  config: FoundryConfig,
  role: string,
  doc: string,
  sourceId: string,
  options: RoleLayerOptions = {},
): ContextLayer {
  return roleLayer(
    `${roleLayerId(role, 'domainKnowledge')}:${doc}`,
    roleSources(config, role, 'domainKnowledge', BOTH, { ...options, domainKnowledge: [sourceId] }),
    options.scope,
    'domain-knowledge',
  );
}

/** One slot of a role that receives `delivered` (the Cartographer: instructions only). */
export function buildRoleLayer(
  config: FoundryConfig,
  role: string,
  slot: CompositionSlot,
  delivered: readonly CompositionSlot[],
  options: RoleLayerOptions = {},
): ContextLayer {
  return roleLayer(
    roleLayerId(role, slot),
    roleSources(config, role, slot, delivered, options),
    options.scope,
    slot === 'domainKnowledge' ? 'domain-knowledge' : undefined,
  );
}

/** The sources of one role slot, unbound. */
export function roleSources(
  config: FoundryConfig,
  role: string,
  slot: CompositionSlot,
  delivered: readonly CompositionSlot[],
  options: {
    resolveSource?: ResolveSource;
    builtIn?: string;
    domainKnowledge?: readonly string[];
  } = {},
): ContextSource[] {
  const agent = config.agents[role];
  const ladder = compositionSource(
    config,
    `${roleLayerId(role, slot)}#composition`,
    role,
    slot,
    delivered,
  );
  if (slot === 'instructions') {
    const fromSettings = !!agent?.prompt?.trim();
    const own = fromSettings ? agent!.prompt : options.builtIn;
    const subject = fromSettings
      ? (projectId?: string) =>
          `prompt:agent:${role}${projectId && config.projects?.[projectId]?.agents?.[role] ? `@project:${projectId}` : ''}`
      : () => `prompt:builtin:${role}`;
    return [
      ...(own ? [promptSource(`${roleLayerId(role, slot)}#settings`, own, subject)] : []),
      ladder,
    ];
  }
  const ids = [...new Set(options.domainKnowledge ?? agent?.domainKnowledge ?? [])];
  if (ids.length && !options.resolveSource)
    throw Error(`Role ${role} names domain knowledge sources but no source resolver is available`);
  const settings = ids.map((id) => {
    const source = options.resolveSource!(id, config);
    if (!source) throw Error(`Role ${role} domain knowledge source ${id} is missing or disabled`);
    return chunkSource(`${roleLayerId(role, slot)}#${id}`, config.sources[id]?.label ?? id, [
      attributed(source, id, FAST_MOVING_SOURCES.has(config.sources[id]?.type ?? '')),
    ]);
  });
  return [...settings, ladder];
}

/** A role's settings prompt: one part attributed to the setting it came from (per project when the project defines the agent). */
function promptSource(
  id: string,
  text: string,
  subject: (projectId?: string) => string,
  projectId?: string,
): ContextSource {
  return {
    id,
    bind: (scope) => promptSource(id, text, subject, scope.projectId),
    async load() {
      return text;
    },
    segments: () => [{ subject: subject(projectId), text }],
  };
}

/**
 * Configured source types whose text is generated per thread or message (captured memory, archive
 * retrieval), not slow-moving knowledge: stored raw with each call, never audited as a source change.
 */
const FAST_MOVING_SOURCES = new Set(['file', 'archive']);

/**
 * A configured source as one part (`source-content:<id>`, per project when bound to one) unless it
 * attributes its own text; per-message text when it is focusable or `fast`.
 */
function attributed(
  source: ContextSource,
  id: string,
  fast: boolean,
  projectId?: string,
): ContextSource {
  let last: string | undefined;
  const subject = `source-content:${id}${projectId ? `@project:${projectId}` : ''}`;
  const retrieved = fast || !!source.focusable;
  return {
    id: source.id,
    ...(source.focusable ? { focusable: true } : {}),
    ...(source.changed ? { changed: () => source.changed!() } : {}),
    ...(source.report ? { report: () => source.report!() } : {}),
    bind: (scope) =>
      attributed(source.bind ? source.bind(scope) : source, id, fast, scope.projectId),
    async load(hint) {
      last = await source.load(hint);
      return last;
    },
    segments: () => {
      if (last === undefined) return undefined;
      const own = source.segments?.();
      if (own && segmentsText(own) === last) return own;
      return last ? [{ subject, text: last, ...(retrieved ? { retrieved: true } : {}) }] : [];
    },
  };
}

/** Every live role layer, so a written role file can reach the next turn (`invalidateComposition`). */
const live = new Set<WeakRef<ContextLayer>>();

/**
 * Mark every live role slot stale, and every composed slot (the main thread's `instructions` too)
 * changed, so the next turn re-reads the composition view: call it after writing a role or
 * instruction file. Edits made any other way are found by the slots' own file check before each
 * turn. Returns how many role slots were marked.
 */
export function invalidateComposition(): number {
  forgetSharedRoleViews();
  let marked = 0;
  for (const ref of live) {
    const layer = ref.deref();
    if (!layer) {
      live.delete(ref);
      continue;
    }
    layer.invalidate();
    marked++;
  }
  return marked;
}

function roleLayer(
  id: string,
  sources: ContextSource[],
  scope: OwnershipScope | undefined,
  segment?: 'domain-knowledge',
): ContextLayer {
  const layer = new ContextLayer({
    id,
    ...(segment ? { segment } : {}),
    // Composed files change on disk; re-read them at most once a minute.
    staleness: 60_000,
    sources: [bound(chunkSource(`${id}#slot`, undefined, sources), scope)],
  });
  // Threads come and go: drop collected entries as the set grows.
  if (live.size >= 256) for (const ref of live) if (!ref.deref()) live.delete(ref);
  live.add(new WeakRef(layer));
  return layer;
}

const bound = (source: ContextSource, scope: OwnershipScope | undefined) =>
  scope && source.bind ? source.bind(scope) : source;

/**
 * Swap a live role layer's sources for `fresh`'s (a settings edit), bound to `scope`. A load in
 * flight finishes with the old sources and marks the layer warm, so it is marked stale again after.
 */
export function replaceRoleSources(
  layer: ContextLayer,
  fresh: readonly ContextSource[],
  scope: OwnershipScope | undefined,
): void {
  for (const source of [...layer.sources]) layer.removeSource(source.id);
  layer.addSource(bound(chunkSource(`${layer.id}#slot`, undefined, [...fresh]), scope));
  if (layer.state === 'warming')
    void layer
      .warm()
      .catch(() => undefined)
      .finally(() => layer.invalidate());
  layer.invalidate();
}

/**
 * A group of sources loaded as one: their non-empty texts joined, under `heading` when given. An
 * empty group contributes nothing.
 */
export function chunkSource(
  id: string,
  heading: string | undefined,
  sources: ContextSource[],
): ContextSource {
  let loaded: { parts: string[]; out: string } | undefined;
  return {
    id,
    focusable: sources.some((source) => source.focusable),
    changed: () => sources.some((source) => source.changed?.() ?? false),
    bind: (scope) =>
      chunkSource(
        id,
        heading,
        sources.map((source) => (source.bind ? source.bind(scope) : source)),
      ),
    async load(hint) {
      const parts: string[] = [];
      for (const source of sources) parts.push(await source.load(hint));
      const text = parts.filter((part) => part.trim()).join('\n\n');
      const out = text && heading ? `## ${heading}\n\n${text}` : text;
      loaded = { parts, out };
      return out;
    },
    segments() {
      if (!loaded) return undefined;
      const out: SourceSegment[] = [];
      loaded.parts.forEach((part, i) => {
        if (!part.trim()) return;
        if (out.length) out.push('\n\n');
        const source = sources[i]!;
        const own = source.segments?.();
        if (own && segmentsText(own) === part) out.push(...own);
        else
          out.push({
            subject: `unattributed:${source.id}`,
            text: part,
            ...(source.focusable ? { retrieved: true } : {}),
          });
      });
      if (out.length && heading) out.unshift(`## ${heading}\n\n`);
      return segmentsText(out) === loaded.out ? out : undefined;
    },
    report() {
      const reports = sources
        .map((source) => source.report?.())
        .filter((report): report is SourceSelectionReport => !!report);
      if (!reports.length) return undefined;
      // Ranges index each source's own text, not the headed chunk, so a chunk report carries none.
      return {
        ...(reports.length === 1 ? reports[0] : {}),
        selected: reports.flatMap((r) => r.selected.map(({ ranges: _ranges, ...rest }) => rest)),
        omitted: reports.flatMap((r) => r.omitted),
        considered: reports.reduce((sum, r) => sum + r.considered, 0),
        retained: {
          count: reports.reduce((sum, r) => sum + r.retained.count, 0),
          chars: reports.reduce((sum, r) => sum + r.retained.chars, 0),
        },
        budget: {
          chars: reports.reduce((sum, r) => sum + r.budget.chars, 0),
          used: reports.reduce((sum, r) => sum + r.budget.used, 0),
          exceeded: reports.some((r) => r.budget.exceeded),
        },
        conflicts: reports.flatMap((r) => r.conflicts),
      };
    },
  };
}
