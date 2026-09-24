import { z } from "zod";
import { existsSync, mkdirSync, readdirSync, rmdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { assertPrivateProfile, assertProfile, writeProfileConfiguration } from "./private-profile";
import { profileEnvironment } from "./default-profiles";

export type NativeAuthenticationSource = {
  /** Local identities, never provider account names or secrets. */
  id: string;
  connectionId: string;
  runtime: "claude" | "codex";
} & ({ mode: "native-profile"; profileDirectory: string } | {
  mode: "gateway";
  baseUrl: string;
  credential: { type: "environment"; variable: string } | {
    type: "command"; command: string; args?: string[]; refreshIntervalMs?: number;
  };
});

const identity = { id: z.string(), connectionId: z.string(), runtime: z.enum(["claude", "codex"]) };
const sourceSchema = z.discriminatedUnion("mode", [
  z.object({ ...identity, mode: z.literal("native-profile"), profileDirectory: z.string() }).strict(),
  z.object({ ...identity, mode: z.literal("gateway"), baseUrl: z.string(), credential: z.discriminatedUnion("type", [
    z.object({ type: z.literal("environment"), variable: z.string() }).strict(),
    z.object({ type: z.literal("command"), command: z.string(), args: z.array(z.string()).optional(), refreshIntervalMs: z.number().optional() }).strict(),
  ]) }).strict(),
]);

export interface NativeAuthenticationLaunch {
  readonly bindingId: string;
  readonly sourceId: string;
  readonly connectionId: string;
  readonly model?: string;
  readonly effort?: string;
  readonly capacityId?: string;
  readonly mode: NativeAuthenticationSource["mode"];
  check(): void;
  launch(argv: string[], env: Record<string, string | undefined>): { argv: string[]; env: Record<string, string | undefined> };
  release(): void;
}

export interface NativeAuthenticationProvider {
  bindingId(threadId: string, runtime: "claude" | "codex"): string;
  resolveBindingId?(threadId: string, runtime: "claude" | "codex"): Promise<string>;
  prepare(threadId: string, runtime: "claude" | "codex"): Promise<NativeAuthenticationLaunch>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

/** Foundry-owned launch configuration. No model calls, credential export or
 * background daemon. Native runtimes own native refresh; gateway helpers own
 * gateway-token renewal. Sources and selections contain references only. */
export class NativeAuthentication {
  private sources = new Map<string, Readonly<NativeAuthenticationSource>>();
  private selections = new Map<string, string>();
  private revoked = new Set<string>();
  /** `shared`: concurrent holders of a native profile (bounded decision processes on one login). They
   * exclude, and are excluded by, the exclusive lock that a warm worker holds. */
  constructor(private options: { directory: string; sources: NativeAuthenticationSource[]; defaultSourceId?: string; shared?: boolean }) {
    this.options = { ...options };
    if (!isAbsolute(options.directory)) throw Error("Authentication directory must be absolute");
    const parsed = z.array(sourceSchema).safeParse(options.sources);
    if (!parsed.success) throw Error("Invalid native authentication configuration; only credential references are allowed");
    for (const source of parsed.data) {
      if (!uuid.test(source.id) || !uuid.test(source.connectionId) || !["claude", "codex"].includes(source.runtime)) throw Error("Invalid native authentication identity");
      if (this.sources.has(source.id)) throw Error("Duplicate authentication source");
      if (source.mode === "native-profile") {
        if (!isAbsolute(source.profileDirectory)) throw Error("Native profile directory must be absolute");
      } else if (source.mode === "gateway") {
        let url: URL;
        try { url = new URL(source.baseUrl); } catch { throw Error("Invalid gateway endpoint"); }
        if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw Error("Gateway requires HTTPS or loopback HTTP without URL credentials");
        if (source.credential.type === "environment") {
          if (!/^[A-Z_][A-Z0-9_]*$/.test(source.credential.variable)) throw Error("Invalid credential environment reference");
        } else if (source.credential.type === "command") {
          if (!isAbsolute(source.credential.command) || [source.credential.command, ...(source.credential.args ?? [])].some(v => typeof v !== "string" || /[\r\n\0]/.test(v))) throw Error("Invalid credential helper");
          const interval = source.credential.refreshIntervalMs ?? 300000;
          if (!Number.isSafeInteger(interval) || interval < 0) throw Error("Invalid credential refresh interval");
        } else throw Error("Unsupported credential delivery");
      } else throw Error("Unsupported native authentication mode");
      this.sources.set(source.id, Object.freeze(source));
    }
    if (options.defaultSourceId && !this.sources.has(options.defaultSourceId)) throw Error("Unknown default authentication source");
  }
  select(threadId: string, sourceId: string): void {
    if (!this.sources.has(sourceId)) throw Error("Unknown authentication source");
    this.selections.set(threadId, sourceId);
  }
  /** Stops new launches and sends; upstream revocation remains provider-specific. */
  revoke(sourceId: string): void { this.revoked.add(sourceId); }
  private source(threadId: string, runtime: "claude" | "codex") {
    const id = this.selections.get(threadId) ?? this.options.defaultSourceId;
    const source = id && this.sources.get(id);
    if (!source || source.runtime !== runtime || this.revoked.has(source.id)) throw Error("Native authentication source unavailable");
    return source;
  }
  bindingId(threadId: string, runtime: "claude" | "codex"): string {
    const source = this.source(threadId, runtime);
    return `${threadId}:auth:${source.id}:${hash(JSON.stringify(source))}`;
  }
  async prepare(threadId: string, runtime: "claude" | "codex"): Promise<NativeAuthenticationLaunch> {
    const source = this.source(threadId, runtime);
    if (source.mode === "native-profile" && threadId.includes(":aux:")) throw Error("Auxiliary sessions require a gateway source or a separate decision provider; native profiles have one refresh owner");
    const bindingId = this.bindingId(threadId, runtime);
    if (source.mode === "native-profile") assertProfile(source.profileDirectory, runtime);
    const directory = source.mode === "native-profile" ? await realpath(source.profileDirectory)
      : join(this.options.directory, source.id, hash(bindingId));
    const ownerId = crypto.randomUUID();
    const shared = source.mode === "native-profile" && this.options.shared === true;
    const sharedLocks = join(directory, ".foundry-auth-shared");
    let active = false;
    let released = false;
    const check = () => {
      if (released || this.bindingId(threadId, runtime) !== bindingId) throw Error("Native authentication binding changed or was released");
    };
    const files: Array<[string, string]> = [];
    if (source.mode === "gateway") {
      // Isolated user-level configuration; no upstream secrets are written.
      if (runtime === "codex") {
        let config = `web_search = "disabled"\ncli_auth_credentials_store = "ephemeral"\nmodel_provider = "foundry_gateway"\n[model_providers.foundry_gateway]\nname = "Foundry gateway"\nbase_url = ${JSON.stringify(source.baseUrl)}\nwire_api = "responses"\n`;
        if (source.credential.type === "environment") config += 'env_key = "FOUNDRY_GATEWAY_TOKEN"\n';
        else config += `[model_providers.foundry_gateway.auth]\ncommand = ${JSON.stringify(source.credential.command)}\nargs = ${JSON.stringify(source.credential.args ?? [])}\nrefresh_interval_ms = ${source.credential.refreshIntervalMs ?? 300000}\n`;
        files.push([join(directory, "config.toml"), config]);
      } else {
        const helper = source.credential.type === "command" ? [source.credential.command, ...(source.credential.args ?? [])].map(quote).join(" ") : undefined;
        files.push([join(directory, "settings.json"), JSON.stringify({ ...(helper ? { apiKeyHelper: helper } : {}) })]);
      }
    }
    return Object.freeze({ bindingId, sourceId: source.id, connectionId: source.connectionId, mode: source.mode,
      check,
      launch: (argv: string[], inherited: Record<string, string | undefined>) => {
        check();
        if (active) throw Error("Authentication launch already owns a process");
        const lock = join(directory, ".foundry-auth-lock");
        const env = { ...inherited };
        // Clear competing credential, endpoint and profile overrides on the child only.
        for (const key of Object.keys(env)) if (/^(ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|FOUNDRY_GATEWAY_TOKEN$)/.test(key)) delete env[key];
        for (const configured of this.sources.values()) if (configured.mode === "gateway" && configured.credential.type === "environment") delete env[configured.credential.variable];
        // A default login location is selected by leaving the override unset.
        Object.assign(env, source.mode === "native-profile" ? profileEnvironment(runtime, directory)
          : { [runtime === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]: directory });
        if (source.mode === "gateway") {
          if (source.credential.type === "environment") {
            const token = process.env[source.credential.variable];
            if (!token || /[\r\n\0]/.test(token)) throw Error("Gateway credential unavailable");
            delete env[source.credential.variable];
            env[runtime === "codex" ? "FOUNDRY_GATEWAY_TOKEN" : "ANTHROPIC_AUTH_TOKEN"] = token;
          }
          if (runtime === "claude") {
            env.ANTHROPIC_BASE_URL = source.baseUrl;
            env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
            if (source.credential.type === "command") env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS = String(source.credential.refreshIntervalMs ?? 300000);
          }
        }
        const launchArgs = [...argv];
        if (source.mode === "gateway" && runtime === "claude") {
          if (argv.some(arg => ["--settings", "--setting-sources", "--bare"].includes(arg) || arg.startsWith("--settings=") || arg.startsWith("--setting-sources="))) throw Error("Conflicting gateway authentication settings");
          launchArgs.push("--setting-sources", "user");
        }
        if (runtime === "codex") {
          for (let index = 1; index < argv.length; index++) {
            const arg = argv[index]!;
            if (/^(?:--profile(?:=|$)|--oss(?:=|$)|--local-provider(?:=|$)|-p)/.test(arg)) throw Error("Conflicting native authentication settings");
            const override = arg === "-c" || arg === "--config" ? argv[++index]
              : arg.startsWith("--config=") ? arg.slice(9) : arg.startsWith("-c") ? arg.slice(2).replace(/^=/, "") : undefined;
            // Only launch controls are accepted here. A denylist of provider keys
            // can be bypassed by TOML quoting, dotted keys or new auth settings.
            if (override !== undefined && !/^(sandbox_mode|approval_policy|model_reasoning_effort)\s*=/.test(override)
              && !/^web_search\s*=\s*"disabled"$/.test(override)) throw Error("Conflicting native authentication settings");
            if ((arg === "-c" || arg === "--config") && override === undefined) throw Error("Missing native configuration override");
          }
        }
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (source.mode === "native-profile") assertProfile(directory, runtime); else assertPrivateProfile(directory);
        const owner = JSON.stringify({ id: ownerId, pid: process.pid, sourceId: source.id, threadId });
        if (shared) {
          // Register first, then check the exclusive lock: either side always observes the other.
          for (let attempt = 0; ; attempt++) {
            mkdirSync(sharedLocks, { recursive: true, mode: 0o700 });
            // A last holder may remove an empty registry between these two steps.
            try { writeFileSync(join(sharedLocks, `${ownerId}.json`), owner, { flag: "wx", mode: 0o600 }); break; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt >= 2) throw error; }
          }
          if (existsSync(lock)) { unlinkSync(join(sharedLocks, `${ownerId}.json`)); throw Error("Native profile is in use or unavailable; release its owner before reuse"); }
        } else {
          try { mkdirSync(lock, { mode: 0o700 }); } catch { throw Error("Native profile is in use or unavailable; release its owner before reuse"); }
          if (readdirSafe(sharedLocks).length) { rmdirSync(lock); throw Error("Native profile is in use or unavailable; release its owner before reuse"); }
          try {
            for (const [path, contents] of files) writeProfileConfiguration(directory, path, contents);
            writeFileSync(join(lock, "owner.json"), owner, { mode: 0o600 });
          } catch { try { unlinkSync(join(lock, "owner.json")); } catch {} rmdirSync(lock); throw Error("Could not write native authentication configuration"); }
        }
        active = true;
        return { argv: launchArgs, env };
      },
      release: () => {
        released = true;
        if (active) {
          const lock = shared ? join(sharedLocks, `${ownerId}.json`) : join(directory, ".foundry-auth-lock", "owner.json");
          const owner = JSON.parse(readFileSync(lock, "utf8"));
          if (owner.id !== ownerId) throw Error("Authentication lock ownership changed; cleanup refused");
          unlinkSync(lock);
          if (!shared) rmdirSync(join(directory, ".foundry-auth-lock"));
          // Remove the shared registry when this was the last holder; a concurrent registration keeps it.
          else try { rmdirSync(sharedLocks); } catch { /* Not empty or already removed. */ }
          active = false;
        }
      },
    });
  }
}

function readdirSafe(directory: string): string[] {
  try { return readdirSync(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
