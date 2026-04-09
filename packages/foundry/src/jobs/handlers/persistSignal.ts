import { makeJob } from "../makeJob";

export type PersistSignalPayload = {
  id: string;
  kind: string;
  source: string;
  content: unknown;
  confidence?: number;
  refs?: Array<{ system: string; locator: string }>;
};

/**
 * Persist a signal to Postgres.
 */
export const persistSignal = makeJob<PersistSignalPayload>(async (ctx, payload) => {
  const { db, log } = ctx;

  await db.writeSignal(payload as any);
  log(`Persisted signal ${payload.id} (${payload.kind})`);
});
