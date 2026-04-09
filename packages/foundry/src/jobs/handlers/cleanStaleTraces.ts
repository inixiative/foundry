import { makeSingletonJob } from "../makeSingletonJob";

/**
 * Clean up old traces and spans from Postgres.
 * Keeps the last 30 days by default.
 */
export const cleanStaleTraces = makeSingletonJob(async (ctx) => {
  const { db, log } = ctx;

  const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Delete spans first (foreign key to traces)
  const spanResult = await db.prisma.span.deleteMany({
    where: { startedAt: { lt: cutoffDate } },
  });

  const traceResult = await db.prisma.trace.deleteMany({
    where: { createdAt: { lt: cutoffDate } },
  });

  log(`Cleaned ${traceResult.count} traces and ${spanResult.count} spans older than 30 days`);
});
