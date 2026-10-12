import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  type ContextSource,
  type InstructionFile,
  type OwnershipScope,
  readInstructionFile,
  withinAny,
  withinPath,
} from '@inixiative/foundry-core';
import { type CorpusTier, visibleTo } from '../agents/corpus-compiler';
import { resolveSubscriptionPolicy } from '../providers/subscription-policy';
import type { FoundryConfig } from '../viewer/config';
import { resolveProjectView } from '../viewer/config-resolve';

/**
 * Standing context: the instruction files a coding agent reads before any message. Foundry
 * discovers them the way Claude Code does (docs/usage-and-context.md) and composes them for any
 * harness, so a Codex session gets CLAUDE.md and a Claude session gets AGENTS.md.
 */
export type InstructionLevel = 'managed' | 'global' | 'org' | 'project' | 'local' | 'memory';
export type InstructionHarness = 'claude' | 'codex';

/** Each level's corpus tier: personal files stay personal_private, committed ones are team, files above the repo are org. */
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

/** Claude Code loads the first 200 lines or 25KB of MEMORY.md, whichever is smaller. */
const MEMORY_LINES = 200;
const MEMORY_BYTES = 25 * 1024;

export interface InstructionStackFile extends InstructionFile {
  readonly level: InstructionLevel;
  readonly tier: CorpusTier;
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
  /** Leave out the global level: the harness reads that same file itself and cannot be told not to. */
  harnessLoadsGlobal?: boolean;
}

const within = withinPath;
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

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** A rule's text without its frontmatter. */
const ruleBody = (text: string) => text.replace(FRONTMATTER, '');

/** Rules that load at launch; a rule with `paths` frontmatter loads only beside matching files. */
async function ruleFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for await (const rel of new Bun.Glob('**/*.md').scan({ cwd: dir, followSymlinks: true })) {
    const path = join(dir, rel);
    let frontmatter: string | undefined;
    try {
      frontmatter = FRONTMATTER.exec(readFileSync(path, 'utf8'))?.[1];
    } catch {
      continue; // unreadable: Claude Code skips it too
    }
    if (!frontmatter || !/^paths\s*:/m.test(frontmatter)) found.push(path);
  }
  return found.sort();
}

/**
 * Every standing instruction file for a session at `cwd`, in the order Claude Code loads them
 * (verified against Claude Code 2.1.296): managed policy, the personal global file and its rules,
 * then each directory from the filesystem root down to the cwd (CLAUDE.md, .claude/CLAUDE.md,
 * .claude/rules, AGENTS.md, .claude/AGENTS.md, then CLAUDE.local.md), and auto memory last. Each
 * file is followed by its `@path` imports. Directories above the repository are the org level.
 * Subdirectory files and path-scoped rules, which Claude Code loads on demand, are not included.
 */
