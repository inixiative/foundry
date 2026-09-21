import { createHash } from "node:crypto";
import type { NativeBridgeLease } from "@inixiative/foundry-core";

/** Metadata-only recording policy: neither launch paths/config nor capability
 * contents can enter argv reports. Original executable argv is never rewritten
 * by this sanitizer. Unknown arguments retain only their position and a hash. */
export function nativeLaunchEvidence(argv: readonly string[]) {
  return Object.freeze(argv.map((value, index) => Object.freeze({ index,
    kind: value === "--mcp-config" || value.startsWith("--mcp-config=") ? "mcp-config"
      : value === "-c" || value === "--config" || value.startsWith("--config=") ? "config" : "opaque",
    sha256: createHash("sha256").update(value).digest("hex"),
  })));
}

/** Convert only our already-owned launch descriptor. Never read native settings,
 * arbitrary files, environment or a token. App-server accepts flat config keys
 * on both thread/start and thread/resume. Other explicit config stays intact. */
export function appServerBridgeConfiguration(bridge: NativeBridgeLease, existing: Readonly<Record<string, unknown>> = {}) {
  bridge.check();
  if (!/^[a-zA-Z0-9_-]+$/.test(bridge.name)) throw Error("Invalid owned bridge name");
  const key = `mcp_servers.${bridge.name}`;
  const nested = existing.mcp_servers;
  if (Object.keys(existing).some(k => k === key || k.startsWith(`${key}.`)) || (nested && typeof nested === "object" && Object.hasOwn(nested, bridge.name))) throw Error("Native bridge server name collision");
  const parsed = JSON.parse(bridge.launch.claudeJson);
  const servers = parsed?.mcpServers;
  const server = servers?.[bridge.name];
  if (!servers || Object.keys(servers).length !== 1 || !server || Object.keys(server).sort().join(",") !== "args,command"
    || server.command !== "bun" || !Array.isArray(server.args) || server.args.length !== 2 || !server.args.every((v:unknown) => typeof v === "string" && v.length > 0)) throw Error("Owned bridge launch descriptor is invalid");
  return { ...structuredClone(existing), [key]: { command: server.command, args: [...server.args] } };
}

/** Add only one process-owned unique server. Keep other tools/configuration and
 * all model/effort/budget arguments. Refuse explicit conflicting policy. */
export function withNativeBridge(argv: readonly string[], engine: "claude" | "codex", bridge: NativeBridgeLease): string[] {
  bridge.check();
  if (bridge.toolPolicy) throw Error("Fixture lease requires the isolated transport; generic bridge launch refused");
  const result = [...argv];
  if (engine === "claude") {
    if (argv.some(arg => ["--safe-mode", "--strict-mcp-config", "--bare"].includes(arg))) throw Error("Native bridge conflicts with the existing central MCP policy");
    let insertion = -1;
    for (let i = 1; i < result.length; i++) {
      if (result[i].startsWith("--mcp-config=")) result.splice(i, 1, "--mcp-config", result[i].slice("--mcp-config=".length));
      if (result[i] !== "--mcp-config") continue;
      let end = i + 1;
      while (end < result.length && !result[end].startsWith("-")) {
        const value = result[end];
        if (value.trimStart().startsWith("{")) {
          let config: unknown; try { config = JSON.parse(value); } catch { throw Error("Existing MCP JSON is invalid"); }
          if (config && typeof config === "object" && Object.hasOwn((config as any).mcpServers ?? {}, bridge.name)) throw Error("Native bridge server name collision");
        }
        end++;
      }
      if (end === i + 1 || insertion !== -1) throw Error("Ambiguous existing MCP configuration arguments");
      insertion = end; i = end - 1;
    }
    if (insertion < 0) result.push("--mcp-config", bridge.launch.claudeJson);
    else result.splice(insertion, 0, bridge.launch.claudeJson);
  } else {
    // Do not read arbitrary user config files. Unique names avoid taking over an
    // existing normal server; explicit argv collisions still fail closed.
    if (argv.some(arg => arg.includes(`mcp_servers.${bridge.name}`) || arg.includes(`"${bridge.name}"`))) throw Error("Native bridge server name collision");
    for (const override of bridge.launch.codexOverrides) result.push("-c", override);
  }
  return result;
}

/** Exact configuration for the isolated fixture transport. This validates argv,
 * not same-host containment: managed policy can still execute startup hooks in
 * Claude 2.1.260. Only a controlled transport may currently consume this plan. */
export function withIsolatedFixture(argv: readonly string[], bridge: NativeBridgeLease): string[] {
  bridge.check();
  if (bridge.toolPolicy?.version !== "isolated-fixture-v1" || !/^[a-f0-9]{64}$/.test(bridge.toolPolicy.digest) || !bridge.fixtureCwd)
    throw Error("Owned fixture policy required");
  // Validate the process-owned descriptor before copying it. Its capability
  // stays in the private launch file, never the argv/config evidence.
  appServerBridgeConfiguration(bridge);
  const valueFlags = new Set(["--input-format", "--output-format", "--model", "--effort", "--max-turns", "--permission-mode", "--append-system-prompt", "--setting-sources"]);
  const switches = new Set(["--print", "--verbose", "--include-hook-events"]);
  const seen = new Set<string>();
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    if (seen.has(flag)) throw Error("Duplicate isolated launch setting");
    seen.add(flag);
    if (switches.has(flag)) continue;
    if (!valueFlags.has(flag) || ++index >= argv.length) throw Error("Unapproved isolated launch option");
    const value = argv[index];
    if (["--input-format", "--output-format"].includes(flag) && value !== "stream-json"
      || flag === "--permission-mode" && value !== "dontAsk"
      || flag === "--setting-sources" && value !== ""
      || flag === "--max-turns" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100)) throw Error("Unapproved isolated launch value");
  }
  if (!["--print", "--input-format", "--output-format", "--model", "--permission-mode", "--max-turns"].every(flag => seen.has(flag))) throw Error("Bounded isolated launch configuration required");
  return [...argv, "--restricted", "--tools", "", "--strict-mcp-config", "--mcp-config", bridge.launch.claudeJson,
    "--disable-slash-commands", "--no-chrome", "--no-session-persistence",
    ...(!seen.has("--setting-sources") ? ["--setting-sources", ""] : []),
    "--settings", JSON.stringify({ disableAllHooks: true, disableClaudeAiConnectors: true })];
}
