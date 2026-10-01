import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { ConfigStore } from "../viewer/config";
import { KingdomRuntimeConnection, kingdomRuntimeId, selectKingdomRuntime } from "./kingdom-runtime-connection";
import { beginKingdomPairing, completeKingdomPairing, disconnectKingdom, HOSTED_KINGDOM_URL, kingdomPairInputSchema, pollKingdomPairing, viewerRunning } from "./kingdom-pairing";
import { overallStatus } from "./kingdom-runtime-connections";
import { createTerminalPrompts } from "../setup/prompts";

export const defaultRuntimeName = () => `Foundry on ${hostname()}`.slice(0, 120);
const restartHint = "A Foundry viewer is running; restart it (bun run daemon:start restarts the daemon) so it loads the changed Kingdom pairing.";

export interface PairKingdomOptions {
  configDir: string;
  /** Required unless `replace` selects the paired Kingdom. */
  url?: string;
  name?: string;
  /** Open the verification page (macOS `open`). */
  open?: boolean;
  /** Re-pair an already paired Kingdom (selected by `kingdom`, else by `url`) instead of adding one. */
  replace?: boolean;
  /** Paired Kingdom id or API origin that `replace` targets. */
  kingdom?: string;
  transport?: typeof fetch;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  launch?: (url: string) => void;
}

/** Device-code pairing for terminals: same persistence as Settings → Kingdom, validated with one heartbeat. */
export async function pairKingdom(options: PairKingdomOptions) {
  const { configDir, transport = fetch, log = console.error, sleep = Bun.sleep } = options;
  const store = new ConfigStore(configDir);
  const runtimes = (await store.load()).kingdomRuntimes ?? [];
  const replaced = options.replace ? selectKingdomRuntime(runtimes, options.kingdom ?? options.url) : undefined;
  const input = (() => {
    try { return kingdomPairInputSchema.parse({ url: replaced?.url ?? options.url, name: options.name ?? defaultRuntimeName() }); }
    catch { throw Error("Enter a Kingdom API origin (HTTPS; HTTP only on localhost) and a runtime name of at most 120 characters."); }
  })();
  const paired = runtimes.filter(runtime => runtime.url === input.url);
  if (!replaced && paired.length)
    log(`Already paired with ${input.url} as ${paired.map(runtime => runtime.owner).join(", ")}. Approve as a different owner to add it, or pass --replace to pair that one again.`);
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
    const { id, settings } = await completeKingdomPairing(store, configDir, pairing, result.installationId,
      { transport, ...(replaced ? { replace: kingdomRuntimeId(replaced) } : {}) });
    const restartViewer = await viewerRunning(undefined, transport);
    if (restartViewer) log(restartHint);
    return { status: "connected" as const, id, url: settings.url, owner: settings.owner, installationId: settings.installationId, restartViewer };
  }
}

export type KingdomRuntimeStatus = { id: string; url: string; owner: string; installationId: string; status: "connected" | "unavailable" };

/** Heartbeat-checked state of every paired Kingdom, checked concurrently, in the viewer's vocabulary. */
export async function kingdomStatus(configDir: string, transport: typeof fetch = fetch) {
  const runtimes = (await new ConfigStore(configDir).load()).kingdomRuntimes ?? [];
  const listed: KingdomRuntimeStatus[] = await Promise.all(runtimes.map(async runtime => {
    const identity = { id: kingdomRuntimeId(runtime), url: runtime.url, owner: runtime.owner, installationId: runtime.installationId };
    const connection = new KingdomRuntimeConnection(runtime, () => 0, transport);
    try { await connection.check(); return { ...identity, status: "connected" as const }; }
    catch { return { ...identity, status: "unavailable" as const }; }
    finally { connection.stop(); }
  }));
  return { status: overallStatus(listed), runtimes: listed };
}

/** KINGDOM_URL, then hosted production. */
export const defaultKingdomUrl = () => process.env.KINGDOM_URL ?? HOSTED_KINGDOM_URL;

const usage = "Usage: bun run kingdom <pair|status|disconnect> [--url KINGDOM_API_ORIGIN] [--name NAME] [--replace] [--kingdom ID|URL] [--no-open] [--config-dir DIR]";

async function main() {
  const { values: v, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, strict: true, options: {
    url: { type: "string" }, name: { type: "string" }, kingdom: { type: "string" }, "config-dir": { type: "string" },
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
    const removed = await disconnectKingdom(new ConfigStore(configDir), v.kingdom);
    const restartViewer = !!removed && await viewerRunning();
    if (removed) console.error(`Removed this machine's credential for ${removed.url} (${removed.owner}). Revoke the runtime in Kingdom's Foundry tab too.`);
    if (restartViewer) console.error(restartHint);
    const remaining = ((await new ConfigStore(configDir).load()).kingdomRuntimes ?? []).map(runtime => ({ id: kingdomRuntimeId(runtime), url: runtime.url, owner: runtime.owner }));
    output({ status: "disconnected", ...(removed ? { removed: { id: removed.id, url: removed.url, installationId: removed.installationId }, restartViewer } : {}), ...(remaining.length ? { remaining } : {}) });
    return;
  }
  let url = v.url;
  if (!url && !v.replace) {
    const fallback = defaultKingdomUrl();
    if (!process.stdin.isTTY) url = fallback;
    else {
      const prompts = createTerminalPrompts();
      try { url = await prompts.ask("Kingdom API address", fallback); } finally { prompts.close(); }
    }
  }
  output(await pairKingdom({ configDir, url, name: v.name, open: !v["no-open"], replace: v.replace, kingdom: v.kingdom }));
}

if (import.meta.main) main().catch(error => {
  console.error(error instanceof Error && error.name === "Error" ? error.message : "Kingdom command failed; check the address and private configuration directory.");
  process.exitCode = 1;
});
