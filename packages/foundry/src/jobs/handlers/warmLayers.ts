import { makeSingletonJob } from "../makeSingletonJob";

export type WarmLayersPayload = {
  /** Warm a specific thread's stack. Omit to warm all. */
  threadId?: string;
};

/**
 * Warm all context layers in a thread's stack.
 * Singleton — prevents concurrent warming of the same layers.
 *
 * Requires `stacks` on WorkerContext (set during worker initialization
 * when the worker runs in the same process as the thread).
 */
export const warmLayers = makeSingletonJob<WarmLayersPayload>(async (ctx, payload) => {
  const { log, stacks } = ctx;
  const threadId = payload?.threadId;

  if (!stacks || stacks.size === 0) {
    log("No stacks available — skipping layer warming");
    return;
  }

  if (threadId) {
    // Warm a specific thread's stack
    const stack = stacks.get(threadId);
    if (!stack) {
      log(`Thread "${threadId}" not found in stacks registry — skipping`);
      return;
    }
    await stack.warmAll();
    log(`Warmed ${stack.layers.length} layers for thread "${threadId}"`);
  } else {
    // Warm all registered stacks
    let totalLayers = 0;
    for (const [id, stack] of stacks) {
      await stack.warmAll();
      totalLayers += stack.layers.length;
      log(`Warmed ${stack.layers.length} layers for thread "${id}"`);
    }
    log(`Warmed ${totalLayers} layers across ${stacks.size} threads`);
  }
});
