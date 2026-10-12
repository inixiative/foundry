import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { ruleMarker } from './sharpen';
import {
  type FeedbackApplyRecord,
  type FeedbackLevel,
  type FeedbackSlot,
  WRITABLE_LEVELS,
} from './types';

/** Where a role file lives on each rung (the composition view's default preset). */
export interface LevelRoots {
  readonly home?: string;
  /** The project's root directory. */
  readonly project?: string;
  /** The org directory the composer walks above the project (default: the project's parent). */
  readonly org?: string;
}

export function roleFilePath(
  level: FeedbackLevel,
  role: string,
  slot: FeedbackSlot,
  roots: LevelRoots,
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(role) || role.includes('..'))
    throw Error(`Invalid role id: ${role}`);
  const file = (dir: string, personal: boolean) =>
    join(dir, '.foundry', 'roles', role, `${slot}${personal ? '.local' : ''}.md`);
  const project = roots.project;
  const org = roots.org ?? (project ? dirname(project) : undefined);
  switch (level) {
    case 'computer':
      return join(roots.home ?? homedir(), '.foundry', 'roles', role, `${slot}.md`);
    case 'org':
    case 'org-personal':
      if (!org) throw Error('No org directory for this thread');
      return file(org, level === 'org-personal');
    case 'project':
    case 'project-personal':
      if (!project) throw Error('No project directory for this thread');
      return file(project, level === 'project-personal');
  }
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');

function git(cwd: string, args: string[]): { code: number; out: string } {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode, out: result.stdout.toString().trim() };
}

export const PERSONAL_ROLE_PATTERN = '.foundry/roles/**/*.local.md';
/** On the computer rung the files are not `.local`; a home directory under git keeps them out too. */
const COMPUTER_ROLE_PATTERN = '.foundry/roles/';

/**
 * A personal role file inside a git checkout must stay out of git: refuse a tracked path, and add the
 * pattern to the repo's local `info/exclude` (never a committed file) when nothing ignores it yet.
 */
export function guardPersonalFile(path: string): void {
  const dir = dirname(path);
  let probe = dir;
  while (!existsSync(probe)) probe = dirname(probe);
  const top = git(probe, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return;
  // git reports the real path (macOS /var is /private/var); compare like with like.
  const rel = relative(top.out, join(realpathSync(probe), relative(probe, path)));
  if (git(top.out, ['ls-files', '--error-unmatch', rel]).code === 0)
    throw Error(`Refusing to edit a tracked file: ${rel}`);
  if (git(top.out, ['check-ignore', '-q', '--no-index', rel]).code === 0) return;
  const exclude = git(top.out, ['rev-parse', '--git-path', 'info/exclude']).out;
  const excludePath = exclude.startsWith('/') ? exclude : join(top.out, exclude);
  mkdirSync(dirname(excludePath), { recursive: true });
  const current = read(excludePath);
  appendFileSync(
    excludePath,
    `${current && !current.endsWith('\n') ? '\n' : ''}# Foundry personal role files\n${rel.endsWith('.local.md') ? PERSONAL_ROLE_PATTERN : COMPUTER_ROLE_PATTERN}\n`,
  );
  if (git(top.out, ['check-ignore', '-q', '--no-index', rel]).code !== 0)
    throw Error(`Could not keep ${rel} out of git`);
}

export interface ApplyChange {
  readonly itemId: string;
  readonly changeId: string;
  readonly statement: string;
  readonly role: string;
  readonly slot: FeedbackSlot;
  readonly level: FeedbackLevel;
  readonly roots: LevelRoots;
}

/** Append one rule line to a role file on a personal rung. Returns the journal record of the change. */
export function applyChange(change: ApplyChange): FeedbackApplyRecord {
  if (!WRITABLE_LEVELS.includes(change.level))
    throw Error(`${change.level} is committed; it changes through a pull request, not here`);
  const path = roleFilePath(change.level, change.role, change.slot, change.roots);
  guardPersonalFile(path);
  const before = read(path);
  const line = `- ${change.statement.trim()} ${ruleMarker(change.itemId)}`;
  const heading = before
    ? ''
    : `# ${change.role}: ${change.slot === 'instructions' ? 'instructions' : 'domain knowledge'} from feedback\n\n`;
  const after = `${heading}${before}${before && !before.endsWith('\n') ? '\n' : ''}${line}\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, after);
  return {
    itemId: change.itemId,
    changeId: change.changeId,
    role: change.role,
    slot: change.slot,
    level: change.level,
    path,
    line,
    beforeHash: sha(before),
    afterHash: sha(after),
  };
}

/** Remove exactly the line a change added. A line already gone is reported, not re-created. */
export function revertChange(
  applied: FeedbackApplyRecord,
): FeedbackApplyRecord & { found: boolean } {
  const before = read(applied.path);
  const lines = before.split('\n');
  const index = lines.indexOf(applied.line);
  if (index === -1)
    return { ...applied, beforeHash: sha(before), afterHash: sha(before), found: false };
  lines.splice(index, 1);
  const after = lines.join('\n');
  writeFileSync(applied.path, after);
  return { ...applied, beforeHash: sha(before), afterHash: sha(after), found: true };
}

/**
 * A thread's rungs. The composer walks from the filesystem root to the thread's cwd, so a personal file
 * in the project's checkout is read from its worktrees beneath it too: the project rung is the
 * configured project directory when the cwd is inside it, else the cwd's repository. The org rung is
 * the directory above the project.
 */
export function feedbackRoots(
  thread: { meta: { projectId?: string; cwd?: string } },
  config: { projects: Record<string, { path?: string } | undefined> },
): LevelRoots {
  const projectId = thread.meta.projectId;
  const configured = projectId ? config.projects[projectId]?.path : undefined;
  const cwd = thread.meta.cwd;
  const inside = (dir: string, root: string) => {
    const rel = relative(root, dir);
    return !rel.startsWith('..') && !rel.startsWith('/');
  };
  let project = configured;
  if (cwd && (!configured || !inside(cwd, configured))) {
    const top = git(cwd, ['rev-parse', '--show-toplevel']);
    project = top.code === 0 ? top.out : cwd;
  }
  return { home: homedir(), ...(project ? { project, org: dirname(project) } : {}) };
}
