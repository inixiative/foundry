import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigStore } from '../viewer/config';
import { KingdomRuntimeConnection, kingdomRuntimeId } from './kingdom-runtime-connection';
import { overallStatus } from './kingdom-runtime-connections';
import { RuntimeJobRegistry } from './runtime-job-handler';
import { RuntimeJobWorker } from './runtime-job-worker';

const { values } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: {
    'config-dir': { type: 'string', default: '.foundry' },
    once: { type: 'boolean', default: false },
  },
});
const runtimes =
  (await new ConfigStore(resolve(values['config-dir']!)).load()).kingdomRuntimes ?? [];
if (!runtimes.length) throw Error('Pair this Foundry with Kingdom first: bun run kingdom pair');
const handlers = new RuntimeJobRegistry();
// Each paired Kingdom polls and reports through its own connection and worker.
const workers = runtimes.map((runtime) => ({
  runtime,
  id: kingdomRuntimeId(runtime),
  connection: new KingdomRuntimeConnection(runtime, () => 0, fetch, handlers),
  jobs: new RuntimeJobWorker(runtime, fetch, handlers),
}));
let stopped = false;
const stop = () => {
  stopped = true;
  for (const worker of workers) {
    worker.connection.stop();
    worker.jobs.stop();
  }
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
const cycle = async (worker: (typeof workers)[number]) => {
  try {
    await worker.connection.check();
    await worker.jobs.check();
    return true;
  } catch {
    console.error(
      `Kingdom ${worker.id}: runtime unavailable or job incomplete; private state retained. No uncertain operation will be retried.`,
    );
    return false;
  }
};
try {
  const listed = await Promise.all(
    workers.map(async ({ runtime, id, connection }) => ({
      id,
      url: runtime.url,
      installationId: runtime.installationId,
      status: await connection.check().then(
        () => 'connected' as const,
        () => 'unavailable' as const,
      ),
    })),
  );
  if (listed.every((item) => item.status === 'unavailable'))
    throw Error('No paired Kingdom is available');
  console.log(
    JSON.stringify({
      status: overallStatus(listed),
      runtimes: listed,
      jobs: handlers.kinds,
      inboundListener: false,
    }),
  );
  do {
    const results = await Promise.all(workers.map(cycle));
    if (values.once && results.includes(false)) process.exitCode = 1;
    if (!values.once && !stopped) await Bun.sleep(15000);
  } while (!values.once && !stopped);
} finally {
  stop();
}
