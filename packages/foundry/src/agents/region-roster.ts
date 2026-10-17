import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { claudemdSource, INSTRUCTION_FILE_LIMIT } from '@inixiative/foundry-core';
import { contentHash } from '../persistence/journal-content';
import type {
  AgentSettingsConfig,
  ChorusSettings,
  DataSourceConfig,
  ProjectSettingsConfig,
} from '../viewer/config';
import { REGION_WARDEN_INSTRUCTIONS } from './warden-charter';

/** Where a project's regions live unless its `chorus` names a layer. */
export const DEFAULT_REGIONS_DIR = '.foundry/regions';

/**
 * The repository's own Foundry settings, committed beside its regions: `{ "chorus": { … } }`. The
 * machine's project settings win over it, key by key (`viewer/config-resolve.ts`, `projectChorus`).
 * Not `.foundry/settings.json`: that name is a Foundry install's own settings, and Foundry's checkout
 * is itself a registered project.
 */
export const REPOSITORY_SETTINGS_FILE = '.foundry/project.json';

/** The label of the one implicit layer (`chorus.regions`, or the default directory). */
export const DEFAULT_LAYER_LABEL = 'project';

/** The tools whose calls reach a region Warden's guard: everything that writes or executes. */
export const REGION_GUARD_TRIGGERS: readonly string[] = [
  'file_write',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'bash',
];

/** Source id of a region's knowledge in the project view; the audit log versions it as `source-content:<id>@project:<pid>`. */
export const regionSourceId = (regionId: string): string => `region:${regionId}`;

const REGION_SUBJECT = /^source-content:region:([^@]+)(?:@project:.*)?$/;

/** The region id a composition part's subject names, when it is a region's knowledge. */
export function regionOfSubject(subject: string): string | undefined {
  return REGION_SUBJECT.exec(subject)?.[1];
}

/** One region as its `region.json` describes it, plus where its files are. */
export interface RegionSummary {
  readonly id: string;
  readonly title: string;
  /** The one-line routing question ("Is this about …?"), also the pre-filter's question for this Warden. */
  readonly routing: string;
  readonly concepts: readonly string[];
  /** The builder's size estimate, when it recorded one. */
  readonly tokens?: number;
  /** `knowledge.md` as written, in bytes. */
  readonly bytes: number;
  /** `region.json`, absolute. */
  readonly path: string;
  /** `knowledge.md`, absolute. */
  readonly knowledgePath: string;
}

/** One layer of a chorus, as configured: its label and its regions directory (absolute). */
export interface ChorusLayer {
  readonly label: string;
  readonly regionsDir: string;
}

/** A layer as read: its regions, in id order. A missing directory reads as no regions. */
export interface ChorusLayerRegions extends ChorusLayer {
  readonly regions: readonly RegionSummary[];
}

/** A region of the composed chorus: the layer it came from, and the earlier layers it replaced whole. */
export interface ChorusRegion extends RegionSummary {
  readonly layer: string;
  readonly replaces: readonly string[];
}

const REGION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

/**
 * The layers a project's chorus is built from, in order: `chorus.layers` as written, else the one
 * layer `chorus.regions` names, else the default directory. Paths resolve against the project.
 */
export function chorusLayers(
  project: Pick<ProjectSettingsConfig, 'path' | 'chorus'>,
): ChorusLayer[] {
  const chorus: ChorusSettings = project.chorus ?? {};
  const dir = (configured: string) =>
    isAbsolute(configured) ? resolve(configured) : resolve(project.path, configured);
  if (chorus.layers)
    return chorus.layers.map((layer, index) => ({
      label: layer.label ?? `layer-${index + 1}`,
      regionsDir: dir(layer.regions),
    }));
  return [{ label: DEFAULT_LAYER_LABEL, regionsDir: dir(chorus.regions ?? DEFAULT_REGIONS_DIR) }];
}

/**
 * Every region under `dir`: each subdirectory holding a `region.json` and a `knowledge.md`, sorted by
 * id. A missing directory is no regions. A region whose files are malformed is an error, named: the
 * chorus is never silently short.
 */
export function readRegions(dir: string): RegionSummary[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const regions: RegionSummary[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name, 'region.json');
    const knowledgePath = join(dir, entry.name, 'knowledge.md');
    if (!existsSync(path)) continue;
    if (!existsSync(knowledgePath))
      throw Error(`region ${entry.name} at ${dir} has a region.json but no knowledge.md`);
    const knowledge = statSync(knowledgePath);
    if (!knowledge.isFile())
      throw Error(`region ${entry.name} at ${dir}: knowledge.md is not a regular file`);
    // Its source would load an oversized file as nothing: a Warden with no knowledge, never silently.
    if (knowledge.size > INSTRUCTION_FILE_LIMIT)
      throw Error(
        `region ${entry.name} at ${dir}: knowledge.md is ${knowledge.size} bytes, over the ${INSTRUCTION_FILE_LIMIT}-byte limit an instruction file loads`,
      );
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw Error(
        `region ${entry.name} at ${dir}: region.json is not JSON (${(error as Error).message})`,
      );
    }
    const r = raw as {
      id?: unknown;
      title?: unknown;
      routing?: unknown;
      concepts?: unknown;
      tokens?: unknown;
    } | null;
    if (!r || typeof r !== 'object')
      throw Error(`region ${entry.name} at ${dir}: region.json is not an object`);
    if (typeof r.id !== 'string' || !REGION_ID.test(r.id))
      throw Error(
        `region ${entry.name} at ${dir}: region.json needs an "id" (letters, digits, _ . -)`,
      );
    if (r.id !== entry.name)
      throw Error(
        `region ${entry.name} at ${dir}: region.json id ${JSON.stringify(r.id)} differs from its directory`,
      );
    if (typeof r.title !== 'string' || !r.title.trim())
      throw Error(`region ${r.id} at ${dir}: region.json needs a "title"`);
    if (typeof r.routing !== 'string' || !r.routing.trim())
      throw Error(`region ${r.id} at ${dir}: region.json needs a "routing" line`);
    const concepts = Array.isArray(r.concepts)
      ? r.concepts.filter((c): c is string => typeof c === 'string')
      : [];
    regions.push({
      id: r.id,
      title: r.title.trim(),
      routing: r.routing.trim(),
      concepts,
      ...(typeof r.tokens === 'number' && Number.isFinite(r.tokens) ? { tokens: r.tokens } : {}),
      bytes: knowledge.size,
      path,
      knowledgePath,
    });
  }
  return regions.sort((a, b) => a.id.localeCompare(b.id));
}

