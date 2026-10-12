import type {
  HierarchyFileSource,
  HierarchyMatch,
  HierarchySource,
  HierarchySpan,
} from '@inixiative/foundry-core';
import { CORPUS_TIERS, type CorpusTier } from '../agents/corpus-compiler';

/** Standing instruction files (`instructions` in settings); see docs/usage-and-context.md. */
export interface InstructionSettings {
  /**
   * Whether the native harness also loads instruction files itself. "suppress" leaves Foundry's
   * `instructions` source as the only path; "load" lets the harness load them too. Absent: suppress
   * exactly when an enabled layer reads an enabled `instructions` source. Applies on restart.
   */
  harnessLoading?: 'suppress' | 'load';
  /** The ladder `nodes` merge over: "claude-code" (default; Claude Code's own discovery) or "none". */
  preset?: 'claude-code' | 'none';
  /** Registered nodes by id. A preset id replaces that node; `enabled: false` removes it. */
  nodes?: Record<string, InstructionNodeConfig>;
  /** Remove repeated files and sections, keeping the most specific copy. Both default on. */
  dedupe?: { content?: boolean; sections?: boolean };
}

/** One rung of the instruction hierarchy. */
export interface InstructionNodeConfig {
  /** computer, org, project, or another level name. */
  scope: string;
  /** Personal to the user (never reaches a team or org audience) rather than shared. */
  personal: boolean;
  /** Default: personal_private when personal, team for a shared project node, org otherwise. */
  tier?: CorpusTier;
  /** Shown in the prompt's `Contents of <path> (<label>)`. */
  label?: string;
  /** Applies only where the parent applies, and orders after it. */
  parent?: string;
  /** When the node applies: cwd inside `paths`, the thread's `projects`, its Kingdom `owners`, the `harness`. */
  when?: HierarchyMatch;
  /** The directory the node is about (`{anchor}` in paths). Default: the matched `when.paths` entry. */
  anchor?: string;
  /** Files: `{ path }` (a file, a glob, or a list whose first existing file loads) or `{ walk, span }`. */
  sources: HierarchySource[];
  /** Where its files may import from. Default: personal computer nodes anywhere, others the repository or the file's directory. */
  imports?: 'anywhere' | string[];
  /** Paths that are this node's wherever reached: an import of one keeps the narrower tier. */
  owns?: { names?: string[]; within?: string[]; dirs?: string[] };
  enabled?: boolean;
}

export interface InstructionNodeSettings extends Omit<InstructionNodeConfig, 'sources'> {
  id: string;
  sources: readonly HierarchySource[];
}

/** Claude Code loads the first 200 lines or 25KB of MEMORY.md, whichever is smaller. */
const MEMORY_LINES = 200;
const MEMORY_BYTES = 25 * 1024;

/** The per-directory files Claude Code reads on its root-to-cwd walk, in its order. */
const DIRECTORY_FILES: readonly HierarchyFileSource[] = [
  { path: 'CLAUDE.md' },
  { path: '.claude/CLAUDE.md' },
  { path: '.claude/rules/**/*.md', rules: true },
  { path: 'AGENTS.md' },
  { path: '.claude/AGENTS.md' },
];

/** Source id of the harness's personal global file, left out when the harness reads it itself. */
export const HARNESS_GLOBAL_SOURCE = 'harness-global';

/**
 * The default ladder: Claude Code's discovery (verified against Claude Code 2.1.296) for any
 * harness. Managed policy, the personal global file and its rules, then each directory from the
 * filesystem root down to the cwd (above the repository: org; inside it: project; CLAUDE.local.md
 * anywhere: local), and auto memory last. The home directory's own files are the global level, and
 * its .claude is read only as the running harness's global level.
 */
export const DEFAULT_INSTRUCTION_LADDER: readonly InstructionNodeSettings[] = Object.freeze([
  {
    id: 'managed',
    scope: 'computer',
    personal: false,
    tier: 'org',
    imports: 'anywhere',
    sources: [{ path: '{managed}' }],
  },
  {
    id: 'global',
    scope: 'computer',
    personal: true,
    imports: 'anywhere',
    owns: { within: ['{claudeConfigDir}', '{codexHome}'], dirs: ['{home}'] },
    sources: [
      {
        id: HARNESS_GLOBAL_SOURCE,
        when: { harness: ['claude'] },
        path: '{claudeConfigDir}/CLAUDE.md',
      },
      {
        id: HARNESS_GLOBAL_SOURCE,
        when: { harness: ['claude'] },
        path: '{claudeConfigDir}/rules/**/*.md',
        rules: true,
      },
      {
        id: HARNESS_GLOBAL_SOURCE,
        when: { harness: ['codex'] },
        path: ['{codexHome}/AGENTS.override.md', '{codexHome}/AGENTS.md'],
      },
      { walk: [{ path: 'CLAUDE.md' }, { path: 'AGENTS.md' }], span: { only: ['{home}'] } },
    ],
  },
  {
    id: 'org',
    scope: 'org',
    personal: false,
    sources: [
      {
        walk: DIRECTORY_FILES,
        span: { outside: ['{project}', '{repository}'], except: ['{home}'] },
      },
    ],
  },
  {
    id: 'project',
    scope: 'project',
    personal: false,
    owns: { within: ['{project}', '{repository}'] },
    sources: [
      {
        walk: DIRECTORY_FILES,
        span: { within: ['{project}', '{repository}'], except: ['{home}'] },
      },
    ],
  },
  {
    id: 'local',
    scope: 'project',
    personal: true,
    owns: { names: ['CLAUDE.local.md'] },
    sources: [{ walk: [{ path: 'CLAUDE.local.md' }] }],
  },
  {
    id: 'memory',
    scope: 'project',
    personal: true,
    anchor: '{cwd}',
    sources: [
      {
        path: '{claudeConfigDir}/projects/{claudeProjectKey}/memory/MEMORY.md',
        raw: true,
        maxLines: MEMORY_LINES,
        maxBytes: MEMORY_BYTES,
      },
    ],
  },
] satisfies InstructionNodeSettings[]);

