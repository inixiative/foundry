import type { EventStream, Thread } from "@inixiative/foundry-core";
import type { ThreadRuntime, ThreadRuntimeManager, ThreadKnowledgeBundle } from "../agents/thread-runtime";
import type { LocalSessionStore } from "./local-session-store";

/** Connect the existing runtime's owned learning lifecycle to the local journal. */
export class KnowledgePersistence {
  private readonly errors = new Map<string, string>();
  private readonly reconciliation = new Map<string, string>();
  private readonly detach: () => void;

  constructor(private readonly manager: ThreadRuntimeManager, private readonly store: LocalSessionStore,
    private readonly events: EventStream, threads: Thread[]) {
    // An owned invalidation, never the private phase input or a new model signal.
    const owners = new WeakMap<ThreadRuntime, { threadId: string; projectId: string | undefined }>();
    const ownerOf = (runtime: ThreadRuntime) => {
      let owner = owners.get(runtime);
      if (!owner) { owner = Object.freeze({ threadId: runtime.thread.id, projectId: runtime.thread.meta.projectId }); owners.set(runtime, owner); }
      return owner;
    };
    const notify = (runtime: ThreadRuntime, turnId: string | null, scope: "phase" | "learning", outcome: "durable" | "failed") => {
      this.events.push({ kind: "journal", ...ownerOf(runtime), turnId, scope, outcome, timestamp: Date.now() });
    };
    const restoring = new Set<ThreadRuntime>();
    const restore = (runtime: ThreadRuntime) => {
      ownerOf(runtime);
      restoring.add(runtime);
      try {
        if (this.errors.has(runtime.thread.id)) throw Error(this.errors.get(runtime.thread.id)!);
        const bundle = store.knowledge(runtime.thread.id);
        if (bundle) { this.validate(runtime, bundle); runtime.restoreKnowledge(bundle); }
        for (const signal of store.learningCapacity(runtime.thread.id)) {
          const content = signal.content as import("../agents/domain-librarian").LearningRecord & { domain: string };
          if (content.owner && content.owner.projectId !== runtime.thread.meta.projectId) throw Error("Stored learning capacity owner mismatch");
          if (content.capacity === "unknown" || (content.eligibility === "closed" && content.native?.admissionId)) runtime.restoreReviewClosure(content.domain,
            "durable closed review eligibility/occupancy; original evidence retained without replay", content);
        }
      } catch (error) { this.quarantine(runtime.thread, error); }
      finally { restoring.delete(runtime); }
    };
    const detachPhase = manager.setPhaseJournal((runtime, record) => {
      try { store.appendPhase(runtime.thread, record); }
      catch (error) { notify(runtime, record.turnId, "phase", "failed"); this.events.pushError(`phase:${runtime.thread.id}`, error instanceof Error ? error.message : String(error)); throw error; }
      notify(runtime, record.turnId, "phase", "durable");
    });
    const detachJournal = manager.setLearningJournal((runtime, signal) => {
      if (restoring.has(runtime)) return; // reconstruction is not a new audit event
      const content = signal.content as { decision?: string; job?: unknown };
      if (content.decision === "learned" && content.job) return;
      const turnId = (signal.content as { evidence?: { messageId?: string } }).evidence?.messageId ?? null;
      try { store.appendLearning(runtime.thread, signal); }
      catch (error) { this.quarantine(runtime.thread, error); notify(runtime, turnId, "learning", "failed"); throw error; }
      notify(runtime, turnId, "learning", "durable");
    }, restore);
    // Restore before subscribing: restoration is not new learning evidence.
    for (const thread of threads) {
      const runtime = manager.get(thread.id);
      if (!runtime || runtime.disposed) continue;
      restore(runtime);
    }
    const detachCommit = manager.setKnowledgeCommitter((runtime, job, candidate, signal) => {
      const eligible = () => manager.get(runtime.thread.id) === runtime && runtime.reviewEligible(job);
      if (!eligible()) return "stale";
      try {
        const bundle = { ...runtime.knowledgeSnapshot(), domains: { [job.domain]: candidate } };
        this.validate(runtime, bundle);
        const result = store.saveKnowledge(runtime.thread, bundle, signal, { job, eligible });
        return result === "committed" ? "durable" : result;
      } catch (error) { this.quarantine(runtime.thread, error); throw error; }
    }, (runtime, job, error) => {
      this.reconciliation.set(runtime.thread.id, `Review ${job.id} committed; publication failed: ${String(error).slice(0, 1000)}`);
      runtime.thread.meta.status = "waiting";
      // The journal is authoritative. Reconstruction can publish it without another review.
      runtime.dispose();
    });
    const detachSignals = manager.addSignalSink((signal, owner) => {
      if (signal.kind !== "domain_learning" || !owner.threadId || this.errors.has(owner.threadId)) return;
      const runtime = manager.get(owner.threadId);
      if (!runtime || runtime.disposed) return;
      const content = signal.content as { decision?: string; job?: unknown; reason?: string };
      // Runtime-owned events already crossed the direct journal boundary.
      if ((signal.content as { generation?: string }).generation) return;
      // Owned learned events were committed before publication. Never write them a second time.
      if (content?.decision === "learned" && content.job) return;
      try {
        const bundle = runtime.knowledgeSnapshot();
        this.validate(runtime, bundle);
        store.saveKnowledge(runtime.thread, bundle, signal);
        if (content?.decision === "reconciliation-needed") {
          this.reconciliation.set(owner.threadId, content.reason ?? "Durable knowledge needs publication reconciliation");
          runtime.thread.meta.status = "waiting";
          runtime.dispose();
        }
      } catch (error) { this.quarantine(runtime.thread, error); }
    });
    this.detach = () => { detachSignals(); detachCommit(); detachJournal(); detachPhase(); };
    store.onClose(this.detach);
  }

