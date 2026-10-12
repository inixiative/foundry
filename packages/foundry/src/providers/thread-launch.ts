/**
 * What a host (an ACP client, or the viewer) chose for one thread's executor session: the
 * permission mode, model and effort it runs with and the MCP servers it carries. Access follows
 * the host: a mode is the native runtime's own permission mode, full access included, and Foundry
 * adds none of its own. Held in daemon memory only, never under `.foundry`, because client MCP
 * server `env` and `headers` can hold secrets; a host re-supplies them on `session/load`.
 *
 * A change takes effect on the thread's next turn: the warm session is relaunched (resuming its
 * native binding) with the new settings once it is idle.
 */

/** The hosts' permission modes (Claude's ids, which Zed and Paseo render). */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Native effort levels both CLIs accept. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** A client MCP server, in ACP's shape (`stdio` without a type, or `http`). */
export type ClientMcpServer =
  | {
      readonly type?: undefined;
      readonly name: string;
      readonly command: string;
      readonly args: readonly string[];
      readonly env: readonly { readonly name: string; readonly value: string }[];
    }
  | {
      readonly type: 'http';
      readonly name: string;
      readonly url: string;
      readonly headers: readonly { readonly name: string; readonly value: string }[];
    };

export interface ThreadLaunch {
  readonly permissionMode?: PermissionMode;
  readonly model?: string;
  readonly effort?: EffortLevel;
  readonly mcpServers?: readonly ClientMcpServer[];
  /** Bumped on every change; a warm session launched at an older revision is relaunched. */
  readonly revision: number;
}

export type ThreadLaunchPatch = {
  permissionMode?: PermissionMode | null;
  model?: string | null;
  effort?: EffortLevel | null;
  mcpServers?: readonly ClientMcpServer[] | null;
};

const SERVER_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A validated copy of client MCP servers; throws on anything Foundry will not launch. */
export function clientMcpServers(value: unknown): ClientMcpServer[] {
  if (!Array.isArray(value)) throw Error('mcpServers must be an array');
  const names = new Set<string>();
  return value.map((raw, index) => {
    const server = raw as Record<string, unknown> | null;
    if (!server || typeof server !== 'object') throw Error(`mcpServers[${index}] is not an object`);
    const name = server.name;
    if (typeof name !== 'string' || !SERVER_NAME.test(name))
      throw Error(`mcpServers[${index}].name must match ${SERVER_NAME}`);
    if (names.has(name)) throw Error(`Duplicate MCP server name: ${name}`);
    names.add(name);
    const pairs = (list: unknown, field: string) => {
      if (!Array.isArray(list)) throw Error(`mcpServers[${index}].${field} must be an array`);
      return list.map((entry) => {
        const pair = entry as Record<string, unknown> | null;
        if (typeof pair?.name !== 'string' || typeof pair.value !== 'string')
          throw Error(`mcpServers[${index}].${field} entries need string name and value`);
        return { name: pair.name, value: pair.value };
      });
    };
    if (server.type === 'http') {
      if (typeof server.url !== 'string' || !/^https?:\/\//.test(server.url))
        throw Error(`mcpServers[${index}].url must be http(s)`);
      return {
        type: 'http',
        name,
        url: server.url,
        headers: pairs(server.headers ?? [], 'headers'),
      };
    }
    if (server.type !== undefined)
      throw Error(`MCP server ${name}: transport ${String(server.type)} is not supported`);
    if (typeof server.command !== 'string' || !server.command)
      throw Error(`mcpServers[${index}].command is required`);
    const args = server.args ?? [];
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string'))
      throw Error(`mcpServers[${index}].args must be strings`);
    const env = pairs(server.env ?? [], 'env');
    for (const variable of env)
      if (!ENV_NAME.test(variable.name)) throw Error(`Invalid env name: ${variable.name}`);
    return { name, command: server.command, args: [...args], env };
  });
}

/** Names and transports only: never env or header values. */
export function describeMcpServers(servers: readonly ClientMcpServer[] | undefined) {
  return (servers ?? []).map((server) =>
    server.type === 'http'
      ? { name: server.name, type: 'http' as const, url: server.url }
      : { name: server.name, type: 'stdio' as const, command: server.command },
  );
}

export class ThreadLaunchSettings {
  private readonly threads = new Map<string, ThreadLaunch>();
  private readonly listeners = new Set<(threadId: string, launch: ThreadLaunch) => void>();

  get(threadId: string): ThreadLaunch {
    return this.threads.get(threadId) ?? { revision: 0 };
  }

  /** Apply a host's choice; `null` clears a field back to the thread's configured default. */
  update(threadId: string, patch: ThreadLaunchPatch): ThreadLaunch {
    const current = this.get(threadId);
    if (patch.permissionMode != null && !PERMISSION_MODES.includes(patch.permissionMode))
      throw Error(`Unknown permission mode: ${patch.permissionMode}`);
    if (patch.effort != null && !EFFORT_LEVELS.includes(patch.effort))
      throw Error(`Unknown effort: ${patch.effort}`);
    if (patch.model != null && (typeof patch.model !== 'string' || !patch.model.trim()))
      throw Error('model must be a non-empty string');
    const next: Record<string, unknown> = { ...current };
    for (const key of ['permissionMode', 'model', 'effort'] as const)
      if (key in patch) {
        if (patch[key] === null) delete next[key];
        else next[key] = patch[key];
      }
    if ('mcpServers' in patch) {
      if (patch.mcpServers === null || patch.mcpServers?.length === 0) delete next.mcpServers;
      else next.mcpServers = clientMcpServers(patch.mcpServers);
    }
    const changed = (['permissionMode', 'model', 'effort', 'mcpServers'] as const).some(
      (key) => JSON.stringify(next[key] ?? null) !== JSON.stringify(current[key] ?? null),
    );
    if (!changed) return current;
    const launch = { ...next, revision: current.revision + 1 } as ThreadLaunch;
    this.threads.set(threadId, launch);
    for (const listener of this.listeners) listener(threadId, launch);
    return launch;
  }

  /** Notified after every change. */
  onChange(listener: (threadId: string, launch: ThreadLaunch) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(threadId: string): void {
    this.threads.delete(threadId);
  }
}
