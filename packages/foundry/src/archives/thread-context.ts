import type { ArchiveSnapshot } from '@inixiative/archive';
import { archiveReferences, provenanceReferences } from '@inixiative/archive/tags';
import type { Thread, ThreadContext, ThreadReference } from '@inixiative/foundry-core';
import { gitContext } from '../git';

const PER_KIND = 3;

const linearUrl = (snapshot: ArchiveSnapshot, ref: string) => {
  const workspace = snapshot.entries
    .map(
      (entry) => entry.text.match(new RegExp(`linear\\.app/([\\w-]+)/issue/${ref}\\b`, 'i'))?.[1],
    )
    .find(Boolean);
  return workspace ? `https://linear.app/${workspace}/issue/${ref}` : undefined;
};

/** PRs/issues and tickets an archived session references, recorded then most-linked first (Archive's references). */
export function snapshotReferences(snapshot: ArchiveSnapshot): ThreadReference[] {
  const github: ThreadReference[] = [],
    tickets: ThreadReference[] = [];
  for (const { integration, ref } of archiveReferences(snapshot)) {
    if (integration === 'github') {
      const pr = ref.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
      if (pr && github.length < PER_KIND)
        github.push({ integration, ref, url: `https://github.com/${pr[1]}/pull/${pr[2]}` });
    } else if (tickets.length < PER_KIND) {
      const url = integration === 'linear' ? linearUrl(snapshot, ref) : undefined;
      tickets.push({ integration, ref, ...(url ? { url } : {}) });
    }
  }
  return [...github, ...tickets];
}

type Git = typeof gitContext;
type Pending = { again: boolean };

/**
 * Per-thread work context: the worktree's repository (git origin, normalized by Archive's
 * provenance references), branch and root, and the PRs/tickets its archived session references.
 * Refreshed when a thread's archive snapshot is captured or its worktree changes.
 */
export class ThreadContextTracker {
  private readonly references = new Map<string, ThreadReference[]>();
  private readonly pending = new Map<string, Pending>();
  /** Threads derive one at a time, so a startup capture of every thread never fans out git. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      thread(id: string): Thread | undefined;
      changed(thread: Thread): void;
      git?: Git;
    },
  ) {}

  /** A thread's archive snapshot was captured. */
  observe(snapshot: ArchiveSnapshot): Promise<void> {
    this.references.set(snapshot.sessionId, snapshotReferences(snapshot));
    return this.refresh(snapshot.sessionId);
  }

  /** Re-derive a thread's context; concurrent requests for one thread coalesce into one rerun. */
  async refresh(threadId: string): Promise<void> {
    const pending = this.pending.get(threadId);
    if (pending) {
      pending.again = true;
      return;
    }
    const state: Pending = { again: true };
    this.pending.set(threadId, state);
    try {
      while (state.again) {
        state.again = false;
        const run = this.queue.then(() => this.derive(threadId));
        this.queue = run.catch(() => {});
        await run;
      }
    } finally {
      this.pending.delete(threadId);
    }
  }

  private async derive(threadId: string): Promise<void> {
    const thread = this.options.thread(threadId);
    if (!thread || thread.disposed) return;
    const git: Awaited<ReturnType<Git>> = thread.meta.cwd
      ? await (this.options.git ?? gitContext)(thread.meta.cwd).catch(() => ({}))
      : {};
    const repository = provenanceReferences({ repository: git.remote })[0]?.ref;
    const next = {
      ...(repository ? { repository } : {}),
      ...(git.branch ? { branch: git.branch } : {}),
      ...(git.worktree ? { worktree: git.worktree } : {}),
      references: this.references.get(threadId) ?? thread.meta.context?.references ?? [],
    };
    const current = JSON.stringify({
      ...(thread.meta.context ?? { references: [] }),
      updatedAt: undefined,
    });
    if (thread.disposed || current === JSON.stringify(next)) return;
    thread.meta.context = { ...next, updatedAt: Date.now() } satisfies ThreadContext;
    this.options.changed(thread);
  }
}
