/**
 * @atlas
 * @kind service
 * @partOf integration:archive
 */

import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ArchiveSnapshot } from '@inixiative/archive';
import { archiveReferences, provenanceReferences } from '@inixiative/archive/tags';
import type {
  Thread,
  ThreadCheckout,
  ThreadContext,
  ThreadReference,
} from '@inixiative/foundry-core';
import { checkoutPlace, gitContext, recreateWorktree, squashMergedInto } from '../git';

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
type Place = typeof checkoutPlace;
type Recreate = typeof recreateWorktree;
type Pending = { again: boolean };

/**
 * Per-thread work context: the worktree's repository (git origin, normalized by Archive's
 * provenance references), branch and root, and the PRs/tickets its archived session references.
 * Refreshed when a thread's archive snapshot is captured or its worktree changes.
 */
export class ThreadContextTracker {
  private readonly references = new Map<string, ThreadReference[]>();
  private readonly pending = new Map<string, Pending>();
  /** Threads whose released worktree is being created again: derive leaves their record alone. */
  private readonly recreating = new Set<string>();
  /** Threads derive one at a time, so a startup capture of every thread never fans out git. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      thread(id: string): Thread | undefined;
      changed(thread: Thread): void;
      git?: Git;
      place?: Place;
      recreate?: Recreate;
      merged?: typeof squashMergedInto;
      /** A thread's branch was first seen squash-merged into `into` (the setting decides what follows). */
      onMerged?: (thread: Thread, into: string) => void;
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
    if (!thread || thread.disposed || this.recreating.has(threadId)) return;
    const cwd = thread.meta.cwd;
    const prior = thread.meta.context;
    // A recorded checkout that is gone from disk was released: keep where it was, mark it released.
    if (cwd && !existsSync(cwd) && prior?.checkout && prior.checkout.mode !== 'none') {
      const { updatedAt: _updatedAt, ...kept } = prior;
      const next = {
        ...kept,
        checkout: { ...prior.checkout, state: 'released' } satisfies ThreadCheckout,
        references: this.references.get(threadId) ?? prior.references,
      };
      return this.publish(thread, next);
    }
    const [git, place]: [Awaited<ReturnType<Git>>, Awaited<ReturnType<Place>>] = cwd
      ? await Promise.all([
          (this.options.git ?? gitContext)(cwd).catch(() => ({})),
          (this.options.place ?? checkoutPlace)(cwd).catch(() => undefined),
        ])
      : [{}, undefined];
    const repository = provenanceReferences({ repository: git.remote })[0]?.ref;
    // A linked worktree's branch, once squash-merged into the default branch, stays merged.
    const known = prior?.branch === git.branch ? prior?.checkout?.merged : undefined;
    const into =
      place && !place.main && git.branch && !known
        ? await (this.options.merged ?? squashMergedInto)(cwd!, git.branch).catch(() => undefined)
        : undefined;
    const merged = known ?? (into ? { into, at: Date.now() } : undefined);
    const checkout: ThreadCheckout = place
      ? { ...place, ...(merged ? { merged } : {}), state: 'live' }
      : { mode: 'none', main: false, state: 'live' };
    const next = {
      ...(repository ? { repository } : {}),
      ...(git.branch ? { branch: git.branch } : {}),
      ...(git.worktree ? { worktree: git.worktree } : {}),
      checkout,
      references: this.references.get(threadId) ?? prior?.references ?? [],
    };
    this.publish(thread, next);
    if (into) this.options.onMerged?.(thread, into);
  }

  /**
   * Create a released worktree again (FEAT-003 "recreate") from its recorded branch with the
   * repository's worktree mode. Refused unless the thread's checkout is released and its branch is
   * known. The record reads `recreating` while the command runs, then `live` (the thread's cwd moves
   * to the new worktree if the mode put it elsewhere) or `released` with the command's error.
   */
  recreate(threadId: string): { started: Promise<void> } | { error: string } {
    const thread = this.options.thread(threadId);
    const context = thread?.meta.context;
    const checkout = context?.checkout;
    if (!thread || thread.disposed) return { error: 'thread not found' };
    if (this.recreating.has(threadId)) return { error: 'a recreate is already running' };
    if (!checkout || checkout.state !== 'released' || checkout.mode === 'none')
      return { error: 'only a released worktree can be recreated' };
    const branch = context.branch ?? thread.meta.branch;
    if (!branch || !checkout.root || !checkout.path)
      return { error: 'the released worktree has no recorded branch or repository' };
    const { mode, root, path } = checkout;
    const { updatedAt: _updatedAt, ...kept } = context;
    this.publish(thread, { ...kept, checkout: { ...checkout, state: 'recreating' } });
    this.recreating.add(threadId);
    const started = (async () => {
      const result = await (this.options.recreate ?? recreateWorktree)(
        { mode, root, path },
        branch,
      ).catch((error: unknown) => ({ error: String((error as Error)?.message ?? error) }));
      this.recreating.delete(threadId);
      const current = thread.meta.context;
      if ('error' in result) {
        if (current?.checkout) {
          const { updatedAt: _at, ...rest } = current;
          this.publish(thread, {
            ...rest,
            checkout: { ...current.checkout, state: 'released', error: result.error },
          });
        }
        return;
      }
      if (result.path !== path && thread.meta.cwd) {
        thread.meta.cwd = join(result.path, relative(path, thread.meta.cwd));
        // Instruction files are discovered from the cwd: re-read them on the next turn.
        for (const layer of thread.stack.layers) layer.invalidate();
      }
      await this.refresh(threadId);
    })();
    return { started };
  }

  private publish(thread: Thread, next: Omit<ThreadContext, 'updatedAt'>): void {
    const current = JSON.stringify({
      ...(thread.meta.context ?? { references: [] }),
      updatedAt: undefined,
    });
    if (thread.disposed || current === JSON.stringify(next)) return;
    thread.meta.context = { ...next, updatedAt: Date.now() } satisfies ThreadContext;
    this.options.changed(thread);
  }
}
