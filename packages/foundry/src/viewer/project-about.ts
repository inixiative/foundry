/**
 * @atlas
 * @kind service
 * @partOf feature:viewer
 */
/**
 * A project's About facts, from what Foundry already reads: its description, the hosted repository
 * (git origin, normalised by Archive like a thread's context), the worktree mode (FEAT-003) and the
 * Kingdoms whose access grants include it.
 */
import { provenanceReferences } from '@inixiative/archive/tags';
import { gitContext, worktreeMode } from '../git';
import type { KingdomAccessSource } from '../providers/kingdom-access-client';

export interface ProjectAbout {
  description: string | null;
  repository: { integration: string; ref: string } | null;
  worktreeMode: ReturnType<typeof worktreeMode>;
  kingdoms: string[];
  /** The Kingdom project this project links to (`kingdomProject`): its id and Kingdom. */
  kingdomProject: { kingdom: string; projectId: string } | null;
}

export async function projectAbout(
  project: { id: string; path: string; description?: string },
  kingdomAccess: readonly KingdomAccessSource[],
  kingdomProject?: { kingdom: string; projectId: string },
): Promise<ProjectAbout> {
  const git = await gitContext(project.path).catch(() => ({ remote: undefined }));
  const repository = provenanceReferences({ repository: git.remote })[0] ?? null;
  const kingdoms = [
    ...new Set(kingdomAccess.filter((s) => s.projectIds.includes(project.id)).map((s) => s.name)),
  ];
  return {
    description: project.description?.trim() || null,
    repository,
    worktreeMode: worktreeMode(project.path),
    kingdoms,
    kingdomProject: kingdomProject ?? null,
  };
}
