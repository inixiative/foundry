import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { ConfigStore } from "../viewer/config";
import { KingdomRuntimeConnection } from "./kingdom-runtime-connection";
import { beginKingdomPairing, completeKingdomPairing, disconnectKingdom, HOSTED_KINGDOM_URL, kingdomPairInputSchema, pollKingdomPairing, viewerRunning } from "./kingdom-pairing";
import { createTerminalPrompts } from "../setup/prompts";

export const defaultRuntimeName = () => `Foundry on ${hostname()}`.slice(0, 120);
const restartHint = "A Foundry viewer is running; restart it (bun run daemon:start restarts the daemon) so it loads the new Kingdom binding.";

export interface PairKingdomOptions {
  configDir: string;
  url: string;
  name?: string;
  /** Open the verification page (macOS `open`). */
  open?: boolean;
  /** Replace an existing binding instead of refusing. */
  replace?: boolean;
  transport?: typeof fetch;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  launch?: (url: string) => void;
}

/** Device-code pairing for terminals: same persistence as Settings → Kingdom, validated with one runtime socket authentication. */
export async function pairKingdom(options: PairKingdomOptions) {
  const { configDir, transport = fetch, log = console.error, sleep = Bun.sleep } = options;
  const store = new ConfigStore(configDir);
  const existing = (await store.load()).kingdomRuntime;
  if (existing && !options.replace)
    throw Error(`Already paired with ${existing.url} (runtime ${existing.installationId}). Pass --replace to pair again, or run bun run kingdom disconnect.`);
  const input = (() => {
    try { return kingdomPairInputSchema.parse({ url: options.url, name: options.name ?? defaultRuntimeName() }); }
    catch { throw Error("Enter a Kingdom API origin (HTTPS; HTTP only on localhost) and a runtime name of at most 120 characters."); }
  })();
  const pairing = await beginKingdomPairing(input, configDir, transport);
  log(`Approve this Foundry in Kingdom: ${pairing.verificationUrl}`);
  log(`Confirm the pairing code matches: ${pairing.userCode} (expires ${new Date(pairing.expiresAt).toLocaleTimeString()})`);
  if (options.open !== false && (options.launch || process.platform === "darwin")) {
    try { (options.launch ?? (url => { Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" }); }))(pairing.verificationUrl); } catch {}
  }
  log("Waiting for approval…");
  for (;;) {
    await sleep((pairing.interval ?? 5) * 1000);
    if (Date.parse(pairing.expiresAt) <= Date.now()) throw Error("Pairing expired before approval. Run the command again.");
    const result = await pollKingdomPairing(pairing, transport);
    if (result.status === "pending") continue;
    const { settings } = await completeKingdomPairing(store, configDir, pairing, result.installationId,
      { connect: settings => new KingdomRuntimeConnection(settings, () => 0, transport), start: false });
    const restartViewer = await viewerRunning(undefined, transport);
    if (restartViewer) log(restartHint);
    return { status: "connected" as const, url: settings.url, installationId: settings.installationId, restartViewer };
  }
}

/** Socket-checked binding state, in the viewer's vocabulary. */
export async function kingdomStatus(configDir: string, transport: typeof fetch = fetch) {
  const { kingdomRuntime } = await new ConfigStore(configDir).load();
  if (!kingdomRuntime) return { status: "disconnected" as const };
  const connection = new KingdomRuntimeConnection(kingdomRuntime, () => 0, transport);
  const identity = { url: kingdomRuntime.url, installationId: kingdomRuntime.installationId };
  try { await connection.check(); return { status: "connected" as const, ...identity }; }
  catch { return { status: "unavailable" as const, ...identity }; }
  finally { connection.stop(); }
}

/** KINGDOM_URL, then the saved binding, then hosted production. */
export async function defaultKingdomUrl(configDir: string) {
  return process.env.KINGDOM_URL ?? (await new ConfigStore(configDir).load()).kingdomRuntime?.url ?? HOSTED_KINGDOM_URL;
}

const usage = "Usage: bun run kingdom <pair|status|disconnect> [--url KINGDOM_API_ORIGIN] [--name NAME] [--replace] [--no-open] [--config-dir DIR]";

async function main() {
  const { values: v, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, strict: true, options: {
    url: { type: "string" }, name: { type: "string" }, "config-dir": { type: "string" },
    replace: { type: "boolean" }, "no-open": { type: "boolean" }, help: { type: "boolean" },
  } });
  const command = positionals[0];
  if (v.help || !command || !["pair", "status", "disconnect"].includes(command)) { console.log(usage); if (!v.help) process.exitCode = 1; return; }
  const configDir = v["config-dir"] ?? process.env.FOUNDRY_CONFIG_DIR ?? ".foundry";
  const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (command === "status") {
    const status = await kingdomStatus(configDir);
    output(status);
    if (status.status === "unavailable") process.exitCode = 1;
    return;
  }
  if (command === "disconnect") {
    const removed = await disconnectKingdom(new ConfigStore(configDir));
    const restartViewer = !!removed && await viewerRunning();
    if (removed) console.error("Removed this machine's Kingdom credential. Revoke the runtime in Kingdom's Foundry tab too.");
    if (restartViewer) console.error(restartHint);
    output({ status: "disconnected", ...(removed ? { installationId: removed.installationId, restartViewer } : {}) });
    return;
  }
  let url = v.url;
  if (!url) {
    const fallback = await defaultKingdomUrl(configDir);
    if (!process.stdin.isTTY) url = fallback;
    else {
      const prompts = createTerminalPrompts();
      try { url = await prompts.ask("Kingdom API address", fallback); } finally { prompts.close(); }
    }
  }
  output(await pairKingdom({ configDir, url, name: v.name, open: !v["no-open"], replace: v.replace }));
}

if (import.meta.main) main().catch(error => {
  console.error(error instanceof Error && error.name === "Error" ? error.message : "Kingdom command failed; check the address and private configuration directory.");
  process.exitCode = 1;
});
