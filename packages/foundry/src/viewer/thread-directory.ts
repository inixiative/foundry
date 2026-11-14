/**
 * @atlas
 * @kind service
 * @partOf feature:threads, feature:viewer
 */
import { Thread, type ThreadMachine, type ThreadMeta } from '@inixiative/foundry-core';
import type { ProjectRegistry } from '../agents/project';
import type { ThreadFactory } from '../agents/thread-factory';

/** Viewer lookup includes projectless threads as well as project-owned threads. */
export class ViewerThreadDirectory {
  private readonly threads = new Map<string, Thread>();

  constructor(
    private readonly main: Thread,
    private readonly projects?: ProjectRegistry,
    private readonly factory?: ThreadFactory,
    /** This machine, stamped on every thread the directory holds that has none (`meta.machine`). */
    private readonly machine?: () => ThreadMachine | undefined,
  ) {
    this.stamp(main);
    this.threads.set(main.id, main);
  }

  /** A thread this Foundry holds runs here: record the machine once, unless it already names one. */
  private stamp(thread: Thread): void {
    if (thread.meta.machine) return;
    const machine = this.machine?.();
    if (machine) thread.meta.machine = machine;
  }

  get(id: string): Thread | undefined {
    for (const project of this.projects?.all.values() ?? []) {
      const thread = project.threads.get(id);
      if (thread) return thread;
    }
    return this.threads.get(id);
  }

  all(): Thread[] {
    const all = new Map(this.threads);
    for (const project of this.projects?.all.values() ?? []) {
      for (const [id, thread] of project.threads) all.set(id, thread);
    }
    return [...all.values()];
  }

  /** Thread-list scope: a project's threads, or (no project) the threads no project owns. Undefined for an unknown project. */
  scope(projectId?: string): Thread[] | undefined {
    if (projectId) {
      const project = this.projects?.get(projectId);
      return project ? [...project.threads.values()] : undefined;
    }
    const owned = new Set<string>();
    for (const project of this.projects?.all.values() ?? [])
      for (const id of project.threads.keys()) owned.add(id);
    return this.all().filter((thread) => !owned.has(thread.id));
  }

  add(thread: Thread): void {
    const existing = this.get(thread.id);
    if (existing && existing !== thread) throw new Error(`Thread already registered: ${thread.id}`);
    this.stamp(thread);
    this.threads.set(thread.id, thread);
  }

  /**
   * Bring an archived thread back: a message or a member's post arrived for it (docs/reference/
   * CONVERSATIONS.md §4.2, revival). Archiving disposed the Thread object for good, so the thread
   * is rebuilt the way a restart restores it (`factory.create` with its stored meta), with the same
   * id, journal and native binding, and replaces the archived object. Returns the live thread, the
   * thread itself when it isn't archived, or undefined when it can't be reopened (unknown, an
   * observed subagent's record, no factory, a project that is gone, or a worker it can no longer run on).
   */
  reopen(id: string): Thread | undefined {
    const archived = this.get(id);
    if (!archived || !archived.disposed) return archived;
    if (!this.canReopen(id) || !this.factory) return undefined;
    const meta: ThreadMeta = structuredClone(archived.meta);
    meta.status = 'waiting';
    delete meta.archivedAt;
    return this.rebuild(id, meta);
  }

  /**
   * Build a thread again from its meta, in place of a disposed object (a reopen) or of a live one that
   * has never run a turn (its worker changed: FEAT-007). Its runtime, agents and stack are rebuilt
   * for `meta.worker`; the id, journal and project stay.
   */
  rebuild(id: string, meta: ThreadMeta): Thread {
    if (!this.factory) throw Error('Rebuilding a thread needs the thread factory');
    const current = this.get(id);
    if (current === this.main) throw Error("The main thread's worker is its project's default");
    const previous = current ? structuredClone(current.meta) : undefined;
    const live = current && !current.disposed;
    current?.dispose();
    const project = meta.projectId ? this.projects?.get(meta.projectId) : undefined;
    let thread: Thread;
    try {
      thread = this.factory.create(id, meta);
    } catch (error) {
      // Never leave a live thread disposed with nothing in its place: it comes back as it was.
      if (!live || !previous) throw error;
      try {
        const restored = this.factory.create(id, previous);
        Object.assign(restored.meta, previous);
        if (project) project.replaceThread(restored);
        if (!project || this.threads.has(id)) this.threads.set(id, restored);
      } catch (restoring) {
        throw Error(
          `${(error as Error).message}; restoring the thread also failed: ${(restoring as Error).message}`,
          { cause: error },
        );
      }
      throw error;
    }
    Object.assign(thread.meta, meta);
    if (project) project.replaceThread(thread);
    // Restore lists project threads here too: the old object goes wherever it was.
    if (!project || this.threads.has(id)) this.threads.set(id, thread);
    return thread;
  }

  /** An archived thread this directory can rebuild (see `reopen`). */
  canReopen(id: string): boolean {
    const thread = this.get(id);
    // The main thread is the viewer's own Harness thread: nothing rebuilds the objects holding it.
    if (!thread || thread === this.main || id === this.main.id) return false;
    const project = thread.meta.projectId ? this.projects?.get(thread.meta.projectId) : undefined;
    return (
      thread.disposed &&
      thread.meta.status === 'archived' &&
      !thread.meta.spawn?.observed &&
      !!this.factory &&
      (!thread.meta.projectId || (!!project && this.factory.canCreate(thread.meta.projectId))) &&
      (thread.meta.worker
        ? !this.factory.workerRefusal(thread.meta.projectId, thread.meta.worker)
        : this.factory.defaultWorker(thread.meta.projectId) === undefined)
    );
  }

