import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { ConfigStore } from "../viewer/config";
import { KingdomRuntimeConnection } from "./kingdom-runtime-connection";
import { RuntimeJobRegistry } from "./runtime-job-handler";
import { RuntimeJobWorker } from "./runtime-job-worker";

const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: { "config-dir": { type: "string", default: ".foundry" }, once: { type: "boolean", default: false } } });
const config = await new ConfigStore(resolve(values["config-dir"]!)).load();
if (!config.kingdomRuntime) throw Error("Connect this Foundry to Kingdom first");
const handlers = new RuntimeJobRegistry();
const connection = new KingdomRuntimeConnection(config.kingdomRuntime, () => 0, fetch, handlers);
const jobs = new RuntimeJobWorker(config.kingdomRuntime, fetch, handlers);
let stopped = false;
const stop = () => { stopped = true; connection.stop(); jobs.stop(); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
try {
  await connection.check();
  console.log(JSON.stringify({ status: "connected", installationId: config.kingdomRuntime.installationId, jobs: handlers.kinds, inboundListener: false }));
  do {
    try { await connection.check(); await jobs.check(); }
    catch { console.error("Runtime unavailable or job incomplete; private state retained. No uncertain operation will be retried."); if (values.once) process.exitCode = 1; }
    if (!values.once && !stopped) await Bun.sleep(15000);
  } while (!values.once && !stopped);
} finally { stop(); }
