import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import {
  type ContextSource,
  dedupeHierarchySlots,
  discoverHierarchy,
  type HierarchyDedupeOptions,
  type HierarchyDuplicate,
  type HierarchyFile,
  type HierarchyNode,
  type HierarchyRefusal,
  hierarchyFingerprint,
  type OwnershipScope,
  type SourceSelectionReport,
} from '@inixiative/foundry-core';
import { type CorpusTier, visibleTo } from '../agents/corpus-compiler';
import { resolveSubscriptionPolicy } from '../providers/subscription-policy';
import type { FoundryConfig } from '../viewer/config';
import { resolveProjectView } from '../viewer/config-resolve';
import {
  COMPOSITION_SLOTS,
  type CompositionSlot,
  DEFAULT_INSTRUCTION_LADDER,
  HARNESS_GLOBAL_SOURCE,
  type InstructionNodeSettings,
  MAIN_ROLE,
  type RoleComposition,
  resolveInstructionLadder,
  roleComposition,
} from './instruction-settings';

/**
 * Standing context: the instruction files a coding agent reads before any message. Foundry composes
 * them for any harness from a registered hierarchy (core `discoverHierarchy`): a ladder or tree of
 * nodes (computer, org, project; shared or personal), each naming its files and corpus tier. The
 * default ladder is Claude Code's own discovery (docs/usage-and-context.md), so a Codex session gets
 * CLAUDE.md and a Claude session gets AGENTS.md; `composition.nodes` registers more.
 */
export type InstructionHarness = 'claude' | 'codex';
/** The default ladder's nodes. */
export type InstructionLevel = 'managed' | 'global' | 'org' | 'project' | 'local' | 'memory';

/** Each default level's corpus tier: personal files stay personal_private, committed ones are team, files above the repo are org. */
export const INSTRUCTION_LEVEL_TIER: Readonly<Record<InstructionLevel, CorpusTier>> = {
  managed: 'org',
  global: 'personal_private',
  org: 'org',
  project: 'team',
  local: 'personal_private',
  memory: 'personal_private',
};

const LEVEL_LABEL: Readonly<Record<InstructionLevel, string>> = {
  managed: 'managed policy instructions for every user on this machine',
  global: "user's private global instructions for all projects",
  org: 'organization instructions, above the project',
  project: 'project instructions, checked into the codebase',
  local: "user's private project instructions, not checked in",
  memory: "user's auto-memory, persists across conversations",
};

/** Claude Code's own preamble for its instruction files. */
const PREAMBLE =
  'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.';

export interface InstructionStackFile extends HierarchyFile {
  /** The node the file belongs to: a default level, or a registered node's id. */
  readonly level: string;
  readonly tier: CorpusTier;
}

export interface InstructionStack {
  readonly files: InstructionStackFile[];
  /** Files reached a second time; the first reach was kept. */
  readonly duplicates: HierarchyDuplicate[];
  /** Files refused: a secret, or a real path outside their node's boundary. */
  readonly refused: readonly HierarchyRefusal[];
  /** Every path discovery consulted, found or not (`hierarchyFingerprint`). */
  readonly probes: readonly string[];
  /** Labels of the nodes that were registered, by id. */
  readonly labels: Readonly<Record<string, string>>;
}

export interface InstructionStackOptions {
  /** Where the session runs; discovery walks up from here. */
  cwd: string;
  /** Picks the personal global file: `~/.claude/CLAUDE.md` or `$CODEX_HOME/AGENTS.md`. */
  harness: InstructionHarness;
  home?: string;
  /** Default: CLAUDE_CONFIG_DIR, else ~/.claude. */
  claudeConfigDir?: string;
  /** Default: CODEX_HOME, else ~/.codex. */
  codexHome?: string;
  /** Default: the platform's Claude Code managed CLAUDE.md. */
  managedPath?: string;
  /** Leave out the global file: the harness reads that same file itself and cannot be told not to. */
  harnessLoadsGlobal?: boolean;
  /** The ladder (`resolveInstructionLadder`). Default: the default ladder. */
  ladder?: readonly InstructionNodeSettings[];
  /** The thread's project and owner, for nodes registered by project or owner. */
  projectId?: string;
  projectPath?: string;
  owner?: string;
  /** The role composed for (`{role}` in paths). Default: main. */
  role?: string;
  /** The slot composed (`{slot}` in paths). Default: instructions. */
  slot?: CompositionSlot;
  /** Which nodes' unslotted files compose into the slot. Default: all for instructions, none otherwise. */
  unslotted?: 'all' | readonly string[];
}

