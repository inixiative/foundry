import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { ConfigStore } from "../viewer/config";
import { KingdomRuntimeConnections } from "./kingdom-runtime-connections";
import { RuntimeJobRegistry } from "./runtime-job-handler";

const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: { "config-dir": { type: "string", default: ".foundry" }, once: { type: "boolean", default: false } } });
const config = await new ConfigStore(resolve(values["config-dir"]!)).load();
if (!config.kingdomRuntimes?.length) throw Error("Connect this Foundry to Kingdom first");
const handlers = new RuntimeJobRegistry();
const connections = new KingdomRuntimeConnections(config.kingdomRuntimes, () => 0, fetch, handlers);
const incomplete = "Runtime unavailable or job incomplete; private state retained. No uncertain operation will be retried.";
let release = () => {};
const stopped = new Promise<void>(resolve => { release = resolve; });
const keepAlive = setInterval(() => {}, 1 << 30);
const stop = () => { connections.stop(); clearInterval(keepAlive); release(); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
try {
  await connections.start();
  console.log(JSON.stringify({ status: "connected", runtimes: config.kingdomRuntimes.map(({ url, installationId }) => ({ url, installationId })), jobs: handlers.kinds, inboundListener: false }));
  if (values.once) await Promise.all(connections.all().map(connection => connection.claimJobs()));
  else await stopped;
} catch {
  console.error(incomplete);
  process.exitCode = 1;
} finally { stop(); }
