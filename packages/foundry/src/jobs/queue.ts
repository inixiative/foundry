import Redis from "ioredis";
import { Queue } from "bullmq";
import type { JobsQueue } from "./types";

/**
 * Create the BullMQ queue.
 * BullMQ requires separate Redis connections for Queue and Worker.
 */
export function createQueue(redisUrl: string): JobsQueue {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

  const baseQueue = new Queue("foundry-jobs", {
    connection: redis,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { age: 7 * 24 * 60 * 60, count: 500 },
      removeOnFail: { age: 30 * 24 * 60 * 60 },
    },
  });

  return Object.assign(baseQueue, { redis }) as JobsQueue;
}
