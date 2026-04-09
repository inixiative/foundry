import { makeJob } from "../makeJob";

export type PersistMessagePayload = {
  id: string;
  threadId: string;
  role: "user" | "agent" | "system";
  content: string;
  traceId?: string;
  meta?: Record<string, unknown>;
};

/**
 * Persist a conversation message to Postgres.
 */
export const persistMessage = makeJob<PersistMessagePayload>(async (ctx, payload) => {
  const { db, log } = ctx;

  await db.writeMessage(payload);
  log(`Persisted ${payload.role} message ${payload.id}`);
});