const TIER_RANK: Readonly<Record<CorpusTier, number>> = {
  personal_private: 0,
  personal_public: 1,
  team: 2,
  org: 3,
};

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** The working tree root: the nearest directory holding `.git`, or the cwd outside a repository. */
export function projectRoot(cwd: string): string {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return resolve(cwd);
  }
}

/** The repository auto memory is keyed by: worktrees share their main checkout's. */
export function memoryRoot(cwd: string): string {
  const root = projectRoot(cwd);
  const dotGit = join(root, '.git');
  if (!isFile(dotGit)) return root;
  const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
  if (!gitdir) return root;
  const worktreeGit = resolve(root, gitdir);
  const common = join(worktreeGit, 'commondir');
  if (!isFile(common)) return root;
  const commonDir = resolve(worktreeGit, readFileSync(common, 'utf8').trim());
  return commonDir.endsWith(`${sep}.git`) ? dirname(commonDir) : root;
}

/** Claude Code's `projects/<name>` for a path: every non-alphanumeric character becomes `-`. */
export function claudeProjectDirName(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

/** A node's tier when its settings name none: personal is personal_private, shared project is team, the rest org. */
export function defaultNodeTier(
  node: Pick<InstructionNodeSettings, 'scope' | 'personal'>,
): CorpusTier {
  if (node.personal) return 'personal_private';
  return node.scope === 'project' ? 'team' : 'org';
}

/** Default imports for a node: personal computer-level files import from anywhere, others stay inside the repository or their own directory. */
const BOUNDED_IMPORTS = ['{project}', '{repository}', '{dir}'] as const;

function toHierarchyNode(node: InstructionNodeSettings): HierarchyNode {
  return {
    id: node.id,
    scope: node.scope,
    personal: node.personal,
    tier: node.tier ?? defaultNodeTier(node),
    ...(node.label ? { label: node.label } : {}),
    ...(node.parent ? { parent: node.parent } : {}),
    ...(node.when ? { when: node.when } : {}),
    ...(node.anchor ? { anchor: node.anchor } : {}),
    sources: node.sources,
    imports: node.imports ?? BOUNDED_IMPORTS,
    ...(node.owns ? { owns: node.owns } : {}),
  };
}

/** A node's label in the composed prompt. */
export function instructionNodeLabel(node: InstructionNodeSettings): string {
  if (node.label) return node.label;
  if (node.id in LEVEL_LABEL) return LEVEL_LABEL[node.id as InstructionLevel];
  return `${node.personal ? "user's private " : ''}${node.scope} instructions (${node.id})`;
}

/**
 * Every standing instruction file for a session at `cwd`, in composition order: computer-level
 * nodes, then each directory from the filesystem root down to the cwd, ladder order within a place.
 * Each file is followed by its `@path` imports. With the default ladder this is Claude Code's own
 * load order. Subdirectory files and path-scoped rules, which Claude Code loads on demand, are not included.
 */
export async function discoverInstructionStack(
  options: InstructionStackOptions,
): Promise<InstructionStack> {
  const home = options.home ?? homedir();
  const cwd = resolve(options.cwd);
  // A worktree's main checkout is the same repository, not the organization above it.
  const repository = memoryRoot(cwd);
  const claudeDir =
    options.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(home, '.codex');
  const ladder = options.ladder ?? DEFAULT_INSTRUCTION_LADDER;
  const stack = await discoverHierarchy(
    ladder.map(toHierarchyNode),
    {
      cwd,
      home,
      harness: options.harness,
      role: options.role ?? MAIN_ROLE,
      slot: options.slot ?? 'instructions',
      unslotted:
        options.unslotted ?? ((options.slot ?? 'instructions') === 'instructions' ? 'all' : []),
      ...(options.harnessLoadsGlobal ? { harnessLoads: [HARNESS_GLOBAL_SOURCE] } : {}),
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.owner ? { owner: options.owner } : {}),
      // The harness homes may sit under a credential directory (CLAUDE_CONFIG_DIR=~/.config/claude).
      trusted: [resolve(claudeDir), resolve(codexHome)],
      vars: {
        home: resolve(home),
        cwd,
        project: projectRoot(cwd),
        repository,
        claudeConfigDir: claudeDir,
        codexHome,
        managed:
          options.managedPath ??
          (process.platform === 'darwin'
            ? '/Library/Application Support/ClaudeCode/CLAUDE.md'
            : '/etc/claude-code/CLAUDE.md'),
        claudeProjectKey: claudeProjectDirName(repository),
        projectId: options.projectId,
        projectPath: options.projectPath,
      },
    },
    { tierRank: (tier) => TIER_RANK[tier as CorpusTier] },
  );
  return {
    files: stack.files.map((file) => ({
      ...file,
      level: file.node,
      tier: file.tier as CorpusTier,
    })),
    duplicates: stack.duplicates,
    refused: stack.refused,
    probes: stack.probes,
    labels: Object.fromEntries(ladder.map((node) => [node.id, instructionNodeLabel(node)])),
  };
}

