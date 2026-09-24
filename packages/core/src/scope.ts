/**
 * Ownership scope — which thread and project an operation belongs to.
 *
 * Threads bind their context sources and tool calls to a scope so that
 * per-thread captures never leak into other threads or projects. A scope
 * with neither field is "unscoped": it sees only knowledge that was
 * explicitly published to everyone.
 */
export interface OwnershipScope {
  readonly threadId?: string;
  readonly projectId?: string;
}

/** Copy a scope, dropping undefined fields so equality checks are stable. */
export function normalizeScope(scope: OwnershipScope | undefined): OwnershipScope {
  const out: { threadId?: string; projectId?: string } = {};
  if (scope?.threadId) out.threadId = scope.threadId;
  if (scope?.projectId) out.projectId = scope.projectId;
  return out;
}
