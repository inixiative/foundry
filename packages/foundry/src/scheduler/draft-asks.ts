/**
 * @atlas
 * @kind service
 * @partOf feature:scheduler
 */
import type { ActionQueue } from '@inixiative/foundry-core';
import type { ScheduleBook } from './types';

/** Accept or Reject, asked on the proposing thread. */
export const DRAFT_OPTIONS = [
  { id: 'accept', label: 'Accept' },
  { id: 'reject', label: 'Reject', dangerous: true },
] as const;

/** The question on a thread whose schedule waits for the owner. */
export const draftAsk = (name: string) =>
  `Your agent proposed the schedule "${name}". It runs only once you accept it.`;

export interface DraftAskDeps {
  scheduler: ScheduleBook & {
    accept(id: string, version: string): Promise<unknown>;
  };
  queue: ActionQueue;
  /** Whether the proposing thread can still be asked (live, not archived). */
  live(threadId: string): boolean;
  log?(line: string): void;
}

/**
 * One owner prompt per pending draft, on the thread that proposed it, through the action queue:
 * the same structural prompt every confirmation uses, so it puts the thread in Attention and is
 * answered there or in the Scheduled view. A prompt is withdrawn when its draft is accepted,
 * removed or renamed elsewhere; `reconcile` runs at start and on every settings change.
 */
export class DraftAsks {
  private readonly open = new Map<string, { key: string; abort: AbortController }>();

  constructor(private readonly deps: DraftAskDeps) {}

  reconcile(): void {
    const wanted = new Map<string, Want>();
    for (const view of this.deps.scheduler.list()) {
      const draft = view.schedule.draft;
      if (draft && this.deps.live(draft.threadId))
        wanted.set(view.schedule.id, {
          threadId: draft.threadId,
          name: view.schedule.name,
          version: view.version,
        });
    }
    for (const [id, asked] of this.open) {
      const want = wanted.get(id);
      if (!want || asked.key !== askKey(want)) this.withdraw(id);
    }
    for (const [id, want] of wanted) if (!this.open.has(id)) this.ask(id, want);
  }

  /** Withdraw every open prompt (the viewer is closing). */
  close(): void {
    for (const id of [...this.open.keys()]) this.withdraw(id);
  }

  private withdraw(id: string): void {
    const asked = this.open.get(id);
    if (!asked) return;
    this.open.delete(id);
    asked.abort.abort();
  }

  private ask(id: string, want: Want): void {
    const abort = new AbortController();
    const key = askKey(want);
    this.open.set(id, { key, abort });
    void this.deps.queue
      .prompt({
        kind: 'choice',
        threadId: want.threadId,
        agentId: 'scheduler',
        capability: 'scheduler',
        message: draftAsk(want.name),
        options: DRAFT_OPTIONS.map((option) => ({ ...option })),
        meta: { structural: true, scheduleDraft: { id } },
        signal: abort.signal,
      })
      .then(async (resolution) => {
        if (resolution.by !== 'human') return;
        // The answer applies only to the draft it was asked about.
        if (resolution.action === 'accept') await this.deps.scheduler.accept(id, want.version);
        else if (resolution.action === 'reject') await this.deps.scheduler.remove(id);
      })
      .catch((error: unknown) =>
        this.deps.log?.(`[Scheduler] draft ${id} not settled: ${(error as Error).message}`),
      )
      .finally(() => {
        if (this.open.get(id)?.abort !== abort) return;
        // Answered: ask again if it is still a draft (the accept failed, or it changed meanwhile).
        this.open.delete(id);
        this.reconcile();
      });
  }
}

interface Want {
  threadId: string;
  name: string;
  version: string;
}

/** A rewritten draft is a new question: the old prompt is withdrawn and the new one asked. */
const askKey = (want: Want) => `${want.threadId}\u0000${want.name}\u0000${want.version}`;
