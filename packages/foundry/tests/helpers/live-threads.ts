import type { Thread } from '@inixiative/foundry-core';
import type { LiveThreadRegistry } from '../../src/mcp/authority';

/** A registry of live threads for the MCP bridge (`createFoundryMcp`'s `sessionManager`). */
export function liveThreads(): LiveThreadRegistry & { add(thread: Thread): void } {
  const threads = new Map<string, Thread>();
  return { threads, add: (thread) => void threads.set(thread.id, thread) };
}
