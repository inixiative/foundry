import Redis from "ioredis";
import { type Job, Worker } from "bullmq";
import type { PostgresMemory } from "../adapters/postgres-memory";
import { isValidHandlerName, jobHandlers } from "./handlers";
import type { JobsQueue, WorkerContext } from "./types";

let jobsWorker: Worker | null = null;
let workerRedis: Redis | null = null;

export interface WorkerInitOpts {
  queue: JobsQueue;
  redisUrl: string;
  db: PostgresMemory;
  concurrency?: number;
}

/**
 * Initialize the BullMQ worker.
 * Processes jobs from the "foundry-jobs" queue.
 */
export async function initializeWorker(opts: WorkerInitOpts): Promise<Worker> {
  const { queue, redisUrl, db, concurrency = 10 } = opts;

  // BullMQ Worker needs its own Redis connection (separate from Queue)
  workerRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });

  jobsWorker = new Worker(
    "foundry-jobs",
    async (job: Job) => {
      if (!isValidHandlerName(job.name)) {
        console.error(`[Worker] Unknown job handler: ${job.name}`);
        throw new Error(`Unknown job handler: ${job.name}`);
      }

      const handler = jobHandlers[job.name];

      const jobLog = (message: string) => {
        console.log(`  [Worker:${job.name}:${job.id}] ${message}`);
        job.log(message);
      };

      const ctx: WorkerContext = {
        db,
        queue,
        job,
        log: jobLog,
      };

      jobLog(`Processing job ${job.name}`);

      try {
        const payload = (job.data as { payload?: unknown }).payload;
        if (payload === undefined) {
          await (handler as (handlerCtx: WorkerContext) => Promise<void>)(ctx);
        } else {
          await (handler as (handlerCtx: WorkerContext, handlerPayload: unknown) => Promise<void>)(
            ctx,
            payload,
          );
        }
        jobLog(`Completed`);
      } catch (error) {
        console.error(`[Worker] Failed job ${job.name} (${job.id}):`, error);
        job.log(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    },
    {
      connection: workerRedis,
      concurrency,
      lockDuration: 5 * 60 * 1000,
    },
  );

  console.log(`[Worker] Initialized (concurrency: ${concurrency})`);

  return jobsWorker;
}

/** Gracefully shut down the worker. */
export async function shutdownWorker(): Promise<void> {
  if (jobsWorker) {
    console.log("[Worker] Shutting down...");
    await jobsWorker.close();
    jobsWorker = null;
  }
  if (workerRedis) {
    await workerRedis.quit();
    workerRedis = null;
  }
  console.log("[Worker] Stopped");
}
