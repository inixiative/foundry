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
