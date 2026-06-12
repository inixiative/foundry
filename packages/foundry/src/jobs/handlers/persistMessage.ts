import { makeJob } from "../makeJob";

export type Actor = "user" | "agent" | "system";
export type MessageKind = "text" | "tool_call" | "tool_result" | "thinking" | "error" | "routing";

export type PersistMessagePayload = {
  id: string;
  threadId: string;
  turnId?: string;
  actor: Actor;
  kind?: MessageKind;
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
  log(`Persisted ${payload.actor}/${payload.kind ?? "text"} message ${payload.id}`);
});
