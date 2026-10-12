import {
  ContextLayer,
  type ContextSource,
  inlineSource,
  type OwnershipScope,
  type SourceSelectionReport,
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
  options: { resolveSource?: ResolveSource; builtIn?: string } = {},
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
    const own = agent?.prompt?.trim() ? agent.prompt : options.builtIn;
    return [...(own ? [inlineSource(`${roleLayerId(role, slot)}#settings`, own)] : []), ladder];
  }
  const ids = [...new Set(agent?.domainKnowledge ?? [])];
  if (ids.length && !options.resolveSource)
    throw Error(`Role ${role} names domain knowledge sources but no source resolver is available`);
  const settings = ids.map((id) => {
    const source = options.resolveSource!(id, config);
    if (!source) throw Error(`Role ${role} domain knowledge source ${id} is missing or disabled`);
    return chunkSource(`${roleLayerId(role, slot)}#${id}`, config.sources[id]?.label ?? id, [
      source,
    ]);
  });
  return [...settings, ladder];
}

/** Every live role layer, so a written role file can reach the next turn (`invalidateComposition`). */
const live = new Set<WeakRef<ContextLayer>>();

/**
 * Mark every live role slot stale, so the next turn re-reads the composition view instead of waiting
 * out its staleness: call it after writing a role or instruction file. Returns how many were marked.
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
  return {
    id,
    focusable: sources.some((source) => source.focusable),
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
      return text && heading ? `## ${heading}\n\n${text}` : text;
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
