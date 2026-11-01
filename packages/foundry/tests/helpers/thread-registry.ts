import type { Thread } from '@inixiative/foundry-core';
import type { LiveThreadRegistry } from '../../src/mcp/authority';

/** A live-thread registry for MCP bridge tests: the threads the bridge may consult, by id. */
export class ThreadRegistry implements LiveThreadRegistry {
  readonly threads = new Map<string, Thread>();
  add(thread: Thread): void {
    this.threads.set(thread.id, thread);
  }
}
