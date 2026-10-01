import { z } from 'zod';
import type { RuntimeJobHandler } from './runtime-job-handler';
import { RuntimeJobRecord } from './runtime-job-record';

/** Framework handler: proves a Kingdom connection end to end without executing any domain work. */
export const connectionCheckJobHandler: RuntimeJobHandler<null> = {
  kind: 'connectionCheck',
  payload: z.looseObject({ payload: z.null() }).transform(() => null),
  async run(job, _payload, context) {
    const record = await RuntimeJobRecord.open(job, context, 'Foundry connection check');
    if (!record.terminal) await record.save({ phase: 'finished' });
    await record.finish();
  },
};