export interface ComposedInstructions {
  readonly text: string;
  /** The files composed, after selection, audience filtering and dedupe. */
  readonly files: InstructionStackFile[];
  /** Files the audience may not see. */
  readonly hidden: InstructionStackFile[];
  /** Files of nodes the role excluded from this slot. */
  readonly excluded: InstructionStackFile[];
  /**
   * Everything removed as a duplicate: second reaches, identical files, identical sections.
   * `keptIn` names the other slot when the kept copy is there.
   */
  readonly duplicates: Array<HierarchyDuplicate & { keptIn?: CompositionSlot }>;
}

/** One role's composition: each slot's stack as discovered and as composed. */
export interface RoleView {
  readonly role: string;
  readonly stacks: Readonly<Record<CompositionSlot, InstructionStack>>;
  readonly slots: Readonly<Record<CompositionSlot, ComposedInstructions>>;
  /** Nodes whose general files the role pulled into a slot they do not compose by default. */
  readonly included: Readonly<Record<CompositionSlot, readonly string[]>>;
  /** Every path both slots consulted. */
  readonly probes: readonly string[];
  /** Their state when composed; empty when one changed while it was read (`roleViewChanged`). */
  readonly fingerprint: string;
}

const EMPTY_STACK: InstructionStack = {
  files: [],
  duplicates: [],
  refused: [],
  probes: [],
  labels: {},
};

/**
 * Whether any file or directory a view consulted changed since it was composed: an edited, added,
 * removed or re-pointed CLAUDE.md, rule, role file or memory. One stat per consulted path.
 */
export function roleViewChanged(view: RoleView): boolean {
  return !view.fingerprint || hierarchyFingerprint(view.probes) !== view.fingerprint;
}

/** A view's fingerprint, or none when a consulted path was modified once reading began. */
function viewFingerprint(probes: readonly string[], startedAt: number): string {
  const now = Date.now();
  for (const path of probes) {
    try {
      const modified = statSync(path).mtimeMs;
      // A future timestamp (clock skew) is not a write during the read.
      if (modified >= startedAt && modified <= now + 1_000) return '';
    } catch {
      /* absent: part of the fingerprint */
    }
  }
  return hierarchyFingerprint(probes);
}

/** A slot's files as one block. Instructions carry Claude Code's preamble; domain knowledge does not. */
function renderSlot(
  slot: CompositionSlot,
  files: readonly InstructionStackFile[],
  labels: Readonly<Record<string, string>>,
): string {
  const sections = files
    .filter((file) => file.content.trim())
    .map(
      (file) =>
        `Contents of ${file.path} (${labels[file.level] ?? file.level}):\n\n${file.content.trim()}`,
    );
  if (!sections.length) return '';
  return (slot === 'instructions' ? [PREAMBLE, ...sections] : sections).join('\n\n');
}

/**
 * Every slot of one role from the ladder (docs/usage-and-context.md, "Composition view"): each slot
 * gets the files that apply to it (role files, plus CLAUDE.md and the like for instructions and for
 * any node the role includes), minus the nodes it excludes; then files the role's audience may not
 * see are hidden, and repeats are removed across both slots, keeping the later copy (so a file in
 * both slots stays in domain knowledge).
 */
