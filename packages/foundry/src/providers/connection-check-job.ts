import { z } from "zod";
import { RuntimeJobRecord } from "./runtime-job-record";
import type { RuntimeJobHandler } from "./runtime-job-handler";

/** Framework handler: proves a Kastle connection end to end without executing any domain work. */
export const connectionCheckJobHandler: RuntimeJobHandler<null> = {
  kind: "connectionCheck",
  payload: z.looseObject({ payload: z.null() }).transform(() => null),
  async run(job, _payload, context) {
    const record = await RuntimeJobRecord.open(job, context, "Foundry connection check");
    if (!record.terminal)
      await record.save({ phase: "finished", outcome: { allowedReads: 0, forbiddenDocumentDenied: false, searchDenied: false, afterCloseDenied: false, allergies: [] } });
    await record.finish();
  },
};
