import type { Thread, Trace } from "@inixiative/foundry-core";

/** Validate user-provided IDs — alphanumeric, dashes, underscores, dots. Max 128 chars. */
export function validateId(id: string, label: string): string | null {
  if (!id || typeof id !== "string") return `${label} is required`;
  if (id.length > 128) return `${label} too long (max 128 chars)`;
  if (!/^[a-zA-Z0-9_.-]+$/.test(id)) {
    return `${label} contains invalid characters (use alphanumeric, dash, underscore, dot)`;
  }
  return null;
}

/** Serialize a trace for the API. */
export function traceToJSON(trace: Trace) {
  return {
    id: trace.id,
    messageId: trace.messageId,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    durationMs: trace.durationMs,
    root: trace.root,
    summary: trace.summary(),
  };
}

/** Serialize a thread for the API. */
export function threadToJSON(thread: Thread) {
  return {
    threadId: thread.id,
    meta: thread.meta,
    agents: [...thread.agents.entries()].map(([id, agent]) => ({
      id,
      agentId: agent.id,
    })),
    layerCount: thread.stack.layers.length,
    layers: thread.stack.layers.map((layer) => ({
      id: layer.id,
      state: layer.state,
      trust: layer.trust,
      hash: layer.hash,
      contentLength: layer.content.length,
    })),
  };
}
