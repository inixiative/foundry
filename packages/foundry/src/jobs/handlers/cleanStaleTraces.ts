import { makeSingletonJob } from "../makeSingletonJob";

/**
 * Clean up old traces and spans from Postgres.
 * Keeps the last 30 days by default.
 */
export const cleanStaleTraces = makeSingletonJob(async (ctx) => {
  const { db, log } = ctx;

  const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;

  // Delete spans first (foreign key to traces)
  // Span.startedAt is a Float (unix ms), Trace.createdAt is a DateTime
  const spanResult = await db.prisma.span.deleteMany({
    where: { startedAt: { lt: cutoffMs } },
  });

  const traceResult = await db.prisma.trace.deleteMany({
    where: { createdAt: { lt: new Date(cutoffMs) } },
  });

  log(`Cleaned ${traceResult.count} traces and ${spanResult.count} spans older than 30 days`);
});
