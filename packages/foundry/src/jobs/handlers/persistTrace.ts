import { makeJob } from "../makeJob";
import type { PersistedTraceRecord } from "../../persistence/trace-record";
import { upsertTraceRecord } from "../../persistence/trace-record";

export type PersistTracePayload = {
  traceId: string;
  messageId: string;
  /** Pre-serialized trace (summary already computed, spans flattened). */
  trace: PersistedTraceRecord;
};

/**
 * Persist a completed pipeline trace (with all spans) to Postgres.
 * Runs asynchronously so the API response isn't blocked by DB writes.
 */
export const persistTrace = makeJob<PersistTracePayload>(async (ctx, payload) => {
  const { db, log } = ctx;
  const { trace } = payload;

  await db.prisma.$transaction((tx) => upsertTraceRecord(tx, trace));

  log(`Persisted trace ${trace.id} (${trace.spans.length} spans)`);
});
