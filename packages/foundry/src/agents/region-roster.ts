// ---------------------------------------------------------------------------
// Region Wardens: a project's Warden roster generated from its concept regions
//
// Under `wardens: "regions"`, a project's roster is one domain-librarian Warden per region in its
// regions directory (`<project>/.foundry/regions/<region id>/{region.json,knowledge.md}`, the shape the
// template's region builder writes). Each region's knowledge.md is that Warden's domain knowledge, in
// full; its region.json gives the id, title and routing line. Nothing is hand-edited here: the roster
// is derived every time the project view resolves, so a rebuilt regions directory is the new roster.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  AgentSettingsConfig,
  DataSourceConfig,
  ProjectSettingsConfig,
} from '../viewer/config';
import { REGION_WARDEN_INSTRUCTIONS } from './warden-charter';

/** Where a project's regions live unless `projects[id].regions` says otherwise. */
export const DEFAULT_REGIONS_DIR = '.foundry/regions';

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

/** One region as its `region.json` describes it, plus where its files are. */
export interface RegionSummary {
  readonly id: string;
  readonly title: string;
  /** The one-line routing question ("Is this about …?"), also the pre-filter's question for this Warden. */
  readonly routing: string;
  readonly concepts: readonly string[];
  /** The builder's size estimate, when it recorded one. */
  readonly tokens?: number;
  /** `region.json`, absolute. */
  readonly path: string;
  /** `knowledge.md`, absolute. */
  readonly knowledgePath: string;
}

const REGION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

/** The regions directory of a project: its `regions` setting (absolute, or relative to the project) or the default. */
export function regionsDirectory(project: Pick<ProjectSettingsConfig, 'path' | 'regions'>): string {
  const configured = project.regions ?? DEFAULT_REGIONS_DIR;
  return isAbsolute(configured) ? resolve(configured) : resolve(project.path, configured);
}

/**
 * Every region under `dir`: each subdirectory holding a `region.json` and a `knowledge.md`, sorted by
 * id. A missing directory is no regions. A region whose files are malformed is an error, named: the
 * roster is never silently short.
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
      path,
      knowledgePath,
    });
  }
  return regions.sort((a, b) => a.id.localeCompare(b.id));
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
 * The generated roster for `regions`: one domain-librarian Warden per region, its domain the region
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
