import { idAtTime } from "@inixiative/foundry-core";
import { makeSingletonJob } from "../makeSingletonJob";

/**
 * Clean up old traces and spans from Postgres.
 * Keeps the last 30 days by default.
 *
 * Trace IDs are UUID v7 with a `trace_` prefix — the first 48 bits encode
 * the creation timestamp, so we can translate a time cutoff into an id cutoff.
 * Span.startedAt is still a Float (perf ms), so that query stays numeric.
 */
export const cleanStaleTraces = makeSingletonJob(async (ctx) => {
  const { db, log } = ctx;

  const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const spanResult = await db.prisma.span.deleteMany({
    where: { startedAt: { lt: cutoffMs } },
  });

  const traceResult = await db.prisma.trace.deleteMany({
    where: { id: { lt: idAtTime("trace", new Date(cutoffMs)) } },
  });

  log(`Cleaned ${traceResult.count} traces and ${spanResult.count} spans older than 30 days`);
});
