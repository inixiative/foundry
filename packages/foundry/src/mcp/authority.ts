// ---------------------------------------------------------------------------
// Live-runtime authority for the MCP bridge (T1)
//
// A bridge server is created for exactly one registered Thread object. The
// authority pins that object, its project at creation and, when a live
// ThreadRuntimeManager is supplied, the runtime object and generation. Every
// tool call validates the pin before doing work and again after any awaited
// read, so a disposed, replaced or re-projected thread can neither keep
// serving old data nor silently attach to a successor. Tool arguments never
// carry authorization; scope comes only from here.
// ---------------------------------------------------------------------------

import type { Thread, OwnershipScope } from "@inixiative/foundry-core";
import { normalizeScope } from "@inixiative/foundry-core";
import type { ThreadRuntime, ThreadRuntimeManager } from "../agents/thread-runtime";
import type { DomainLibrarian } from "../agents/domain-librarian";

/** Why an authority no longer holds. Names only the owner's own condition. */
export type AuthorityRefusal = "disposed" | "replaced" | "generation-replaced" | "project-changed" | "revoked";

/** Summary of a same-project live thread the owner is authorized to see. */
export interface AuthorizedThreadSummary {
  readonly threadId: string;
  readonly description: string;
  readonly status: string;
  readonly tags: readonly string[];
}

/** Registry of live threads the bridge may consult. SessionManager satisfies it. */
export interface LiveThreadRegistry {
  readonly threads: ReadonlyMap<string, Thread>;
}

export interface LiveAuthority {
  readonly threadId: string;
  /** Project pinned at creation; undefined for an unprojected owner. */
  readonly projectId: string | undefined;
  /** Runtime generation pinned at creation; undefined without a live runtime. */
  readonly generation: string | undefined;
  /** The pinned Thread object. */
  readonly thread: Thread;
  /** null while the authority holds, otherwise the refusal reason. */
  check(): AuthorityRefusal | null;
  /** Ownership scope for backend reads. Never derived from tool input. */
  scope(): OwnershipScope;
  /** Same-project live siblings only. Empty for an unprojected owner. */
  siblings(): AuthorizedThreadSummary[];
  /** Live domain reviewers when a runtime is pinned; undefined otherwise. */
  domains(): ReadonlyMap<string, DomainLibrarian> | undefined;
  revoke(reason: AuthorityRefusal): void;
  /**
   * Release this authority's owned observer on the thread (its disposal hook)
   * without revoking it. Every live condition (disposal, replacement, generation,
   * project change, shared lifetime) is still evaluated on each `check()`, so a
   * late read after the hook is gone remains fully guarded. Idempotent.
   */
  detach(): void;
  /**
   * Join a shared revocation lifetime (for example one bridge). Once the lifetime
   * carries a reason, every authority bound to it is refused, including one whose
   * transport is already gone while backend work is still pending. The owner of
   * the lifetime holds no list of authorities or servers.
   */
  bindLifetime(lifetime: SharedRevocation): void;
}

/** A latch shared by many authorities; set `reason` once to revoke them all. */
export interface SharedRevocation {
  reason: AuthorityRefusal | null;
}

export interface BindAuthorityOptions {
  thread: Thread;
  /** Registry of registered Thread objects (standalone/legacy path). */
  registry?: LiveThreadRegistry;
  /** Live runtime manager; pins the runtime object and generation. */
  runtime?: ThreadRuntimeManager;
}

/**
 * Pin the supplied thread. With a runtime manager the thread must currently be
 * live there; creation fails otherwise rather than serving a reconstructed
 * thread. Disposal revokes eagerly through the thread's own hook.
 */
export function bindLiveAuthority(options: BindAuthorityOptions): LiveAuthority {
  const { thread, registry, runtime } = options;
  if (thread.disposed) throw new Error(`Thread "${thread.id}" is disposed; no MCP authority can be bound to it`);
  const pinnedRuntime: ThreadRuntime | undefined = runtime ? runtime.get(thread.id) : undefined;
  if (runtime && (!pinnedRuntime || pinnedRuntime.thread !== thread || pinnedRuntime.disposed)) {
    throw new Error(`Thread "${thread.id}" is not the live runtime's registered thread; refusing to bind MCP authority`);
  }
  const projectId = thread.meta.projectId || undefined;
  let revoked: AuthorityRefusal | null = null;
  const lifetimes: SharedRevocation[] = [];
  let hook: (() => void) | undefined = thread.onDispose(() => { revoked ??= "disposed"; });
  // The hook is an eager latch only; check() re-reads thread.disposed itself.
  const unsubscribe = () => { hook?.(); hook = undefined; };

  const check = (): AuthorityRefusal | null => {
    if (revoked) return revoked;
    for (const lifetime of lifetimes) if (lifetime.reason) return revoked = lifetime.reason;
    if (thread.disposed) return revoked = "disposed";
    if (pinnedRuntime) {
      const current = runtime!.get(thread.id);
      if (current !== pinnedRuntime || pinnedRuntime.disposed) return revoked = "generation-replaced";
    }
    if (registry && registry.threads.get(thread.id) !== thread) return revoked = "replaced";
    if ((thread.meta.projectId || undefined) !== projectId) return revoked = "project-changed";
    return null;
  };

  const liveThreads = (): Thread[] => {
    if (runtime) return [...runtime.runtimes.values()].filter(r => !r.disposed).map(r => r.thread);
    if (registry) return [...registry.threads.values()];
    return [];
  };

  return {
    threadId: thread.id,
    projectId,
    generation: pinnedRuntime?.generation,
    thread,
    check,
    scope: () => normalizeScope({ threadId: thread.id, projectId }),
    siblings: () => {
      // An absent project authorizes nothing beyond the owner's own context.
      if (!projectId || check()) return [];
      return liveThreads()
        .filter(t => t !== thread && !t.disposed && t.meta.projectId === projectId)
        .map(t => ({ threadId: t.id, description: t.meta.description ?? "", status: t.meta.status ?? "idle", tags: [...(t.meta.tags ?? [])] }));
    },
    domains: () => pinnedRuntime && !check() ? pinnedRuntime.domainLibrarians : undefined,
    revoke: (reason) => { revoked ??= reason; unsubscribe(); },
    detach: unsubscribe,
    bindLifetime: (lifetime) => { if (!lifetimes.includes(lifetime)) lifetimes.push(lifetime); },
  };
}
