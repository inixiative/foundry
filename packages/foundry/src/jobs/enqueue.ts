import { isValidHandlerName, type JobPayloads } from "./handlers";
import type { JobsQueue, JobOptions, JobType } from "./types";

type EnqueueOptions = JobOptions & {
  type?: JobType;
  id?: string;
};

let _queue: JobsQueue | null = null;

/** Set the queue instance (called once during initialization). */
export function setQueue(queue: JobsQueue): void {
  _queue = queue;
}

/**
 * Type-safe job enqueuing.
 *
 * Usage:
 *   await enqueueJob("persistTrace", { traceId, messageId, trace });
 *   await enqueueJob("cleanStaleTraces", undefined, { id: "cleanStaleTraces" });
 */
export const enqueueJob = async <K extends keyof JobPayloads>(
  handlerName: K,
  payload: JobPayloads[K],
  options?: EnqueueOptions,
): Promise<{ jobId: string | undefined; name: string }> => {
  if (!_queue) {
    console.warn(`[Jobs] Queue not initialized — skipping job: ${handlerName}`);
    return { jobId: undefined, name: handlerName };
  }

  if (!isValidHandlerName(handlerName)) {
    throw new Error(`Unknown job handler: ${handlerName}`);
  }

  const { type = "adhoc", id, ...jobOptions } = options || {};

  const job = await _queue.add(
    handlerName,
    { type, id, payload },
    { ...jobOptions, jobId: options?.jobId || undefined },
  );

  return { jobId: job.id, name: job.name };
};