export async function composeRoleView(
  options: Omit<InstructionStackOptions, 'role' | 'slot' | 'unslotted'> & {
    role: string;
    picks?: RoleComposition;
    dedupe?: HierarchyDedupeOptions;
  },
): Promise<RoleView> {
  const { picks = {}, dedupe, ...discover } = options;
  const startedAt = Date.now() - 1;
  const audience = picks.audience ?? 'personal_private';
  const stacks = {} as Record<CompositionSlot, InstructionStack>;
  const included = {} as Record<CompositionSlot, readonly string[]>;
  for (const slot of COMPOSITION_SLOTS) {
    const pick = picks[slot];
    const general = (pick ? pick.general : undefined) ?? (slot === 'instructions' ? 'all' : []);
    included[slot] = slot === 'instructions' || general === 'all' ? [] : [...general];
    stacks[slot] =
      pick === false
        ? EMPTY_STACK
        : await discoverInstructionStack({ ...discover, slot, unslotted: general });
  }
  const parts = COMPOSITION_SLOTS.map((slot) => {
    const pick = picks[slot];
    const exclude = new Set(pick ? (pick.exclude ?? []) : []);
    const files = stacks[slot].files;
    const excluded = files.filter((file) => exclude.has(file.level));
    const kept = files.filter((file) => !exclude.has(file.level));
    return {
      excluded,
      hidden: kept.filter((file) => !visibleTo(file.tier, audience)),
      visible: kept.filter((file) => visibleTo(file.tier, audience)),
    };
  });
  const deduped = dedupeHierarchySlots(
    parts.map((part) => part.visible),
    { ...dedupe, ...picks.dedupe },
  );
  const slots = {} as Record<CompositionSlot, ComposedInstructions>;
  COMPOSITION_SLOTS.forEach((slot, i) => {
    const files = deduped.slots[i]!.filter((file) => file.content.trim());
    slots[slot] = {
      text: renderSlot(slot, files, stacks[slot].labels),
      files,
      hidden: parts[i]!.hidden,
      excluded: parts[i]!.excluded,
      // Each removal is reported on the slot whose copy was removed.
      duplicates: [
        ...stacks[slot].duplicates,
        ...deduped.duplicates
          .filter((duplicate) => duplicate.slot === i)
          .map(({ slot: _slot, keptSlot, ...duplicate }) => ({
            ...duplicate,
            ...(keptSlot !== i ? { keptIn: COMPOSITION_SLOTS[keptSlot] } : {}),
          })),
      ],
    };
  });
  const probes = [...new Set(COMPOSITION_SLOTS.flatMap((slot) => stacks[slot].probes))];
  return {
    role: options.role,
    stacks,
    slots,
    included,
    probes,
    fingerprint: viewFingerprint(probes, startedAt),
  };
}

const DUPLICATE_REASON: Readonly<Record<HierarchyDuplicate['kind'], string>> = {
  path: 'same file reached again',
  content: 'identical content to a more specific file',
  section: 'identical section in a more specific file',
};

const REFUSAL_REASON: Readonly<Record<HierarchyRefusal['reason'], string>> = {
  secret: 'refused: a dotfile, key or credential directory, as written or where it leads',
  'outside-boundary': "refused: it resolves outside its level's boundary",
};