  /**
   * An observed subagent's child thread (spec A): recorded from the native stream, viewable, never
   * dispatched to — no runtime, no Wardens, no agents.
   */
  adoptObserved(record: { id: string; meta: ThreadMeta }): Thread {
    const existing = this.get(record.id);
    if (existing) {
      Object.assign(existing.meta, structuredClone(record.meta));
      return existing;
    }
    const thread = this.observedThread(record);
    const project = record.meta.projectId ? this.projects?.get(record.meta.projectId) : undefined;
    if (project) project.addThread(thread);
    this.add(thread);
    return thread;
  }

  /**
   * Undo an archive of an observed subagent: it is a record, never dispatched to, so it comes back
   * open from its meta (`reopen` rebuilds threads Foundry runs, and refuses these).
   */
  reopenObserved(id: string): Thread | undefined {
    const archived = this.get(id);
    if (
      !archived?.disposed ||
      archived.meta.status !== 'archived' ||
      !archived.meta.spawn?.observed
    )
      return undefined;
    const meta: ThreadMeta = structuredClone(archived.meta);
    meta.status = 'idle';
    delete meta.archivedAt;
    const thread = this.observedThread({ id, meta });
    const project = meta.projectId ? this.projects?.get(meta.projectId) : undefined;
    if (project) project.replaceThread(thread);
    if (!project || this.threads.has(id)) this.threads.set(id, thread);
    return thread;
  }

  private observedThread(record: { id: string; meta: ThreadMeta }): Thread {
    const stack = this.main.stack.clone({
      threadId: record.id,
      projectId: record.meta.projectId,
      cwd: record.meta.cwd,
    });
    const thread = new Thread(record.id, stack, record.meta);
    Object.assign(thread.meta, structuredClone(record.meta));
    return thread;
  }

  /**
   * Archive every open subagent (`meta.spawn`) whose parent is archived, at any depth: archiving a
   * thread takes its subagents with it (`thread:archive`), and this settles the ones archived before
   * that, or left open by a crash. Each takes its archived ancestor's archive time, as the cascade
   * does, so undoing that archive brings it back. Returns the threads it archived, for the caller to save.
   */
  archiveOrphanedSubagents(): Thread[] {
    const archived: Thread[] = [];
    /** The archived ancestor (through subagents) of a thread's parent, if any. */
    const closedAncestor = (id: string | undefined, seen: Set<string>): Thread | undefined => {
      if (!id || seen.has(id)) return undefined;
      seen.add(id);
      const parent = this.get(id);
      if (!parent) return undefined;
      if (parent.meta.status === 'archived') return parent;
      return parent.meta.spawn ? closedAncestor(parent.meta.parentThreadId, seen) : undefined;
    };
    for (const thread of this.all()) {
      if (!thread.meta.spawn || thread.meta.status === 'archived') continue;
      const ancestor = closedAncestor(thread.meta.parentThreadId, new Set([thread.id]));
      if (!ancestor) continue;
      thread.archive();
      thread.meta.archivedAt = ancestor.meta.archivedAt;
      archived.push(thread);
    }
    return archived;
  }

  restore(records: Array<{ id: string; meta: ThreadMeta }>): string[] {
    const warnings: string[] = [];
    for (const record of records) {
      const project = record.meta.projectId ? this.projects?.get(record.meta.projectId) : undefined;
      if (record.meta.projectId && !project) {
        warnings.push(
          `Stored thread ${record.id} retained on disk: project ${record.meta.projectId} is unavailable`,
        );
        continue;
      }
      let thread = this.get(record.id);
      if (thread && thread.meta.projectId !== record.meta.projectId) {
        warnings.push(
          `Stored thread ${record.id} retained on disk: project ownership differs from startup`,
        );
        continue;
      }
      // Every record names its worker; one startup couldn't stamp is never given a default.
      if (
        !record.meta.worker &&
        !record.meta.spawn?.observed &&
        this.factory?.defaultWorker(record.meta.projectId) !== undefined
      ) {
        warnings.push(`Stored thread ${record.id} retained on disk: its record names no worker`);
        continue;
      }
      if (thread && thread.meta.worker !== record.meta.worker) {
        warnings.push(
          `Stored thread ${record.id} retained on disk: it ran on ${record.meta.worker}, not ${thread.meta.worker}`,
        );
        continue;
      }
      if (!thread) {
        if (record.meta.spawn?.observed) thread = this.observedThread(record);
        else if (this.factory)
          try {
            thread = this.factory.create(record.id, record.meta);
          } catch (error) {
            warnings.push(
              `Stored thread ${record.id} retained on disk: ${(error as Error).message}`,
            );
            continue;
          }
        else {
          const stack = this.main.stack.clone({
            threadId: record.id,
            projectId: record.meta.projectId,
            cwd: record.meta.cwd,
          });
          thread = new Thread(record.id, stack, record.meta);
          for (const agent of this.main.agents.values()) thread.register(agent.withStack(stack));
        }
        if (project) project.addThread(thread);
        this.add(thread);
      }
      Object.assign(thread.meta, structuredClone(record.meta));
      if (record.meta.status === 'archived') {
        thread.archive();
        Object.assign(thread.meta, structuredClone(record.meta));
      } else if (record.meta.status === 'waiting' || record.meta.status === 'active') {
        thread.meta.status = 'waiting';
        thread.stop();
      }
      this.stamp(thread);
    }
    return warnings;
  }
}
