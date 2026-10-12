import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import {
  type ContextSource,
  dedupeHierarchy,
  discoverHierarchy,
  type HierarchyDedupeOptions,
  type HierarchyDuplicate,
  type HierarchyFile,
  type HierarchyNode,
  type OwnershipScope,
  type SourceSelectionReport,
} from '@inixiative/foundry-core';
import { type CorpusTier, visibleTo } from '../agents/corpus-compiler';
import { resolveSubscriptionPolicy } from '../providers/subscription-policy';
import type { FoundryConfig } from '../viewer/config';
import { resolveProjectView } from '../viewer/config-resolve';
import {
  DEFAULT_INSTRUCTION_LADDER,
  HARNESS_GLOBAL_SOURCE,
  type InstructionNodeSettings,
} from './instruction-settings';

/**
 * Standing context: the instruction files a coding agent reads before any message. Foundry composes
 * them for any harness from a registered hierarchy (core `discoverHierarchy`): a ladder or tree of
 * nodes (computer, org, project; shared or personal), each naming its files and corpus tier. The
 * default ladder is Claude Code's own discovery (docs/usage-and-context.md), so a Codex session gets
 * CLAUDE.md and a Claude session gets AGENTS.md; `instructions.nodes` registers more.
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
  const ladder = options.ladder ?? DEFAULT_INSTRUCTION_LADDER;
  const stack = await discoverHierarchy(
    ladder.map(toHierarchyNode),
    {
      cwd,
      home,
      harness: options.harness,
      ...(options.harnessLoadsGlobal ? { harnessLoads: [HARNESS_GLOBAL_SOURCE] } : {}),
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.owner ? { owner: options.owner } : {}),
      vars: {
        home: resolve(home),
        cwd,
        project: projectRoot(cwd),
        repository,
        claudeConfigDir: claudeDir,
        codexHome: options.codexHome ?? process.env.CODEX_HOME ?? join(home, '.codex'),
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
    labels: Object.fromEntries(ladder.map((node) => [node.id, instructionNodeLabel(node)])),
  };
}

export interface ComposedInstructions {
  readonly text: string;
  /** The files composed, after audience filtering and dedupe. */
  readonly files: InstructionStackFile[];
  /** Files the audience may not see. */
  readonly hidden: InstructionStackFile[];
  /** Everything removed as a duplicate: second reaches, identical files, identical sections. */
  readonly duplicates: HierarchyDuplicate[];
}

/**
 * The stack as one block for `audience`: a file reaches it only if its tier is visible there, then
 * repeated files and sections are removed, keeping the most specific copy.
 */
export function composeInstructionStack(
  stack: InstructionStack,
  options: { audience?: CorpusTier; dedupe?: HierarchyDedupeOptions } = {},
): ComposedInstructions {
  const audience = options.audience ?? 'personal_private';
  const visible = stack.files.filter((file) => visibleTo(file.tier, audience));
  const hidden = stack.files.filter((file) => !visibleTo(file.tier, audience));
  const deduped = dedupeHierarchy(visible, options.dedupe);
  const files = deduped.files.filter((file) => file.content.trim());
  const sections = files.map(
    (file) =>
      `Contents of ${file.path} (${stack.labels[file.level] ?? file.level}):\n\n${file.content.trim()}`,
  );
  return {
    text: sections.length ? [PREAMBLE, ...sections].join('\n\n') : '',
    files,
    hidden,
    duplicates: [...stack.duplicates, ...deduped.duplicates],
  };
}

const DUPLICATE_REASON: Readonly<Record<HierarchyDuplicate['kind'], string>> = {
  path: 'same file reached again',
  content: 'identical content to a more specific file',
  section: 'identical section in a more specific file',
};

