import { Thread, type ThreadMeta } from "@inixiative/foundry-core";
import type { ProjectRegistry } from "../agents/project";
import type { ThreadFactory } from "../agents/thread-factory";

/** Viewer lookup includes projectless threads as well as project-owned threads. */
export class ViewerThreadDirectory {
  private readonly threads = new Map<string, Thread>();

  constructor(private readonly main: Thread, private readonly projects?: ProjectRegistry,
    private readonly factory?: ThreadFactory) {
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

  add(thread: Thread): void {
    const existing = this.get(thread.id);
    if (existing && existing !== thread) throw new Error(`Thread already registered: ${thread.id}`);
    this.threads.set(thread.id, thread);
  }

  restore(records: Array<{ id: string; meta: ThreadMeta }>): string[] {
    const warnings: string[] = [];
    for (const record of records) {
      const project = record.meta.projectId ? this.projects?.get(record.meta.projectId) : undefined;
      if (record.meta.projectId && !project) {
        warnings.push(`Stored thread ${record.id} retained on disk: project ${record.meta.projectId} is unavailable`);
        continue;
      }
      let thread = this.get(record.id);
      if (thread && thread.meta.projectId !== record.meta.projectId) {
        warnings.push(`Stored thread ${record.id} retained on disk: project ownership differs from startup`);
        continue;
      }
      if (!thread) {
        if (this.factory) thread = this.factory.create(record.id, record.meta);
        else {
          const stack = this.main.stack.clone({ threadId: record.id, projectId: record.meta.projectId });
          thread = new Thread(record.id, stack, record.meta);
          for (const agent of this.main.agents.values()) thread.register(agent.withStack(stack));
        }
        if (project) project.addThread(thread);
        this.add(thread);
      }
      Object.assign(thread.meta, structuredClone(record.meta));
      if (record.meta.status === "archived") {
        thread.archive();
        Object.assign(thread.meta, structuredClone(record.meta));
      } else if (record.meta.status === "waiting" || record.meta.status === "active") {
        thread.meta.status = "waiting";
        thread.stop();
      }
    }
    return warnings;
  }
}
