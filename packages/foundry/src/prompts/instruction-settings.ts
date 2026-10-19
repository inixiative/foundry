/**
 * @atlas
 * @kind config
 * @partOf feature:composition
 */
import type {
  HierarchyFileSource,
  HierarchyMatch,
  HierarchySource,
  HierarchySpan,
} from '@inixiative/foundry-core';
import { CORPUS_TIERS, type CorpusTier } from '../agents/corpus-compiler';

/** The two composed slots every role has. Thread knowledge is computed per call, not composed. */
export const COMPOSITION_SLOTS = ['instructions', 'domainKnowledge'] as const;
export type CompositionSlot = (typeof COMPOSITION_SLOTS)[number];

/** The main thread's role id in the composition view. */
export const MAIN_ROLE = 'main';

/**
 * Default budget for a middleware role's composed instructions plus domain knowledge, in characters:
 * under the decision input cap (DECISION_INPUT_CAP, 160,000 serialized), leaving room for the
 * charter, thread knowledge, thread state and the turn, so an overflow is this budget's named error,
 * not the cap's. Sized so a region Warden at the hard cap of the healthy-size test (40k tokens of
 * knowledge, about 100,000 characters; H itself is 20k) is admitted with its instructions.
 */
export const DEFAULT_ROLE_BUDGET = 120_000;

/** How narrow an audience is: one sees every tier its rank or above. */
const AUDIENCE_RANK: Readonly<Record<CorpusTier, number>> = {
  personal_private: 0,
  personal_public: 1,
  team: 2,
  org: 3,
};

export interface CompositionDedupe {
  content?: boolean;
  sections?: boolean;
}

/**
 * The composition view (`composition` in settings; see docs/usage-and-context.md): one ladder
 * composes every slot for every role, the main thread and each middleware role alike.
 */
export interface CompositionSettings {
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
  dedupe?: CompositionDedupe;
  /** What each role picks from the ladder, by role id (`main`, or a middleware agent's id). */
  roles?: Record<string, RoleComposition>;
}

/** One slot's pick from the ladder: everything that applies, minus `exclude`. */
export interface SlotSelection {
  /** Nodes left out of this slot entirely: their general files and their role files. */
  exclude?: string[];
  /**
   * Nodes whose general files (unslotted: CLAUDE.md, AGENTS.md, rules, auto memory) compose into
   * this slot; role files compose either way. Default: "all" for instructions, none for domain
   * knowledge.
   */
  general?: 'all' | string[];
}

