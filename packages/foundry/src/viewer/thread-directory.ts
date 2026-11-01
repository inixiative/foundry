/**
 * @atlas
 * @kind service
 * @partOf feature:threads, feature:viewer
 */
import { Thread, type ThreadMeta } from '@inixiative/foundry-core';
import type { ProjectRegistry } from '../agents/project';
import type { ThreadFactory } from '../agents/thread-factory';

/** Viewer lookup includes projectless threads as well as project-owned threads. */
export class ViewerThreadDirectory {
  private readonly threads = new Map<string, Thread>();

  constructor(
    private readonly main: Thread,
    private readonly projects?: ProjectRegistry,
    private readonly factory?: ThreadFactory,
  ) {
    this.threads.set(main.id, main);
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
    current?.dispose();
    const project = meta.projectId ? this.projects?.get(meta.projectId) : undefined;
    const thread = this.factory.create(id, meta);
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
      // Every record names its worker; one without is never given a default (run the stamping script).
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
    }
    return warnings;
  }
}