/** One slot of a role view as a selection report, so the viewer's Selection panel shows what was picked and why. */
export function instructionStackReport(
  view: RoleView,
  slot: CompositionSlot,
  audience: CorpusTier,
): SourceSelectionReport {
  const stack = view.stacks[slot];
  const composed = view.slots[slot];
  const included = new Set(view.included[slot]);
  const label = (level: string) =>
    `${stack.labels[level] ?? level}${included.has(level) ? ` [included in ${slot} by composition.roles.${view.role}]` : ''}`;
  const chars = stack.files.reduce((sum, file) => sum + file.content.length, 0);
  return {
    subject: 'instructions',
    selected: composed.files.map((file) => ({
      id: file.path,
      reason: label(file.level),
      chars: file.content.length,
      kind: file.level,
    })),
    omitted: [
      ...composed.excluded.map((file) => ({
        id: file.path,
        reason: `excluded from ${slot} by composition.roles.${view.role}`,
        chars: file.content.length,
        kind: file.level,
      })),
      ...composed.hidden.map((file) => ({
        id: file.path,
        reason: `not visible to ${audience}`,
        chars: file.content.length,
        kind: file.level,
      })),
      ...stack.refused.map((refusal) => ({
        id: refusal.path,
        reason: REFUSAL_REASON[refusal.reason],
        chars: 0,
        kind: refusal.node,
      })),
      ...composed.duplicates.map((duplicate) => ({
        id: duplicate.heading ? `${duplicate.path} § ${duplicate.heading}` : duplicate.path,
        reason: DUPLICATE_REASON[duplicate.kind],
        chars: duplicate.chars,
        kind: duplicate.node,
        duplicateOf: `${duplicate.keptPath} (${duplicate.keptNode}${duplicate.keptIn ? `, ${duplicate.keptIn}` : ''})`,
      })),
    ],
    considered: stack.files.length,
    retained: { count: stack.files.length, chars },
    budget: { chars: 0, used: composed.text.length, exceeded: false },
    conflicts: [],
  };
}

/** A role's two slots warm together: one composition serves both. */
const SHARED_VIEW_MS = 250;
const sharedViews = new Map<string, { at: number; view: Promise<RoleView>; settled?: RoleView }>();
/** Advances whenever a caller says the files changed (`invalidateComposition`). */
let generation = 0;
/** Drop shared compositions and mark every composed slot changed, so the next load reads the files again. */
export function forgetSharedRoleViews(): void {
  sharedViews.clear();
  generation++;
}

function sharedRoleView(options: Parameters<typeof composeRoleView>[0]): Promise<RoleView> {
  const key = JSON.stringify(options);
  const now = Date.now();
  for (const [k, entry] of sharedViews) if (now - entry.at > SHARED_VIEW_MS) sharedViews.delete(k);
  const hit = sharedViews.get(key);
  // A shared view is reused only while nothing it read has changed.
  if (hit && !(hit.settled && roleViewChanged(hit.settled))) return hit.view;
  const view = composeRoleView(options);
  const entry: { at: number; view: Promise<RoleView>; settled?: RoleView } = { at: now, view };
  sharedViews.set(key, entry);
  view.then(
    (settled) => {
      entry.settled = settled;
    },
    () => {
      if (sharedViews.get(key) === entry) sharedViews.delete(key);
    },
  );
  return view;
}

export interface InstructionStackSourceOptions
  extends Omit<
    InstructionStackOptions,
    'cwd' | 'projectId' | 'projectPath' | 'owner' | 'role' | 'slot' | 'unslotted'
  > {
  /** The role composed for. Default: main. */
  role?: string;
  /** The slot this source returns. Default: instructions. */
  slot?: CompositionSlot;
  /** The role's picks (`composition.roles[role]`). */
  picks?: RoleComposition;
  dedupe?: HierarchyDedupeOptions;
  /** Where a thread with no cwd works: its project's directory. */
  projectPath?: (projectId: string) => string | undefined;
  /** The thread project's owner, for nodes registered by owner. */
  owner?: (projectId: string | undefined) => string | undefined;
}

/**
 * A layer source returning one slot of one role's composition for the session's location. Bound to
 * a thread, it follows the thread's cwd (its worktree or project) and project; unbound, it reads
 * from the process's cwd.
 */
