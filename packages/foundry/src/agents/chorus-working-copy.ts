/**
 * @atlas
 * @kind helper
 * @partOf feature:wardens
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { provenanceReferences } from '@inixiative/archive/tags';

/**
 * Where a checkout's chorus lives: the Chorus working copy of its repository,
 * `<CHORUS_HOME or ~/.chorus>/projects/<owner>/<repo>/`, laid out as `.foundry/` was (`regions/`,
 * `warden-brief.md`, `project.json` with its `chorus`). Regions left the public repositories for the
 * region store; the Chorus host (or `chorus store pull`) keeps the copy at the version the checkout
 * resolves to, and Foundry only reads it. The repository is the checkout's `origin`; with none, the
 * checkout has no copy and no Wardens.
 */
export function chorusWorkingCopyDir(projectPath: string): string | null {
  const slug = repositorySlugOfCheckout(projectPath);
  return slug
    ? join(process.env.CHORUS_HOME ?? join(homedir(), '.chorus'), 'projects', ...slug.split('/'))
    : null;
}

// `owner/repo` of the checkout's `origin`, read once per checkout and again only when its own `.git`
// comes or goes (a resolve runs on every request; a git spawn on each was minutes in the suite).
const repositorySlugOfCheckout = (projectPath: string): string | null => {
  const ownGit = existsSync(join(projectPath, '.git'));
  const known = slugByPath.get(projectPath);
  if (known && known.ownGit === ownGit) return known.slug;
  const remote = Bun.spawnSync(['git', '-C', projectPath, 'remote', 'get-url', 'origin'], {
    stderr: 'ignore',
  });
  const slug =
    (remote.success
      ? provenanceReferences({ repository: remote.stdout.toString().trim() })[0]?.ref
      : undefined) ?? null;
  slugByPath.set(projectPath, { slug, ownGit });
  return slug;
};

const slugByPath = new Map<string, { slug: string | null; ownGit: boolean }>();