  private validate(runtime: ThreadRuntime, bundle: ThreadKnowledgeBundle): void {
    const owner = { threadId: runtime.thread.id, projectId: runtime.thread.meta.projectId };
    if (!bundle || bundle.threadId !== owner.threadId || bundle.projectId !== owner.projectId) throw new Error("Knowledge bundle owner mismatch");
    if (!Number.isFinite(bundle.capturedAt) || bundle.capturedAt < 0) throw new Error("Invalid knowledge capture timestamp");
    if (!bundle.domains || typeof bundle.domains !== "object" || Array.isArray(bundle.domains)) throw new Error("Invalid knowledge domain map");
    for (const [domain, snapshot] of Object.entries(bundle.domains)) {
      const librarian = runtime.domainLibrarians.get(domain);
      if (!librarian) throw new Error(`Stored knowledge domain requires a configuration migration: ${domain}`);
      librarian.threadKnowledge.validate(snapshot, owner);
      if (!Number.isSafeInteger(snapshot.revision) || snapshot.evidence.length > 200) throw new Error(`Invalid knowledge revision or evidence bound: ${domain}`);
    }
  }

  private quarantine(thread: Thread, error: unknown): void {
    const message = `Knowledge durability failure for ${thread.id}: ${error instanceof Error ? error.message : String(error)}`;
    this.errors.set(thread.id, message);
    thread.meta.status = "waiting";
    thread.dispose();
    this.events.pushError(`knowledge:${thread.id}`, message);
    console.error(`[Recovery] ${message}`);
  }

  /** Why this thread's learning is quarantined, if it is. */
  blocked(threadId: string): string | undefined { return this.errors.get(threadId); }

  inspect(threadId: string, limit = 100) {
    const reconciliation = this.reconciliation.get(threadId);
    if (reconciliation) return { status: "reconciliation-needed", error: reconciliation, snapshot: this.store.knowledge(threadId), history: this.store.learningHistory(threadId, limit) };
    const error = this.errors.get(threadId);
    if (error) return { status: "blocked", error };
    const snapshot = this.store.knowledge(threadId);
    return { status: snapshot ? "durable" : "empty", snapshot: snapshot ?? null, history: this.store.learningHistory(threadId, limit), learning: this.manager.get(threadId)?.learningState,
      // Guard phase rows with no turn correlation: reachable here under the thread, never attached to a turn.
      uncorrelatedPhases: this.store.phaseHistory(threadId, { uncorrelated: true, limit: 100 }) };
  }
}
