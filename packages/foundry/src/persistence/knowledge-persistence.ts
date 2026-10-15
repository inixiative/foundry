import type { EventStream, Thread } from '@inixiative/foundry-core';
import type {
  ThreadKnowledgeBundle,
  ThreadRuntime,
  ThreadRuntimeManager,
} from '../agents/thread-runtime';
import { type CompositionAuditor, stripCompositions } from '../audit/compositions';
import type { LocalSessionStore } from './local-session-store';

/**
 * Connect the existing runtime's owned learning lifecycle to the local journal. A durability failure
 * withholds the thread's learning (nothing new commits or publishes, and stored knowledge is not
 * restored); it never disposes the thread. Wardens are a chorus: they never end a turn or a thread.
 */
export class KnowledgePersistence {
  private readonly errors = new Map<string, string>();
  private readonly reconciliation = new Map<string, string>();
  private readonly detach: () => void;

  constructor(
    private readonly manager: ThreadRuntimeManager,
    private readonly store: LocalSessionStore,
    private readonly events: EventStream,
    threads: Thread[],
    /** Turns each call's composition into version ids (spec B); without one, compositions are dropped. */
    private readonly auditor?: CompositionAuditor,
  ) {
    // A call's composed text is journalled as the versions it was made of, never as a copy. The
    // audit is a record, not a gate: if it fails, the call is journalled without versions.
    const versioned = <T>(record: T): T => {
      if (!this.auditor) return stripCompositions(record);
      try {
        return this.auditor.versionRecord(record);
      } catch (error) {
        this.events.pushError(
          'audit:composition',
          `composition versions not recorded: ${error instanceof Error ? error.message : String(error)}`,
        );
        return stripCompositions(record);
      }
    };
    // An owned invalidation, never the private phase input or a new model signal.
    const owners = new WeakMap<
      ThreadRuntime,
      { threadId: string; projectId: string | undefined }
    >();
    const ownerOf = (runtime: ThreadRuntime) => {
      let owner = owners.get(runtime);
      if (!owner) {
        owner = Object.freeze({
          threadId: runtime.thread.id,
          projectId: runtime.thread.meta.projectId,
        });
        owners.set(runtime, owner);
      }
      return owner;
    };
    const notify = (
      runtime: ThreadRuntime,
      turnId: string | null,
      scope: 'phase' | 'learning',
      outcome: 'durable' | 'failed',
    ) => {
      this.events.push({
        kind: 'journal',
        ...ownerOf(runtime),
        turnId,
        scope,
        outcome,
        timestamp: Date.now(),
      });
    };
    const restoring = new Set<ThreadRuntime>();
    const restore = (runtime: ThreadRuntime) => {
      ownerOf(runtime);
      restoring.add(runtime);
      try {
        if (this.errors.has(runtime.thread.id)) throw Error(this.errors.get(runtime.thread.id)!);
        const bundle = store.knowledge(runtime.thread.id);
        if (bundle) {
          this.validate(runtime, bundle);
          runtime.restoreKnowledge(bundle);
        }
        for (const signal of store.learningCapacity(runtime.thread.id)) {
          const content = signal.content as import('../agents/domain-librarian').LearningRecord & {
            domain: string;
          };
          if (content.owner && content.owner.projectId !== runtime.thread.meta.projectId)
            throw Error('Stored learning capacity owner mismatch');
          if (
            content.capacity === 'unknown' ||
            (content.eligibility === 'closed' && content.native?.admissionId)
          )
            runtime.restoreReviewClosure(
              content.domain,
              'durable closed review eligibility/occupancy; original evidence retained without replay',
              content,
            );
        }
      } catch (error) {
        this.quarantine(runtime.thread, error);
      } finally {
        restoring.delete(runtime);
      }
    };
    const detachPhase = manager.setPhaseJournal((runtime, record) => {
      try {
        store.appendPhase(runtime.thread, { ...record, record: versioned(record.record) });
      } catch (error) {
        notify(runtime, record.turnId, 'phase', 'failed');
        this.events.pushError(
          `phase:${runtime.thread.id}`,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
      notify(runtime, record.turnId, 'phase', 'durable');
    });
    const detachJournal = manager.setLearningJournal((runtime, signal) => {
      if (restoring.has(runtime)) return; // reconstruction is not a new audit event
      const content = signal.content as { decision?: string; job?: unknown };
      if (content.decision === 'learned' && content.job) return;
      const turnId =
        (signal.content as { evidence?: { messageId?: string } }).evidence?.messageId ?? null;
      // A withheld thread admits no new review: refusing its "requested" record closes admission.
      // Outcome records (why a review failed or closed) are still kept.
      const withheld = this.errors.get(runtime.thread.id);
      if (withheld && (content as { decision?: string }).decision === 'requested')
        throw Error(withheld);
      try {
        store.appendLearning(runtime.thread, { ...signal, content: versioned(signal.content) });
      } catch (error) {
        this.quarantine(runtime.thread, error);
        notify(runtime, turnId, 'learning', 'failed');
        throw error;
      }
      notify(runtime, turnId, 'learning', 'durable');
    }, restore);
    // Restore before subscribing: restoration is not new learning evidence.
    for (const thread of threads) {
      const runtime = manager.get(thread.id);
      if (!runtime || runtime.disposed) continue;
      restore(runtime);
    }
    const detachCommit = manager.setKnowledgeCommitter(
      (runtime, job, candidate, signal) => {
        const eligible = () =>
          manager.get(runtime.thread.id) === runtime && runtime.reviewEligible(job);
        if (!eligible()) return 'stale';
        const withheld = this.errors.get(runtime.thread.id);
        if (withheld) throw Error(withheld);
        try {
          const bundle = { ...runtime.knowledgeSnapshot(), domains: { [job.domain]: candidate } };
          this.validate(runtime, bundle);
          const result = store.saveKnowledge(runtime.thread, bundle, signal, { job, eligible });
          return result === 'committed' ? 'durable' : result;
        } catch (error) {
          this.quarantine(runtime.thread, error);
          throw error;
        }
      },
      (runtime, job, error) => {
        this.reconciliation.set(
          runtime.thread.id,
          `Review ${job.id} committed; publication failed: ${String(error).slice(0, 1000)}`,
        );
        this.republish(runtime);
      },
    );
    const detachSignals = manager.addSignalSink((signal, owner) => {
      if (signal.kind !== 'domain_learning' || !owner.threadId || this.errors.has(owner.threadId))
        return;
      const runtime = manager.get(owner.threadId);
      if (!runtime || runtime.disposed) return;
      const content = signal.content as { decision?: string; job?: unknown; reason?: string };
      // Runtime-owned events already crossed the direct journal boundary.
      if ((signal.content as { generation?: string }).generation) return;
      // Owned learned events were committed before publication. Never write them a second time.
      if (content?.decision === 'learned' && content.job) return;
      try {
        const bundle = runtime.knowledgeSnapshot();
        this.validate(runtime, bundle);
        store.saveKnowledge(runtime.thread, bundle, signal);
        if (content?.decision === 'reconciliation-needed') {
          this.reconciliation.set(
            owner.threadId,
            content.reason ?? 'Durable knowledge needs publication reconciliation',
          );
          this.republish(runtime);
        }
      } catch (error) {
        this.quarantine(runtime.thread, error);
      }
    });
    this.detach = () => {
      detachSignals();
      detachCommit();
      detachJournal();
      detachPhase();
    };
    store.onClose(this.detach);
  }

  private validate(runtime: ThreadRuntime, bundle: ThreadKnowledgeBundle): void {
    const owner = { threadId: runtime.thread.id, projectId: runtime.thread.meta.projectId };
    if (!bundle || bundle.threadId !== owner.threadId || bundle.projectId !== owner.projectId)
      throw new Error('Knowledge bundle owner mismatch');
    if (!Number.isFinite(bundle.capturedAt) || bundle.capturedAt < 0)
      throw new Error('Invalid knowledge capture timestamp');
    if (!bundle.domains || typeof bundle.domains !== 'object' || Array.isArray(bundle.domains))
      throw new Error('Invalid knowledge domain map');
    for (const [domain, snapshot] of Object.entries(bundle.domains)) {
      const librarian = runtime.domainLibrarians.get(domain);
      if (!librarian)
        throw new Error(`Stored knowledge domain requires a configuration migration: ${domain}`);
      librarian.threadKnowledge.validate(snapshot, owner);
      if (!Number.isSafeInteger(snapshot.revision) || snapshot.evidence.length > 200)
        throw new Error(`Invalid knowledge revision or evidence bound: ${domain}`);
    }
  }

  /**
   * The journal is authoritative: after a committed revision failed to publish, publish the journal's
   * knowledge into the live runtime once the failing call has returned. Failing again leaves the
   * reconciliation recorded; the next reconstruction publishes it.
   */
  private republish(runtime: ThreadRuntime): void {
    setTimeout(() => {
      if (runtime.disposed || this.errors.has(runtime.thread.id)) return;
      try {
        const bundle = this.store.knowledge(runtime.thread.id);
        if (!bundle) return;
        this.validate(runtime, bundle);
        runtime.restoreKnowledge(bundle);
        this.reconciliation.delete(runtime.thread.id);
      } catch (error) {
        console.error(
          `[Recovery] ${runtime.thread.id}: committed knowledge still not published: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }, 0);
  }

  /** Withhold the thread's learning from here on; the thread keeps working. The first reason stands. */
  private quarantine(thread: Thread, error: unknown): void {
    if (this.errors.has(thread.id)) return;
    const message = `Knowledge durability failure for ${thread.id}: ${error instanceof Error ? error.message : String(error)}`;
    this.errors.set(thread.id, message);
    this.events.pushError(`knowledge:${thread.id}`, message);
    console.error(`[Recovery] ${message}; learning withheld, the thread continues`);
  }

  /** Why this thread's learning is withheld, if it is. */
  blocked(threadId: string): string | undefined {
    return this.errors.get(threadId);
  }

  inspect(threadId: string, limit = 100) {
    const reconciliation = this.reconciliation.get(threadId);
    if (reconciliation)
      return {
        status: 'reconciliation-needed',
        error: reconciliation,
        snapshot: this.store.knowledge(threadId),
        history: this.store.learningHistory(threadId, limit),
      };
    const error = this.errors.get(threadId);
    if (error) return { status: 'blocked', error };
    const snapshot = this.store.knowledge(threadId);
    return {
      status: snapshot ? 'durable' : 'empty',
      snapshot: snapshot ?? null,
      history: this.store.learningHistory(threadId, limit),
      learning: this.manager.get(threadId)?.learningState,
      // Guard phase rows with no turn correlation: reachable here under the thread, never attached to a turn.
      uncorrelatedPhases: this.store.phaseHistory(threadId, { uncorrelated: true, limit: 100 }),
    };
  }
}