export async function discoverInstructionStack(
  options: InstructionStackOptions,
): Promise<InstructionStackFile[]> {
  const home = options.home ?? homedir();
  const cwd = resolve(options.cwd);
  const root = projectRoot(cwd);
  // A worktree's main checkout is the same repository, not the organization above it.
  const repository = memoryRoot(cwd);
  const claudeDir =
    options.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(home, '.codex');
  const seen = new Set<string>();
  const stack: InstructionStackFile[] = [];

  const personalDirs = withinAny([claudeDir, codexHome]);
  /** Where a file sits says how private it is, whoever imported it. */
  const located = (path: string): InstructionLevel | undefined => {
    if (basename(path) === 'CLAUDE.local.md') return 'local';
    if (personalDirs(path) || dirname(path) === home) return 'global';
    if (within(path, root) || within(path, repository)) return 'project';
    return undefined;
  };

  const add = async (path: string, level: InstructionLevel, body?: (text: string) => string) => {
    const personal = level === 'global' || level === 'managed';
    // Claude Code asks once before loading a project file's import from outside the project.
    // Foundry has no dialog: an import loads inside the project or the importing file's own tree.
    const allows = personal ? undefined : withinAny([root, repository, dirname(path)]);
    for (const file of await readInstructionFile(path, { home, seen, allows })) {
      const content = file.depth === 0 && body ? body(file.content) : file.content;
      // An import never widens: it keeps the narrower of its importer's tier and its own location's.
      const own = file.importedBy ? located(file.path) : undefined;
      const final =
        own && TIER_RANK[INSTRUCTION_LEVEL_TIER[own]] < TIER_RANK[INSTRUCTION_LEVEL_TIER[level]]
          ? own
          : level;
      stack.push({ ...file, content, level: final, tier: INSTRUCTION_LEVEL_TIER[final] });
    }
  };

  await add(
    options.managedPath ??
      (process.platform === 'darwin'
        ? '/Library/Application Support/ClaudeCode/CLAUDE.md'
        : '/etc/claude-code/CLAUDE.md'),
    'managed',
  );
  if (options.harnessLoadsGlobal) {
    // The harness reads the personal global file itself.
  } else if (options.harness === 'claude') {
    await add(join(claudeDir, 'CLAUDE.md'), 'global');
    for (const rule of await ruleFiles(join(claudeDir, 'rules')))
      await add(rule, 'global', ruleBody);
  } else {
    const override = join(codexHome, 'AGENTS.override.md');
    await add(isFile(override) ? override : join(codexHome, 'AGENTS.md'), 'global');
  }

  const dirs: string[] = [];
  for (let dir = cwd; dirname(dir) !== dir; dir = dirname(dir)) dirs.unshift(dir);
  for (const dir of dirs) {
    // The home directory is personal, and its .claude is the global level's (per harness), never org.
    const isHome = dir === resolve(home);
    const level: InstructionLevel = isHome
      ? 'global'
      : within(dir, root) || within(dir, repository)
        ? 'project'
        : 'org';
    await add(join(dir, 'CLAUDE.md'), level);
    if (!isHome) {
      await add(join(dir, '.claude', 'CLAUDE.md'), level);
      for (const rule of await ruleFiles(join(dir, '.claude', 'rules')))
        await add(rule, level, ruleBody);
    }
    await add(join(dir, 'AGENTS.md'), level);
    if (!isHome) await add(join(dir, '.claude', 'AGENTS.md'), level);
    await add(join(dir, 'CLAUDE.local.md'), 'local');
  }

  const memory = join(
    claudeDir,
    'projects',
    claudeProjectDirName(repository),
    'memory',
    'MEMORY.md',
  );
  if (isFile(memory) && !seen.has(realpathSync(memory))) {
    const lines = readFileSync(memory, 'utf8').split('\n').slice(0, MEMORY_LINES).join('\n');
    const content = Buffer.from(lines).subarray(0, MEMORY_BYTES).toString('utf8');
    stack.push({ path: memory, content, depth: 0, level: 'memory', tier: 'personal_private' });
  }
  return stack;
}

/** The stack as one block for `audience`: a file reaches it only if its tier is visible there. */
export function composeInstructionStack(
  files: readonly InstructionStackFile[],
  audience: CorpusTier = 'personal_private',
): string {
  const sections = files
    .filter((file) => file.content.trim() && visibleTo(file.tier, audience))
    .map(
      (file) => `Contents of ${file.path} (${LEVEL_LABEL[file.level]}):\n\n${file.content.trim()}`,
    );
  return sections.length ? [PREAMBLE, ...sections].join('\n\n') : '';
}

export interface InstructionStackSourceOptions extends Omit<InstructionStackOptions, 'cwd'> {
  audience?: CorpusTier;
  /** Where a thread with no cwd works: its project's directory. */
  projectPath?: (projectId: string) => string | undefined;
}

/**
 * A layer source composing the stack for the session's cwd. Bound to a thread, it follows the
 * thread's cwd (its worktree or project); unbound, it reads from the Foundry process's cwd.
 */
export function instructionStackSource(
  id: string,
  options: InstructionStackSourceOptions,
  scope?: OwnershipScope,
): ContextSource {
  return {
    id,
    bind: (next) => instructionStackSource(id, options, next),
    async load() {
      const files = await discoverInstructionStack({
        ...options,
        cwd:
          scope?.cwd ??
          (scope?.projectId ? options.projectPath?.(scope.projectId) : undefined) ??
          process.cwd(),
      });
      return composeInstructionStack(files, options.audience);
    },
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