/** How many regions `dir` holds (subdirectories with a `region.json`), without reading them. */
export function countRegions(dir: string): number {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'region.json')),
  ).length;
}

/**
 * The chorus the layers compose, in order: a region id present in a later layer replaces the earlier
 * one whole (its knowledge is not merged); ids present once union. A layer that names no regions is
 * read as empty and kept in the result, so what each layer contributed is visible.
 */
export function composeChorus(layers: readonly ChorusLayer[]): {
  layers: ChorusLayerRegions[];
  regions: ChorusRegion[];
} {
  const read = layers.map((layer) => ({ ...layer, regions: readRegions(layer.regionsDir) }));
  const composed = new Map<string, ChorusRegion>();
  for (const layer of read)
    for (const region of layer.regions) {
      const earlier = composed.get(region.id);
      composed.set(region.id, {
        ...region,
        layer: layer.label,
        replaces: earlier ? [...earlier.replaces, earlier.layer] : [],
      });
    }
  return {
    layers: read,
    regions: [...composed.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** One line on a project's chorus for the startup log and the eval: what runs, from which layers, or why not. */
export function describeChorus(
  project: string,
  chorus: {
    readonly source: 'regions' | 'roster';
    readonly requested: 'regions' | 'roster';
    readonly layers: readonly ChorusLayerRegions[];
    readonly regions: readonly ChorusRegion[];
    readonly reason?: string;
  },
): string {
  if (chorus.source !== 'regions')
    return chorus.requested === 'regions'
      ? `Chorus: project ${project} asked for regions but ${chorus.reason ?? 'none were found'}`
      : `Chorus: project ${project}: ${chorus.reason ?? 'the hand-named roster runs'}`;
  const layers = chorus.layers
    .map((layer) => `${layer.label}: ${layer.regions.length} at ${layer.regionsDir}`)
    .join('; ');
  const bytes = chorus.regions.reduce((sum, region) => sum + region.bytes, 0);
  return `Chorus: project ${project} runs ${chorus.regions.length} region Wardens (${Math.round(bytes / 1024)} KB of knowledge) from ${chorus.layers.length} layer${chorus.layers.length === 1 ? '' : 's'} (${layers}); classifier charter`;
}

/**
 * A region's warm-cache key: the content hash of its knowledge as its Warden's source composes it
 * (`knowledge.md` with comments stripped, the one text the `source-content:region:<id>` version and
 * the journalled `versions.chorus` carry). Two projects whose region text is identical share the key,
 * whichever layer or directory it came from, so their primed prefix can be shared later. (A
 * knowledge.md that resolves an `@path` import composes that file's path too; the builder writes none.)
 * Rejects when the file cannot be read.
 */
export async function regionKey(
  region: Pick<RegionSummary, 'id' | 'knowledgePath'>,
): Promise<string> {
  return contentHash(await claudemdSource(regionSourceId(region.id), region.knowledgePath).load());
}

/** A region Warden's settings prompt: the generic region instructions, then which region this is. */
export function regionInstructions(
  region: Pick<RegionSummary, 'id' | 'title' | 'routing'>,
): string {
  return `${REGION_WARDEN_INSTRUCTIONS}\n\nYour region: ${region.title} (\`${region.id}\`).\nRouting: ${region.routing}`;
}

export interface RegionWarden {
  readonly region: RegionSummary;
  /** A standalone project agent: a full definition, so `resolveProjectView` treats it like one written in settings. */
  readonly agent: AgentSettingsConfig;
  /** The project source its domain knowledge composes from: the region's knowledge.md, whole. */
  readonly source: DataSourceConfig;
}

/**
 * The generated chorus for `regions`: one domain-librarian Warden per region, its domain the region
 * id, asked on every user message (`invocation: always`) and on every write or exec tool call, its
 * knowledge the region's knowledge.md through a `markdown` source (audited as `source-content`, so
 * composition versions name the exact text). Org and personal overlays reach it through the ladder's
 * role files for role `<region id>` as for any Warden.
 */
export function regionWardens(regions: readonly RegionSummary[]): RegionWarden[] {
  return regions.map((region) => ({
    region,
    agent: {
      id: region.id,
      kind: 'domain-librarian',
      flowRole: 'domain-advising',
      domain: region.id,
      description: region.title,
      prompt: regionInstructions(region),
      temperature: 0,
      tools: false,
      visibleLayers: [],
      domainKnowledge: [regionSourceId(region.id)],
      guardTriggers: [...REGION_GUARD_TRIGGERS],
      peers: [],
      maxDepth: 1,
      invocation: 'always',
      enabled: true,
    },
    source: {
      id: regionSourceId(region.id),
      label: `${region.title} (region knowledge)`,
      type: 'markdown',
      uri: region.knowledgePath,
      enabled: true,
    },
  }));
}