/** The composition as a selection report, so the viewer's Selection panel shows what was deduped. */
export function instructionStackReport(
  stack: InstructionStack,
  composed: ComposedInstructions,
  audience: CorpusTier,
): SourceSelectionReport {
  const chars = stack.files.reduce((sum, file) => sum + file.content.length, 0);
  return {
    subject: 'instructions',
    selected: composed.files.map((file) => ({
      id: file.path,
      reason: stack.labels[file.level] ?? file.level,
      chars: file.content.length,
      kind: file.level,
    })),
    omitted: [
      ...composed.hidden.map((file) => ({
        id: file.path,
        reason: `not visible to ${audience}`,
        chars: file.content.length,
        kind: file.level,
      })),
      ...composed.duplicates.map((duplicate) => ({
        id: duplicate.heading ? `${duplicate.path} § ${duplicate.heading}` : duplicate.path,
        reason: DUPLICATE_REASON[duplicate.kind],
        chars: duplicate.chars,
        kind: duplicate.node,
        duplicateOf: `${duplicate.keptPath} (${duplicate.keptNode})`,
      })),
    ],
    considered: stack.files.length,
    retained: { count: stack.files.length, chars },
    budget: { chars: 0, used: composed.text.length, exceeded: false },
    conflicts: [],
  };
}

export interface InstructionStackSourceOptions
  extends Omit<InstructionStackOptions, 'cwd' | 'projectId' | 'projectPath' | 'owner'> {
  audience?: CorpusTier;
  dedupe?: HierarchyDedupeOptions;
  /** Where a thread with no cwd works: its project's directory. */
  projectPath?: (projectId: string) => string | undefined;
  /** The thread project's owner, for nodes registered by owner. */
  owner?: (projectId: string | undefined) => string | undefined;
}

/**
 * A layer source composing the stack for the session's location. Bound to a thread, it follows the
 * thread's cwd (its worktree or project) and project; unbound, it reads from the process's cwd.
 */
export function instructionStackSource(
  id: string,
  options: InstructionStackSourceOptions,
  scope?: OwnershipScope,
): ContextSource {
  let last: SourceSelectionReport | undefined;
  return {
    id,
    bind: (next) => instructionStackSource(id, options, next),
    async load() {
      const projectId = scope?.projectId;
      const projectPath = projectId ? options.projectPath?.(projectId) : undefined;
      const owner = options.owner?.(projectId);
      const {
        projectPath: _path,
        owner: _owner,
        audience: _audience,
        dedupe,
        ...discover
      } = options;
      const stack = await discoverInstructionStack({
        ...discover,
        cwd: scope?.cwd ?? projectPath ?? process.cwd(),
        ...(projectId ? { projectId } : {}),
        ...(projectPath ? { projectPath } : {}),
        ...(owner ? { owner } : {}),
      });
      const audience = options.audience ?? 'personal_private';
      const composed = composeInstructionStack(stack, {
        audience,
        ...(dedupe ? { dedupe } : {}),
      });
      last = instructionStackReport(stack, composed, audience);
      return composed.text;
    },
    report: () => last,
  };
}

/** Claude Code skips every CLAUDE.md, rule, AGENTS.md and auto memory file at launch and on demand. */
export const CLAUDE_HARNESS_INSTRUCTIONS_OFF: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
});

/** Codex app-server skips project AGENTS.md files; its CODEX_HOME AGENTS.md is not a thread setting. */
export const CODEX_HARNESS_INSTRUCTIONS_OFF: Readonly<Record<string, unknown>> = Object.freeze({
  project_doc_max_bytes: 0,
});

/** Whether the native harness loads instruction files itself (`instructions.harnessLoading`). */
export function harnessLoadsInstructions(config: FoundryConfig): boolean {
  const explicit = config.instructions?.harnessLoading;
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
        [
          ...(layer.sourceIds ?? []),
          ...(layer.chunks ?? []).flatMap((chunk) => chunk.sourceIds),
        ].some((id) => view.sources[id]?.enabled && view.sources[id]?.type === 'instructions'),
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
