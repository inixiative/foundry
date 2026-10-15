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
      if (!thread) {
        if (record.meta.spawn?.observed) thread = this.observedThread(record);
        else if (this.factory) thread = this.factory.create(record.id, record.meta);
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
