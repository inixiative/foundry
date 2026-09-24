import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { mkdir, lstat } from "node:fs/promises";
import { installationCredentialSchema, readPrivateJson, writePrivateJson } from "./kastle-credential-file";
import { KingdomRuntimeConnection, kingdomRuntimeSchema } from "./kingdom-runtime-connection";
import { ConfigStore } from "../viewer/config";

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  url: { type: "string" }, "installation-id": { type: "string" }, "credential-file": { type: "string" },
  "config-dir": { type: "string", default: ".foundry" },
}, strict: true });
if (!values.url || !values["installation-id"] || !values["credential-file"])
  throw Error("Usage: bun scripts/connect-kingdom.ts --url KINGDOM_API_ORIGIN --installation-id UUID --credential-file PRIVATE_FILE [--config-dir DIR]");
const directory = resolve(values["config-dir"]!);
const settings = kingdomRuntimeSchema.parse({ url: values.url, installationId: values["installation-id"], credentialFile: resolve(values["credential-file"]) });
const connection = new KingdomRuntimeConnection(settings, () => 0);
try {
  await connection.check();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
    throw Error("Foundry configuration directory must be owned and private (0700)");
  const store = new ConfigStore(directory);
  const config = await store.load();
  if (config.kingdomRuntime && config.kingdomRuntime.installationId !== settings.installationId)
    throw Error("This Foundry is already enrolled; revoke and remove the old binding before replacing it");
  const secret = installationCredentialSchema.parse(await readPrivateJson(settings.credentialFile));
  const privatePath = join(directory, "kingdom-runtime.json");
  await writePrivateJson(privatePath, secret);
  await store.save({ ...config, kingdomRuntime: { ...settings, credentialFile: privatePath } });
  console.log(JSON.stringify({ connected: true, installationId: settings.installationId, configDirectory: directory, restartViewer: true }));
} finally { connection.stop(); }