export function instructionStackSource(
  id: string,
  options: InstructionStackSourceOptions,
  scope?: OwnershipScope,
): ContextSource {
  let last: SourceSelectionReport | undefined;
  let loaded: { view: RoleView; generation: number } | undefined;
  return {
    id,
    bind: (next) => instructionStackSource(id, options, next),
    // Checked before every assembly: an edited, added or removed instruction or role file, or an
    // `invalidateComposition()`, makes the slot re-read on the next turn and reach it as a delta.
    changed: () => !!loaded && (loaded.generation !== generation || roleViewChanged(loaded.view)),
    async load() {
      const at = generation;
      const projectId = scope?.projectId;
      const projectPath = projectId ? options.projectPath?.(projectId) : undefined;
      const owner = options.owner?.(projectId);
      const {
        projectPath: _path,
        owner: _owner,
        role = MAIN_ROLE,
        slot = 'instructions',
        picks,
        dedupe,
        ...discover
      } = options;
      const view = await sharedRoleView({
        ...discover,
        role,
        ...(picks ? { picks } : {}),
        ...(dedupe ? { dedupe } : {}),
        cwd: scope?.cwd ?? projectPath ?? process.cwd(),
        ...(projectId ? { projectId } : {}),
        ...(projectPath ? { projectPath } : {}),
        ...(owner ? { owner } : {}),
      });
      last = instructionStackReport(view, slot, picks?.audience ?? 'personal_private');
      loaded = { view, generation: at };
      return view.slots[slot].text;
    },
    report: () => last,
  };
}

/**
 * The source for one role's slot under `config`: the registered ladder, the role's picks and the
 * harness the global file follows. The main thread's `instructions` source and every middleware
 * role's slots are this one source. `delivered` names the slots the role actually receives: a slot
 * nobody delivers is not composed, so dedupe never moves text into it.
 */
export function compositionSource(
  config: FoundryConfig,
  id: string,
  role: string,
  slot: CompositionSlot,
  delivered: readonly CompositionSlot[],
): ContextSource {
  const settings = config.composition;
  const { budget: _budget, ...picks } = roleComposition(settings, role);
  for (const other of COMPOSITION_SLOTS) if (!delivered.includes(other)) picks[other] = false;
  return instructionStackSource(id, {
    harness: config.defaults.provider === 'codex' ? 'codex' : 'claude',
    harnessLoadsGlobal: codexReadsUserHome(config),
    role,
    slot,
    ladder: resolveInstructionLadder(settings),
    picks,
    ...(settings?.dedupe ? { dedupe: settings.dedupe } : {}),
    projectPath: (projectId) => config.projects[projectId]?.path,
    owner: (projectId) =>
      (projectId ? config.projects[projectId]?.defaults?.kingdomOwnerKey : undefined) ??
      config.defaults.kingdomOwnerKey,
  });
}

/** Claude Code skips every CLAUDE.md, rule, AGENTS.md and auto memory file at launch and on demand. */
export const CLAUDE_HARNESS_INSTRUCTIONS_OFF: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
});

/** Codex app-server skips project AGENTS.md files; its CODEX_HOME AGENTS.md is not a thread setting. */
export const CODEX_HARNESS_INSTRUCTIONS_OFF: Readonly<Record<string, unknown>> = Object.freeze({
  project_doc_max_bytes: 0,
});

/** Whether the native harness loads instruction files itself (`composition.harnessLoading`). */
export function harnessLoadsInstructions(config: FoundryConfig): boolean {
  const explicit = config.composition?.harnessLoading;
  if (explicit) return explicit === 'load';
  const views = [
    config,
    ...Object.entries(config.projects ?? {})
      .filter(([, project]) => project.enabled !== false)
      .map(([id]) => resolveProjectView(config, id)?.config),
  ];
  const composes = (view: FoundryConfig) =>
    Object.values(view.layers ?? {}).some(
      (layer) =>
        layer.enabled &&
        (layer.sourceIds ?? []).some(
          (id) => view.sources[id]?.enabled && view.sources[id]?.type === 'instructions',
        ),
    );
  // Suppression is process-wide, so it needs every view to compose: otherwise a thread could get neither.
  return !views.every((view) => !view || composes(view));
}

/**
 * True when the Codex worker runs on the user's own CODEX_HOME (no subscription or native
 * authentication), so Codex reads `$CODEX_HOME/AGENTS.md` itself with no way to turn it off.
 */
export function codexReadsUserHome(config: FoundryConfig): boolean {
  if (config.defaults.provider !== 'codex') return false;
  try {
    if (resolveSubscriptionPolicy(config)) return false;
  } catch {
    return false;
  }
  return (
    !config.defaults.kingdomOwnerKey &&
    !Object.keys(config.kingdomInferenceAssignments ?? {}).length &&
    !config.defaults.nativeAuthenticationId &&
    !Object.keys(config.nativeAuthenticationSelections ?? {}).length
  );
}
