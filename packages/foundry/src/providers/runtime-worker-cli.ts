import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { ConfigStore } from "../viewer/config";
import { KingdomRuntimeConnection } from "./kingdom-runtime-connection";
import { RuntimeJobRegistry } from "./runtime-job-handler";

const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: { "config-dir": { type: "string", default: ".foundry" }, once: { type: "boolean", default: false } } });
const config = await new ConfigStore(resolve(values["config-dir"]!)).load();
if (!config.kingdomRuntime) throw Error("Connect this Foundry to Kingdom first");
const handlers = new RuntimeJobRegistry();
const connection = new KingdomRuntimeConnection(config.kingdomRuntime, () => 0, fetch, handlers);
const incomplete = "Runtime unavailable or job incomplete; private state retained. No uncertain operation will be retried.";
let release = () => {};
const stopped = new Promise<void>(resolve => { release = resolve; });
const keepAlive = setInterval(() => {}, 1 << 30);
const stop = () => { connection.stop(); clearInterval(keepAlive); release(); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
try {
  await connection.start();
  console.log(JSON.stringify({ status: "connected", installationId: config.kingdomRuntime.installationId, jobs: handlers.kinds, inboundListener: false }));
  if (values.once) await connection.claimJobs();
  else await stopped;
} catch {
  console.error(incomplete);
  process.exitCode = 1;
} finally { stop(); }
