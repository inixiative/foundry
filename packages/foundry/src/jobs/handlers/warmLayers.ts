import { makeSingletonJob } from "../makeSingletonJob";

/**
 * Warm all context layers in a thread's stack.
 * Singleton — prevents concurrent warming of the same layers.
 */
export const warmLayers = makeSingletonJob(async (ctx) => {
  const { log } = ctx;
  // This handler is a placeholder — actual warming needs a reference to the stack.
  // In practice, the worker will be initialized with access to the thread registry,
  // and this job will call stack.warmAll() for the specified thread.
  log("Layer warming job executed (wire to stack in worker initialization)");
});