/** A role's picks. Everything that applies is on by default. */
export interface RoleComposition {
  /** `false` leaves the slot's ladder part out entirely. */
  instructions?: SlotSelection | false;
  domainKnowledge?: SlotSelection | false;
  /** Who the composition is for: a file reaches it only if its tier is visible there. Default personal_private. */
  audience?: CorpusTier;
  /** Overrides `composition.dedupe` for this role. */
  dedupe?: CompositionDedupe;
  /**
   * Characters allowed for instructions plus domain knowledge. Over it, the role's phase reports an
   * error and does not run. Default: none for main, DEFAULT_ROLE_BUDGET for middleware roles.
   */
  budget?: number;
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
  /**
   * When the node applies: cwd inside `paths`, the thread's `projects`, its Kingdom `owners`, the
   * `harness`, the `roles` composed for and the `slots` composed. A node and source naming no slot
   * compose the instructions slot (unless a role names the node in another slot's `general`).
   */
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

/** Each place's role files: `.foundry/roles/<role>/<slot>.md`, for every role and both slots. */
const ROLE_FILE: HierarchyFileSource = {
  path: '.foundry/roles/{role}/{slot}.md',
  when: { slots: [...COMPOSITION_SLOTS] },
};
/** A personal role file beside it, like CLAUDE.local.md. */
const LOCAL_ROLE_FILE: HierarchyFileSource = {
  path: '.foundry/roles/{role}/{slot}.local.md',
  when: { slots: [...COMPOSITION_SLOTS] },
};

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
    owns: { within: ['{claudeConfigDir}', '{codexHome}', '{home}/.foundry'], dirs: ['{home}'] },
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
      { path: '{home}/.foundry/roles/{role}/{slot}.md', when: { slots: [...COMPOSITION_SLOTS] } },
    ],
  },
  {
    id: 'org',
    scope: 'org',
    personal: false,
    sources: [
      {
        walk: [...DIRECTORY_FILES, ROLE_FILE],
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
        walk: [...DIRECTORY_FILES, ROLE_FILE],
        span: { within: ['{project}', '{repository}'], except: ['{home}'] },
      },
    ],
  },
  {
    id: 'local',
    scope: 'project',
    personal: true,
    owns: {
      names: ['CLAUDE.local.md', ...COMPOSITION_SLOTS.map((slot) => `${slot}.local.md`)],
    },
    sources: [{ walk: [{ path: 'CLAUDE.local.md' }, LOCAL_ROLE_FILE] }],
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
 * The registered ladder: the preset (`composition.preset`: "claude-code", the default, or "none"), with `composition.nodes` merged over it by id. A node with `enabled: false` is removed;
 * a new id is added after the preset's nodes, placed in the tree by its `parent`.
 */
export function resolveInstructionLadder(
  settings: CompositionSettings | undefined,
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

const MATCH_KEYS = ['paths', 'projects', 'owners', 'harness', 'roles', 'slots'];

function checkMatch(where: string, when: unknown): void {
  if (when === undefined) return;
  if (!when || typeof when !== 'object') throw Error(`${where}: when must be an object`);
  for (const [key, value] of Object.entries(when)) {
    if (!MATCH_KEYS.includes(key))
      throw Error(`${where}: when.${key} is not one of ${MATCH_KEYS.join(', ')}`);
    if (!isStrings(value)) throw Error(`${where}: when.${key} must be a list of strings`);
    if (key === 'slots')
      for (const slot of value)
        if (!(COMPOSITION_SLOTS as readonly string[]).includes(slot))
          throw Error(
            `${where}: when.slots names ${slot}; slots are ${COMPOSITION_SLOTS.join(', ')}`,
          );
  }
}

const FILE_KEYS = ['id', 'when', 'path', 'rules', 'raw', 'maxLines', 'maxBytes'];

function checkFile(where: string, source: HierarchyFileSource): void {
  if (!source || typeof source !== 'object' || Array.isArray(source))
    throw Error(`${where} must be an object`);
  for (const key of Object.keys(source))
    if (!FILE_KEYS.includes(key)) throw Error(`${where}: unknown field ${key}`);
  if (source.id !== undefined && (typeof source.id !== 'string' || !source.id))
    throw Error(`${where}: id must be a string`);
  checkMatch(where, source.when);
  for (const key of ['rules', 'raw'] as const)
    if (source[key] !== undefined && typeof source[key] !== 'boolean')
      throw Error(`${where}: ${key} must be true or false`);
  if ((source.maxLines !== undefined || source.maxBytes !== undefined) && !source.raw)
    throw Error(`${where}: maxLines and maxBytes apply to raw sources only`);
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
  if (!span || typeof span !== 'object' || Array.isArray(span))
    throw Error(`${where}: span must be an object`);
  for (const [key, value] of Object.entries(span)) {
    if (!['within', 'outside', 'only', 'except'].includes(key))
      throw Error(`${where}: span.${key} is not one of within, outside, only, except`);
    if (!isStrings(value)) throw Error(`${where}: span.${key} must be a list of paths`);
  }
}

function checkDedupe(where: string, dedupe: unknown): void {
  if (dedupe === undefined) return;
  if (!dedupe || typeof dedupe !== 'object' || Array.isArray(dedupe))
    throw Error(`${where} must be an object`);
  for (const [key, value] of Object.entries(dedupe))
    if (!['content', 'sections'].includes(key) || typeof value !== 'boolean')
      throw Error(`${where} takes boolean content and sections`);
}

/** Validates `composition` against the ladder it resolves to. */
export function validateCompositionSettings(
  settings: CompositionSettings | undefined,
  ladder: readonly InstructionNodeSettings[],
): void {
  if (!settings) return;
  const loading = settings.harnessLoading;
  if (loading !== undefined && loading !== 'suppress' && loading !== 'load')
    throw Error('composition.harnessLoading must be "suppress" or "load"');
  if (
    settings.preset !== undefined &&
    settings.preset !== 'claude-code' &&
    settings.preset !== 'none'
  )
    throw Error('composition.preset must be "claude-code" or "none"');
  checkDedupe('composition.dedupe', settings.dedupe);
  for (const [id, node] of Object.entries(settings.nodes ?? {})) {
    const where = `composition.nodes.${id}`;
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
    for (const key of ['label', 'parent', 'anchor'] as const)
      if (node[key] !== undefined && (typeof node[key] !== 'string' || !node[key]))
        throw Error(`${where}: ${key} must be a non-empty string`);
    if (node.owns !== undefined) {
      if (!node.owns || typeof node.owns !== 'object' || Array.isArray(node.owns))
        throw Error(`${where}: owns must be an object`);
      for (const [key, value] of Object.entries(node.owns)) {
        if (!['names', 'within', 'dirs'].includes(key))
          throw Error(`${where}: owns.${key} is not one of names, within, dirs`);
        if (!isStrings(value)) throw Error(`${where}: owns.${key} must be a list of strings`);
      }
    }
    if (node.imports !== undefined && node.imports !== 'anywhere' && !isStrings(node.imports))
      throw Error(`${where}: imports is "anywhere" or a list of roots`);
    if (!Array.isArray(node.sources) || !node.sources.length)
      throw Error(`${where}: sources must list at least one source`);
    for (const [i, source] of node.sources.entries()) {
      const at = `${where}.sources[${i}]`;
      if (!source || typeof source !== 'object' || Array.isArray(source))
        throw Error(`${at} must be an object`);
      if ('walk' in source) {
        for (const key of Object.keys(source))
          if (!['id', 'when', 'walk', 'span'].includes(key))
            throw Error(`${at}: unknown field ${key}`);
        checkMatch(at, source.when);
        if (!Array.isArray(source.walk) || !source.walk.length)
          throw Error(`${at}: walk must list at least one file`);
        for (const [j, file] of source.walk.entries()) checkFile(`${at}.walk[${j}]`, file);
        checkSpan(at, source.span);
      } else checkFile(at, source);
    }
  }
  const ids = new Set(ladder.map((node) => node.id));
  const parents = new Map(ladder.map((node) => [node.id, node.parent]));
  for (const node of ladder) {
    if (node.parent !== undefined && !ids.has(node.parent))
      throw Error(
        `composition.nodes.${node.id}: parent ${JSON.stringify(node.parent)} is not a node`,
      );
    const path = new Set<string>([node.id]);
    for (let up = node.parent; up !== undefined; up = parents.get(up)) {
      if (path.has(up)) throw Error(`composition.nodes.${node.id}: parent cycle through ${up}`);
      path.add(up);
    }
  }
  for (const [role, picks] of Object.entries(settings.roles ?? {})) {
    const where = `composition.roles.${role}`;
    if (!picks || typeof picks !== 'object' || Array.isArray(picks))
      throw Error(`${where} must be an object`);
    for (const key of Object.keys(picks))
      if (![...COMPOSITION_SLOTS, 'audience', 'dedupe', 'budget'].includes(key))
        throw Error(`${where}: unknown field ${key}`);
    for (const slot of COMPOSITION_SLOTS) {
      const pick = picks[slot];
      if (pick === undefined || pick === false) continue;
      if (!pick || typeof pick !== 'object' || Array.isArray(pick))
        throw Error(`${where}.${slot} is false or { exclude, general }`);
      for (const [key, value] of Object.entries(pick)) {
        if (key !== 'exclude' && key !== 'general')
          throw Error(`${where}.${slot}: unknown field ${key}`);
        if (key === 'general' && value === 'all') continue;
        if (!(Array.isArray(value) && value.every((id) => typeof id === 'string' && id)))
          throw Error(
            `${where}.${slot}.${key} must be a list of node ids${key === 'general' ? ' or "all"' : ''}`,
          );
        const unknown = value.filter((id) => !ids.has(id));
        if (unknown.length)
          throw Error(`${where}.${slot}.${key} names unknown nodes: ${unknown.join(', ')}`);
      }
    }
    if (picks.audience !== undefined && !CORPUS_TIERS.includes(picks.audience))
      throw Error(`${where}.audience must be one of ${CORPUS_TIERS.join(', ')}`);
    checkDedupe(`${where}.dedupe`, picks.dedupe);
    if (
      picks.budget !== undefined &&
      !(Number.isSafeInteger(picks.budget) && (picks.budget as number) > 0)
    )
      throw Error(`${where}.budget must be a positive whole number of characters`);
  }
}

/**
 * A role's picks with its defaults: budget none for main, DEFAULT_ROLE_BUDGET otherwise. A middleware
 * role's output reaches the main thread (a Warden chiming in), so its audience is never wider in what
 * it may read than main's: a team main thread makes every role team.
 */
export function roleComposition(
  settings: CompositionSettings | undefined,
  role: string,
): RoleComposition & { audience: CorpusTier; budget: number } {
  const picks = settings?.roles?.[role] ?? {};
  const main = settings?.roles?.[MAIN_ROLE]?.audience ?? 'personal_private';
  const own = picks.audience ?? 'personal_private';
  return {
    ...picks,
    audience: role === MAIN_ROLE || AUDIENCE_RANK[own] >= AUDIENCE_RANK[main] ? own : main,
    budget: picks.budget ?? (role === MAIN_ROLE ? Number.POSITIVE_INFINITY : DEFAULT_ROLE_BUDGET),
  };
}
