import type { ThreadMeta } from "@inixiative/foundry-core";

export interface CheckpointImport {
  source: string;
  capturedAt: string;
  threads: Array<{ id: string; meta: ThreadMeta }>;
  traces: Array<{ threadId: string; trace: Record<string, any> }>;
  excluded: Array<{ id: string; reason: string }>;
}

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;

/** Flatten recorded spans without inventing missing attribution. */
export function checkpointSpans(root: unknown): Array<Record<string, any>> {
  const spans: Array<Record<string, any>> = [];
  const visit = (span: unknown, depth: number) => {
    if (!object(span) || depth > 64 || spans.length >= 10_000) throw new Error("Malformed or oversized trace tree");
    spans.push(span);
    if (span.children !== undefined && !Array.isArray(span.children)) throw new Error("Malformed trace children");
    for (const child of span.children ?? []) visit(child, depth + 1);
  };
  visit(root, 0);
  return spans;
}

/** A checkpoint is historical evidence, not proof that a native turn succeeded. */
export function prepareCheckpointImport(value: unknown, source: string): CheckpointImport {
  if (!object(value) || value.version !== 1 || value.restartCandidate !== true
    || !Array.isArray(value.activeThreadIds) || value.activeThreadIds.length) throw new Error("An idle version-1 checkpoint is required");
  if (!string(source) || !string(value.finishedAt) || !Number.isFinite(Date.parse(value.finishedAt))) throw new Error("Invalid checkpoint provenance");
  if (!Array.isArray(value.threads) || !Array.isArray(value.traces)) throw new Error("Missing checkpoint threads or traces");
  const threads = value.threads.map((row: unknown) => {
    if (!object(row) || !string(row.threadId) || !object(row.meta)) throw new Error("Invalid checkpoint thread");
    const m = row.meta;
    if (typeof m.description !== "string" || !Array.isArray(m.tags) || m.tags.some((tag: unknown) => typeof tag !== "string")
      || !["idle", "waiting", "archived"].includes(m.status)
      || !Number.isFinite(m.createdAt) || !Number.isFinite(m.lastActiveAt)) throw new Error(`Invalid thread metadata: ${row.threadId}`);
    if (row.projectId !== undefined && m.projectId !== row.projectId) throw new Error(`Conflicting project ownership: ${row.threadId}`);
    const meta: ThreadMeta = { description: m.description, tags: [...m.tags], status: m.status,
      createdAt: m.createdAt, lastActiveAt: m.lastActiveAt };
    for (const key of ["projectId", "cwd", "branch", "parentThreadId"] as const) {
      if (m[key] !== undefined) {
        if (!string(m[key])) throw new Error(`Invalid ${key}: ${row.threadId}`);
        meta[key] = m[key];
      }
    }
    if (m.archivedAt !== undefined) {
      if (!Number.isFinite(m.archivedAt)) throw new Error("Invalid archive timestamp");
      meta.archivedAt = m.archivedAt;
    }
    return { id: row.threadId, meta };
  });
  const ids = new Set(threads.map(thread => thread.id));
  if (ids.size !== threads.length) throw new Error("Duplicate checkpoint thread IDs");
  const traces: CheckpointImport["traces"] = [];
  const excluded: CheckpointImport["excluded"] = [];
  for (const trace of value.traces) {
    if (!object(trace) || !string(trace.id) || !string(trace.messageId)) throw new Error("Invalid checkpoint trace identity");
    const owners = new Set<string>();
    for (const span of checkpointSpans(trace.root)) {
      if (string(span.threadId)) owners.add(span.threadId);
      for (const layer of span.annotations?.injection?.layers ?? []) {
        if (string(layer.threadId)) owners.add(layer.threadId);
      }
    }
    const owner = [...owners][0];
    if (owners.size !== 1 || !ids.has(owner)) {
      excluded.push({ id: trace.id, reason: "Trace does not prove one known thread owner" });
      continue;
    }
    if (!Number.isFinite(trace.endedAt)) {
      excluded.push({ id: trace.id, reason: "Trace had not ended when captured" });
      continue;
    }
    traces.push({ threadId: owner, trace: structuredClone(trace) });
  }
  return { source, capturedAt: value.finishedAt, threads, traces, excluded };
}