/**
 * The registered ladder: the preset (`instructions.preset`: "claude-code", the default, or "none"), with `instructions.nodes` merged over it by id. A node with `enabled: false` is removed;
 * a new id is added after the preset's nodes, placed in the tree by its `parent`.
 */
export function resolveInstructionLadder(
  settings: InstructionSettings | undefined,
): InstructionNodeSettings[] {
  const base = settings?.preset === 'none' ? [] : DEFAULT_INSTRUCTION_LADDER;
  const nodes = new Map(base.map((node) => [node.id, node]));
  for (const [id, node] of Object.entries(settings?.nodes ?? {})) {
    if (node.enabled === false) nodes.delete(id);
    else nodes.set(id, { ...node, id });
  }
  return [...nodes.values()];
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);

function checkMatch(where: string, when: unknown): void {
  if (when === undefined) return;
  if (!when || typeof when !== 'object') throw Error(`${where}: when must be an object`);
  for (const [key, value] of Object.entries(when)) {
    if (!['paths', 'projects', 'owners', 'harness'].includes(key))
      throw Error(`${where}: when.${key} is not one of paths, projects, owners, harness`);
    if (!isStrings(value)) throw Error(`${where}: when.${key} must be a list of strings`);
  }
}

function checkFile(where: string, source: HierarchyFileSource): void {
  const path = source.path as unknown;
  if (!(typeof path === 'string' && path) && !(isStrings(path) && path.length))
    throw Error(`${where}: path must be a path or a non-empty list of paths`);
  for (const key of ['maxLines', 'maxBytes'] as const)
    if (
      source[key] !== undefined &&
      !(Number.isInteger(source[key]) && (source[key] as number) > 0)
    )
      throw Error(`${where}: ${key} must be a positive integer`);
}

function checkSpan(where: string, span: HierarchySpan | undefined): void {
  if (span === undefined) return;
  for (const [key, value] of Object.entries(span)) {
    if (!['within', 'outside', 'only', 'except'].includes(key))
      throw Error(`${where}: span.${key} is not one of within, outside, only, except`);
    if (!isStrings(value)) throw Error(`${where}: span.${key} must be a list of paths`);
  }
}

/** Validates `instructions` against the ladder it resolves to. */
export function validateInstructionSettings(
  settings: InstructionSettings | undefined,
  ladder: readonly InstructionNodeSettings[],
): void {
  if (!settings) return;
  const loading = settings.harnessLoading;
  if (loading !== undefined && loading !== 'suppress' && loading !== 'load')
    throw Error('instructions.harnessLoading must be "suppress" or "load"');
  if (
    settings.preset !== undefined &&
    settings.preset !== 'claude-code' &&
    settings.preset !== 'none'
  )
    throw Error('instructions.preset must be "claude-code" or "none"');
  for (const [key, value] of Object.entries(settings.dedupe ?? {}))
    if (!['content', 'sections'].includes(key) || typeof value !== 'boolean')
      throw Error('instructions.dedupe takes boolean content and sections');
  for (const [id, node] of Object.entries(settings.nodes ?? {})) {
    const where = `instructions.nodes.${id}`;
    if (!node || typeof node !== 'object') throw Error(`${where} must be an object`);
    if (node.enabled === false) continue;
    if (typeof node.scope !== 'string' || !node.scope) throw Error(`${where}: scope is required`);
    if (typeof node.personal !== 'boolean') throw Error(`${where}: personal must be true or false`);
    if (node.tier !== undefined && !CORPUS_TIERS.includes(node.tier))
      throw Error(`${where}: tier must be one of ${CORPUS_TIERS.join(', ')}`);
    // A personal node never widens to a shared tier.
    if (node.personal && node.tier !== undefined && !node.tier.startsWith('personal'))
      throw Error(`${where}: a personal node's tier is personal_private or personal_public`);
    checkMatch(where, node.when);
    if (node.imports !== undefined && node.imports !== 'anywhere' && !isStrings(node.imports))
      throw Error(`${where}: imports is "anywhere" or a list of roots`);
    if (!Array.isArray(node.sources) || !node.sources.length)
      throw Error(`${where}: sources must list at least one source`);
    node.sources.forEach((source, i) => {
      const at = `${where}.sources[${i}]`;
      checkMatch(at, source.when);
      if ('walk' in source) {
        if (!Array.isArray(source.walk) || !source.walk.length)
          throw Error(`${at}: walk must list at least one file`);
        for (const [j, file] of source.walk.entries()) checkFile(`${at}.walk[${j}]`, file);
        checkSpan(at, source.span);
      } else checkFile(at, source);
    });
  }
  const ids = new Set(ladder.map((node) => node.id));
  const parents = new Map(ladder.map((node) => [node.id, node.parent]));
  for (const node of ladder) {
    if (node.parent !== undefined && !ids.has(node.parent))
      throw Error(
        `instructions.nodes.${node.id}: parent ${JSON.stringify(node.parent)} is not a node`,
      );
    const path = new Set<string>([node.id]);
    for (let up = node.parent; up !== undefined; up = parents.get(up)) {
      if (path.has(up)) throw Error(`instructions.nodes.${node.id}: parent cycle through ${up}`);
      path.add(up);
    }
  }
}
