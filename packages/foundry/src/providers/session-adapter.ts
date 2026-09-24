import type { NativeAuthenticationProvider, NativeAuthenticationLaunch } from "./native-authentication";
// ---------------------------------------------------------------------------
// SessionAdapter — mapping between Foundry threads and external session IDs
// ---------------------------------------------------------------------------
//
// A HarnessSession's `externalSessionId` is the runtime's native ID (e.g. the
// UUID in ~/.claude/projects/<id>.jsonl). A SessionAdapter maps between
// Foundry's internal thread ID and this external ID.
//
// Two concerns:
//
// 1. ExternalSessionStore — persists the mapping so it survives Foundry
//    process restarts. Without this, crash recovery is impossible because
//    the runtime's native session would be abandoned.
//
// 2. SessionAdapter — creates (or resumes) a HarnessSession for a Foundry
//    thread. On first call for a thread, the session starts fresh and its
//    native ID is captured + persisted. On subsequent calls (e.g. after
//    Foundry restarts), the adapter loads the native ID from the store and
//    constructs a session that resumes (via --resume) rather than starts
//    a new one.
// ---------------------------------------------------------------------------

import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { newId, type SignalBus, type NativeBridgeLease } from "@inixiative/foundry-core";
import { withNativeBridge, appServerBridgeConfiguration } from "./native-launch";
import {
  ClaudeCodeSession,
  CodexSession,
  CodexAppServerSession,
  type HarnessSession,
  type SessionEvent,
  type ClaudeCodeSessionConfig,
  type CodexSessionConfig,
} from "@inixiative/agent-session";

// ---------------------------------------------------------------------------
// ExternalSessionStore — persists (threadId, runtime) → externalSessionId
// ---------------------------------------------------------------------------

export interface ExternalSessionStore {
  /** Load the external session ID for a thread on a given runtime. */
  load(threadId: string, runtime: string): Promise<string | null>;
  /** Persist the external session ID. Overwrites any existing mapping. */
  save(threadId: string, runtime: string, externalSessionId: string): Promise<void>;
  /** Remove the mapping (e.g. on thread archive). */
  clear(threadId: string, runtime: string): Promise<void>;
  /** List all mappings (for diagnostics / viewer). */
  all(): Promise<Array<{ threadId: string; runtime: string; externalSessionId: string }>>;
}

// ---------------------------------------------------------------------------
// InMemoryExternalSessionStore — for tests and ephemeral usage
// ---------------------------------------------------------------------------

export class InMemoryExternalSessionStore implements ExternalSessionStore {
  private _map = new Map<string, string>();

  private _key(threadId: string, runtime: string): string {
    return `${runtime}:${threadId}`;
  }

  async load(threadId: string, runtime: string): Promise<string | null> {
    return this._map.get(this._key(threadId, runtime)) ?? null;
  }

  async save(threadId: string, runtime: string, id: string): Promise<void> {
    this._map.set(this._key(threadId, runtime), id);
  }

  async clear(threadId: string, runtime: string): Promise<void> {
    this._map.delete(this._key(threadId, runtime));
  }

  async all(): Promise<Array<{ threadId: string; runtime: string; externalSessionId: string }>> {
    const out: Array<{ threadId: string; runtime: string; externalSessionId: string }> = [];
    for (const [key, id] of this._map) {
      const idx = key.indexOf(":");
      out.push({
        runtime: key.slice(0, idx),
        threadId: key.slice(idx + 1),
        externalSessionId: id,
      });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// FileExternalSessionStore — JSON file, survives Foundry restarts
// ---------------------------------------------------------------------------
//
// Format: { [runtime]: { [threadId]: externalSessionId } }
//
// Writes are atomic (temp file + rename) so a crash mid-write doesn't
// corrupt the store. This is the default store for production use —
// it's the critical piece for crash recovery.
// ---------------------------------------------------------------------------

type FileStoreData = Record<string, Record<string, string>>;

export class FileExternalSessionStore implements ExternalSessionStore {
  private _path: string;
  private _cache: FileStoreData | null = null;
  private _writeLock: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this._path = path;
  }

  /** Default path: `<projectRoot>/.foundry/sessions.json`. */
  static forProject(projectRoot: string): FileExternalSessionStore {
    return new FileExternalSessionStore(
      join(projectRoot, ".foundry", "sessions.json"),
    );
  }

  private async _read(): Promise<FileStoreData> {
    if (this._cache) return this._cache;
    try {
      const raw = await readFile(this._path, "utf-8");
      this._cache = JSON.parse(raw) as FileStoreData;
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") {
        this._cache = {};
      } else {
        throw err;
      }
    }
    return this._cache!;
  }

  /**
   * Serialize mutations end-to-end. The mutator runs inside the lock and
   * receives the freshest cache, so concurrent save/clear calls compose
   * correctly instead of all racing against the same stale snapshot.
   */
  private async _mutate(fn: (data: FileStoreData) => FileStoreData | null): Promise<void> {
    const prev = this._writeLock;
    let release!: () => void;
    this._writeLock = new Promise<void>((r) => { release = r; });
    try {
      await prev;
      const current = await this._read();
      const next = fn(current);
      if (next === null) return; // no-op (e.g. clear on missing key)
      await mkdir(dirname(this._path), { recursive: true });
      const tmp = `${this._path}.tmp.${process.pid}.${Date.now()}`;
      await writeFile(tmp, JSON.stringify(next, null, 2), "utf-8");
      await rename(tmp, this._path);
      this._cache = next;
    } finally {
      release();
    }
  }

  async load(threadId: string, runtime: string): Promise<string | null> {
    const data = await this._read();
    return data[runtime]?.[threadId] ?? null;
  }

  async save(threadId: string, runtime: string, id: string): Promise<void> {
    await this._mutate((data) => ({
      ...data,
      [runtime]: { ...(data[runtime] ?? {}), [threadId]: id },
    }));
  }

  async clear(threadId: string, runtime: string): Promise<void> {
    await this._mutate((data) => {
      if (!data[runtime] || !(threadId in data[runtime])) return null;
      const bucket = { ...data[runtime] };
      delete bucket[threadId];
      const next: FileStoreData = { ...data, [runtime]: bucket };
      if (Object.keys(bucket).length === 0) delete next[runtime];
      return next;
    });
  }

  async all(): Promise<Array<{ threadId: string; runtime: string; externalSessionId: string }>> {
    const data = await this._read();
    const out: Array<{ threadId: string; runtime: string; externalSessionId: string }> = [];
    for (const [runtime, bucket] of Object.entries(data)) {
      for (const [threadId, externalSessionId] of Object.entries(bucket)) {
        out.push({ runtime, threadId, externalSessionId });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// SessionAdapter — per-runtime factory for HarnessSessions with ID mapping
// ---------------------------------------------------------------------------

export interface CreateSessionOpts {
  /** Already-owned process grant; never supplied to auxiliary sessions. */
  nativeBridge?: NativeBridgeLease;
  /** Foundry's internal thread ID. */
  threadId: string;
  /** Working directory for the session. */
  cwd: string;
  /** Stable base context injected at process startup. */
  baseContext?: string;
  /** False requires a native text-only session with no callable tools. */
  tools?: boolean;
  /** Native agentic turn bound, when supported by the adapter. */
  maxTurns?: number | null;
  /**
   * Effective requested model for this native session. Adapters pass it to the
   * engine (Claude `--model` argv, Codex first `codex` call `model` parameter);
   * absent means the adapter's configured default. This is requested
   * configuration, not native acknowledgment of the model that actually ran.
   */
  model?: string;
}

/**
 * What a native session was actually constructed with. Adapters record it per
 * session at construction and expose it through `describeConstruction`. Callers
 * derive resume provenance from this, never from a separate lookup, because the
 * key an adapter consults (for example the text-only auxiliary profile) can differ
 * from the thread id and the store can change between two reads.
 */
export interface ConstructionBinding {
  readonly authentication?: Readonly<{ sourceId: string; connectionId: string; mode: string; model?: string; effort?: string; capacityId?: string }>;
  readonly engine?: "mcp" | "app-server";
  readonly requestedEffort?: string;
  /** Store key the adapter consulted for this session. */
  readonly bindingId: string;
  /** Persisted native session id passed to the engine, or null for a fresh session. */
  readonly resumedBinding: string | null;
}

export interface SessionAdapter {
  /** Recheck the owned source before every send; never silently rebind a warm process. */
  checkAuthentication?(session: HarnessSession): void;
  readonly runtime: string;

  /** Bind native lifecycle events to a thread; returned disposer releases ownership. */
  bindSignals?(threadId: string, signals: SignalBus): () => void;

  /**
   * Create (or resume) a HarnessSession for a Foundry thread. If the store
   * has a mapping for this thread+runtime, the session spawns with --resume
   * and continues the native session. Otherwise a fresh native session is
   * created on first turn; its ID is captured and persisted automatically.
   *
   * The returned session is UNSTARTED — caller must call session.start().
   */
  createSession(opts: CreateSessionOpts): Promise<HarnessSession>;

  /** Get the persisted external session ID for a thread (if any). Diagnostic; not construction truth. */
  getExternalSessionId(threadId: string): Promise<string | null>;

  /**
   * Authoritative construction binding of a session this adapter created, or
   * undefined when the adapter does not track it. Read before `start()`.
   */
  describeConstruction?(session: HarnessSession): ConstructionBinding | undefined;

  /**
   * Native configuration facts the adapter observed at the first reliable event
   * boundary for a session it created: frozen copies taken once per envelope,
   * independent of any event object later handed to callers or observers.
   * Each read returns a detached frozen array; later facts do not alter it.
   * Undefined when the adapter does not own evidence for that session.
   */
  observedConfiguration?(session: HarnessSession): readonly ConfigurationEvidence[] | undefined;
  /** Caller must establish idle native work first. Resolves released only after owned process exit. */
  releaseIdleSession?(session: HarnessSession): Promise<"released" | "unknown">;

  /** Remove the mapping (e.g. on thread archive). */
  clearSession(threadId: string): Promise<void>;
}

/** A supported native configuration envelope, copied once when first observed. */
export interface ConfigurationEvidence {
  readonly envelope: "system-init" | "session-configured" | "thread-configured";
  readonly effort?: string | null;
  readonly history?: Readonly<{ source: "thread/start" | "thread/resume"; available: boolean; hasMore: boolean; turns: readonly Readonly<{id:string;status:string}>[] }>;
  /** Native binding the envelope named (Claude session_id, Codex thread_id/session_id). */
  readonly binding: string;
  readonly model: string;
  readonly observedAt: number;
}

function configurationFact(raw: unknown): ConfigurationEvidence | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.model !== "string" || !r.model) return undefined;
  if (r.type === "system" && r.subtype === "init" && typeof r.session_id === "string") {
    return Object.freeze({ envelope: "system-init", binding: r.session_id, model: r.model, observedAt: Date.now() });
  }
  if (r.type === "session_configured") {
    const binding = typeof r.thread_id === "string" ? r.thread_id : typeof r.session_id === "string" ? r.session_id : undefined;
    if (binding) return Object.freeze({ envelope: "session-configured", binding, model: r.model, observedAt: Date.now() });
  }
  if (r.type === "thread-configured" && typeof r.threadId === "string" && r.status === "idle") {
    const h = r.history as Record<string,unknown> | undefined;
    const history = h && ["thread/start","thread/resume"].includes(String(h.source)) && typeof h.available === "boolean" && typeof h.hasMore === "boolean" && Array.isArray(h.turns)
      ? deepFreeze({source:h.source as "thread/start"|"thread/resume",available:h.available,hasMore:h.hasMore,turns:h.turns.flatMap(t=>t && typeof t.id === "string" && ["inProgress","completed","failed","interrupted"].includes(t.status)?[{id:t.id as string,status:t.status as string}]:[])}) : undefined;
    return Object.freeze({ envelope: "thread-configured", binding: r.threadId, model: r.model, observedAt: Date.now(),
      ...(history?{history}:{}),
      ...(r.reasoningEffort === null || (typeof r.reasoningEffort === "string" && ["minimal","low","medium","high","xhigh"].includes(r.reasoningEffort)) ? {effort:r.reasoningEffort as string|null} : {}) });
  }
  return undefined;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const nested of Object.values(value as object)) deepFreeze(nested, seen);
    Object.freeze(value);
  }
  return value;
}

/**
 * Evidence ownership for an engine that hands out its internal event objects.
 * 1. The adapter observes each event first and copies supported configuration
 *    facts once, so later mutation of any event object cannot rewrite them.
 * 2. Subscribers registered afterwards receive one detached frozen clone per
 *    event, shared between them, so an observer can neither corrupt the engine's
 *    parsing nor another observer's view.
 * 3. Results returned from send carry detached clones of this turn's events.
 * Nothing here copies accumulated history; each event is cloned at most once.
 */
function attachEvidenceOwnership(session: HarnessSession): readonly ConfigurationEvidence[] {
  const facts: ConfigurationEvidence[] = [];
  const detached = new WeakMap<object, SessionEvent>();
  const detach = (event: SessionEvent): SessionEvent => {
    const cached = detached.get(event);
    if (cached) return cached;
    const copy = deepFreeze(structuredClone(event));
    detached.set(event, copy);
    return copy;
  };
  const subscribe = session.onEvent.bind(session);
  subscribe((event) => { const fact = configurationFact(event.raw); if (fact) facts.push(fact); });
  session.onEvent = (handler) => subscribe((event) => handler(detach(event)));
  const send = session.send.bind(session);
  session.send = async (message, sendOpts) => {
    const result = await send(message, sendOpts);
    return { ...result, events: result.events.map(detach) };
  };
  return facts;
}

class ThreadSignalBindings {
  private bindings = new Map<string, { signals: SignalBus }>();
  private scoped = false;

  constructor(private fallback?: SignalBus) {}

  attachFallback(signals: SignalBus): void {
    this.fallback = signals;
  }

  bind(threadId: string, signals: SignalBus): () => void {
    this.scoped = true;
    const binding = { signals };
    this.bindings.set(threadId, binding);
    return () => {
      if (this.bindings.get(threadId) === binding) this.bindings.delete(threadId);
    };
  }

  get(threadId: string): SignalBus | undefined {
    // Once scoped routing is used, an unbound/disposed thread must never fall
    // back to main's legacy bus. Resolve at event time, including after resume.
    return this.scoped ? this.bindings.get(threadId)?.signals : this.fallback;
  }
}

function attachSessionIdPersistence(opts: {
  session: HarnessSession;
  store: ExternalSessionStore;
  runtime: string;
  threadId: string;
  existing?: string;
  logPrefix: string;
}): void {
  let lastPersisted = opts.existing;

  const persist = (id: string | undefined): void => {
    if (!id || id === lastPersisted) return;
    lastPersisted = id;
    void opts.store
      .save(opts.threadId, opts.runtime, id)
      .catch((err) => {
        console.warn(
          `[${opts.logPrefix}] failed to persist external session id:`,
          (err as Error).message,
        );
      });
  };

  opts.session.onEvent((event) => {
    persist(event.externalSessionId ?? opts.session.externalSessionId);
  });

  const originalSend = opts.session.send.bind(opts.session);
  opts.session.send = async (message, sendOpts) => {
    const result = await originalSend(message, sendOpts);
    persist(result.externalSessionId ?? opts.session.externalSessionId);
    return result;
  };
}

// ---------------------------------------------------------------------------
// ClaudeCodeSessionAdapter
// ---------------------------------------------------------------------------

export interface ClaudeCodeSessionAdapterConfig {
  authentication?: NativeAuthenticationProvider;
  /** Where to persist the (thread, external ID) mapping. */
  store: ExternalSessionStore;
  /** Defaults applied to every session. Merged per createSession(). */
  defaults?: Omit<ClaudeCodeSessionConfig, "cwd" | "baseContext" | "externalSessionId">;
  /**
   * Optional signal bus. When provided, the adapter bridges session-level
   * events into the signal bus so orchestration code (FlowOrchestrator,
   * Librarian) can react without knowing about HarnessSession internals.
   * Currently bridges: `session_compact` → `session_compacted`.
   */
  signals?: SignalBus;
}

export class ClaudeCodeSessionAdapter implements SessionAdapter {
  readonly runtime = "claude-code";
  private _store: ExternalSessionStore;
  private _authentication?: NativeAuthenticationProvider;
  private _authLaunches = new WeakMap<HarnessSession, NativeAuthenticationLaunch>();
  private _constructions = new WeakMap<HarnessSession, ConstructionBinding>();
  private _configurations = new WeakMap<HarnessSession, readonly ConfigurationEvidence[]>();
  private _ownedExits = new WeakMap<HarnessSession, () => Promise<number> | undefined>();
  private _ownedBridges = new WeakMap<HarnessSession, NativeBridgeLease>();
  private _defaults: ClaudeCodeSessionAdapterConfig["defaults"];
  private _signals: ThreadSignalBindings;

  constructor(config: ClaudeCodeSessionAdapterConfig) {
    this._store = config.store;
    this._authentication = config.authentication;
    this._defaults = config.defaults;
    this._signals = new ThreadSignalBindings(config.signals);
  }

  attachSignals(signals: SignalBus): void {
    this._signals.attachFallback(signals);
  }

  bindSignals(threadId: string, signals: SignalBus): () => void {
    return this._signals.bind(threadId, signals);
  }

  async createSession(opts: CreateSessionOpts): Promise<HarnessSession> {
    if (opts.nativeBridge) {
      if (opts.tools === false || opts.threadId.includes(":aux:") || opts.nativeBridge.owner.threadId !== opts.threadId) throw Error("Native bridge cannot be granted to this session");
      opts.nativeBridge.check();
    }
    // Preserve old auxiliary coding histories as evidence, but do not resume
    // them as decision middleware after changing the execution policy.
    const auth = await this._authentication?.prepare(opts.threadId, "claude");
    const sourceBinding = auth?.bindingId ?? opts.threadId;
    const bindingId = opts.tools === false && opts.threadId.includes(":aux:")
      ? `${sourceBinding}:profile:text-only-v1` : sourceBinding;
    const existing = await this._store.load(bindingId, this.runtime);

    // Use the substrate's supported spawn hook rather than modifying dependency
    // files. Safe mode retains subscription auth; bare mode does not.
    const defaultSpawn: NonNullable<ClaudeCodeSessionConfig["spawn"]> = this._defaults?.spawn
      ?? ((cmd, options) => Bun.spawn(cmd, { ...options, stdin: "pipe", stdout: "pipe", stderr: "pipe" }));
    const restrictedSpawn: NonNullable<ClaudeCodeSessionConfig["spawn"]> = (cmd, options) =>
      defaultSpawn([...cmd, "--safe-mode", "--tools", "", "--strict-mcp-config",
        "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--no-chrome"], options);
    let ownedExit: Promise<number> | undefined;
    const trackedSpawn: NonNullable<ClaudeCodeSessionConfig["spawn"]> = (cmd, options) => {
      const launch = auth?.launch(cmd, options.env);
      let child: ReturnType<typeof defaultSpawn>;
      try { child = (opts.tools === false ? restrictedSpawn : defaultSpawn)(opts.nativeBridge ? withNativeBridge(launch?.argv ?? cmd, "claude", opts.nativeBridge) : launch?.argv ?? cmd, { ...options, env: launch?.env ?? options.env }); }
      catch (error) { auth?.release(); throw error; }
      ownedExit = child.exited.then(code => { auth?.release(); return code; });
      void ownedExit.catch(() => {});
      if (opts.nativeBridge) void child.exited.then(() => opts.nativeBridge!.close()).catch(() => {});
      return child;
    };

    const session = new ClaudeCodeSession({
      ...this._defaults,
      ...(auth?.model ? { model: auth.model } : opts.model !== undefined ? { model: opts.model } : {}),
      ...(auth?.effort ? { effort: auth.effort } : {}),
      // The candidate accepts null as the native optional/unbounded setting.
      // Registry legacy types do not yet describe this additive representation.
      ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns as number } : {}),
      ...(opts.tools === false ? { permissionMode: "dontAsk" } : {}),
      spawn: trackedSpawn,
      cwd: opts.cwd,
      baseContext: opts.baseContext,
      externalSessionId: existing ?? undefined,
    });
    // Record the binding actually consumed: the auxiliary profile key may hold nothing
    // while the thread key still preserves legacy coding history that is NOT resumed.
    if (auth && (session as HarnessSession & { admissionProtocol?: string }).admissionProtocol !== "prewrite-v1") throw Error("Native authentication requires the prewrite-capable agent-session package");
    if (auth) this._authLaunches.set(session, auth);
    this._constructions.set(session, Object.freeze({ bindingId, resumedBinding: existing ?? null,
      ...(auth ? { authentication: { sourceId: auth.sourceId, connectionId: auth.connectionId, mode: auth.mode, model: auth.model, effort: auth.effort, capacityId: auth.capacityId } } : {}) }));
    this._ownedExits.set(session, () => ownedExit);
    if (opts.nativeBridge) this._ownedBridges.set(session, opts.nativeBridge);

    const runtime = this.runtime;
    const threadId = opts.threadId;
    attachSessionIdPersistence({
      session,
      store: this._store,
      runtime,
      threadId: bindingId,
      existing: existing ?? undefined,
      logPrefix: "ClaudeCodeSessionAdapter",
    });
    const originalSend = session.send.bind(session);
    session.send = (message, options) => {
      auth?.check();
      return originalSend(message, auth ? { ...options, onAdmission: async attempt => {
        auth.check(); await options?.onAdmission?.(attempt); auth.check();
      } } : options);
    };
    this._configurations.set(session, attachEvidenceOwnership(session));
    session.onEvent((event) => {
      // Bridge: compaction events → signal bus so FlowOrchestrator can
      // invalidate the Librarian's injection ledger and re-hydrate next turn.
      const signals = this._signals.get(threadId);
      if (signals && event.kind === "session_compact") {
        void signals.emit({
          id: newId("sig-compact"),
          kind: "session_compacted",
          source: `session-adapter:${runtime}`,
          content: {
            source: event.compactionSource ?? runtime,
            externalSessionId: event.externalSessionId,
            threadId,
          },
          timestamp: event.timestamp,
        });
      }
    });

    return session;
  }

  /**
   * Diagnostic lookup. For auxiliaries it reports the text-only profile binding
   * when present and otherwise the thread's preserved history; that history is
   * NOT what a text-only session resumes. Use describeConstruction for truth.
   */
  async getExternalSessionId(threadId: string): Promise<string | null> {
    const bindingId = await this._authentication?.resolveBindingId?.(threadId, "claude") ?? this._authentication?.bindingId(threadId, "claude") ?? threadId;
    if (threadId.includes(":aux:")) {
      const current = await this._store.load(`${bindingId}:profile:text-only-v1`, this.runtime);
      if (current) return current;
    }
    return this._store.load(bindingId, this.runtime);
  }

  checkAuthentication(session: HarnessSession): void { this._authLaunches.get(session)?.check(); }

  describeConstruction(session: HarnessSession): ConstructionBinding | undefined {
    return this._constructions.get(session);
  }

  observedConfiguration(session: HarnessSession): readonly ConfigurationEvidence[] | undefined {
    const facts = this._configurations.get(session);
    return facts === undefined ? undefined : Object.freeze([...facts]);
  }

  async releaseIdleSession(session: HarnessSession): Promise<"released" | "unknown"> {
    const exited = this._ownedExits.get(session)?.();
    if (!exited) return "unknown";
    session.kill();
    try {
      await exited;
      const bridge=this._ownedBridges.get(session);
      if(bridge){await bridge.close();const state=bridge.status?.();if(!state||state.pendingCleanups||state.cleanupFailures)return "unknown";}
      return "released";
    } catch { return "unknown"; }
  }

  async clearSession(threadId: string): Promise<void> {
    const bindingId = await this._authentication?.resolveBindingId?.(threadId, "claude") ?? this._authentication?.bindingId(threadId, "claude") ?? threadId;
    if (threadId.includes(":aux:")) await this._store.clear(`${bindingId}:profile:text-only-v1`, this.runtime);
    return this._store.clear(bindingId, this.runtime);
  }
}

// ---------------------------------------------------------------------------
// CodexSessionAdapter
// ---------------------------------------------------------------------------

export interface CodexSessionAdapterConfig {
  authentication?: NativeAuthenticationProvider;
  /** Deliberate isolated selection. Existing MCP bindings are never migrated. */
  engine?: "mcp" | "app-server";
  /** Explicit operator config only; copied once and never taken from disk. */
  appServerConfig?: Readonly<Record<string, unknown>>;
  /** Where to persist the (thread, external ID) mapping. */
  store: ExternalSessionStore;
  /** Defaults applied to every session. Merged per createSession(). */
  defaults?: Omit<CodexSessionConfig, "cwd" | "baseContext" | "externalSessionId">;
  /**
   * Optional signal bus. Mirrors ClaudeCodeSessionAdapter so lifecycle
   * consumers can treat native runtimes uniformly.
   */
  signals?: SignalBus;
}

export class CodexSessionAdapter implements SessionAdapter {
  readonly runtime: string;
  private readonly _engine: "mcp" | "app-server";
  private readonly _appConfig: Readonly<Record<string, unknown>>;
  private _store: ExternalSessionStore;
  private _authentication?: NativeAuthenticationProvider;
  private _authLaunches = new WeakMap<HarnessSession, NativeAuthenticationLaunch>();
  private _constructions = new WeakMap<HarnessSession, ConstructionBinding>();
  private _configurations = new WeakMap<HarnessSession, readonly ConfigurationEvidence[]>();
  private _ownedExits = new WeakMap<HarnessSession, () => Promise<number> | undefined>();
  private _ownedBridges = new WeakMap<HarnessSession, NativeBridgeLease>();
  private _defaults: CodexSessionAdapterConfig["defaults"];
  private _signals: ThreadSignalBindings;

  constructor(config: CodexSessionAdapterConfig) {
    if (config.engine !== undefined && !["mcp","app-server"].includes(config.engine)) throw Error("Unsupported Codex engine selection");
    this._engine = config.engine ?? "mcp";
    this.runtime = this._engine === "app-server" ? "codex-app-server" : "codex";
    this._appConfig = deepFreeze(structuredClone(config.appServerConfig ?? {}));
    if (config.authentication && Object.keys(this._appConfig).some(key => /^(model_provider|model_providers|openai_base_url|chatgpt_base_url|profile|profiles)(\.|$)/.test(key))) throw Error("App-server config conflicts with the authentication binding");
    this._store = config.store;
    this._authentication = config.authentication;
    this._defaults = config.defaults ? Object.freeze({...config.defaults}) : undefined;
    this._signals = new ThreadSignalBindings(config.signals);
  }

  attachSignals(signals: SignalBus): void {
    this._signals.attachFallback(signals);
  }

  bindSignals(threadId: string, signals: SignalBus): () => void {
    return this._signals.bind(threadId, signals);
  }

  async createSession(opts: CreateSessionOpts): Promise<HarnessSession> {
    if (opts.nativeBridge) {
      if (opts.tools === false || opts.threadId.includes(":aux:") || opts.nativeBridge.owner.threadId !== opts.threadId) throw Error("Native bridge cannot be granted to this session");
      opts.nativeBridge.check();
    }
    if (opts.tools === false) {
      throw new Error("Codex MCP adapter cannot enforce text-only sessions; use an explicitly configured decision provider until native policy support is implemented");
    }
    const auth = await this._authentication?.prepare(opts.threadId, "codex");
    const bindingId = auth?.bindingId ?? opts.threadId;
    const existing = await this._store.load(bindingId, this.runtime);

    let ownedExit: Promise<number> | undefined;
    const defaultSpawn: NonNullable<CodexSessionConfig["spawn"]> = this._defaults?.spawn
      ?? ((cmd, options) => Bun.spawn(cmd, { ...options, stdin:"pipe", stdout:"pipe", stderr:"pipe" }));
    const Session = this._engine === "app-server" ? CodexAppServerSession : CodexSession;
    const appServer = this._engine === "app-server" ? { requireConfiguration: true,
      onThreadReady: async (id:string) => { await this._store.save(bindingId,this.runtime,id); },
      config: opts.nativeBridge ? appServerBridgeConfiguration(opts.nativeBridge, this._appConfig) : this._appConfig,
      ...(opts.nativeBridge ? { requiredMcpServer: {name:opts.nativeBridge.name,tools:["foundry_query","foundry_memory"]} } : {}) } : undefined;
    let spawned = false;
    const session = new Session({
      ...this._defaults,
      ...(appServer ? { appServer } : {}),
      spawn: (cmd, options) => {
        if (this._engine === "app-server" && spawned) throw Error("New native process requires new owned adapter construction and preflight");
        opts.nativeBridge?.check();
        const launch = auth?.launch(cmd, options.env);
        let child: ReturnType<typeof defaultSpawn>;
        try { child = defaultSpawn(opts.nativeBridge && this._engine === "mcp" ? withNativeBridge(launch?.argv ?? cmd, "codex", opts.nativeBridge) : launch?.argv ?? cmd, { ...options, env: launch?.env ?? options.env }); }
        catch (error) { auth?.release(); throw error; }
        spawned = true;
        ownedExit = child.exited.then(code => { auth?.release(); return code; });
        void ownedExit.catch(() => {});
        if (opts.nativeBridge) void child.exited.then(() => opts.nativeBridge!.close()).catch(() => {});
        return child;
      },
      ...(auth?.model ? { model: auth.model } : opts.model !== undefined ? { model: opts.model } : {}),
      ...(auth?.effort ? { effort: auth.effort } : {}),
      cwd: opts.cwd,
      baseContext: opts.baseContext,
      externalSessionId: existing ?? undefined,
    });
    if (this._engine === "app-server" && (session as HarnessSession & {appServerProtocol?:string}).appServerProtocol !== "owned-thread-v1") throw Error("Installed native package lacks owned app-server integration; no process started");
    if (auth && (session as HarnessSession & { admissionProtocol?: string }).admissionProtocol !== "prewrite-v1") throw Error("Native authentication requires the prewrite-capable agent-session package");
    if (auth) this._authLaunches.set(session, auth);
    this._constructions.set(session, Object.freeze({ bindingId, resumedBinding: existing ?? null, engine:this._engine,
      ...(auth ? { authentication: { sourceId: auth.sourceId, connectionId: auth.connectionId, mode: auth.mode, model: auth.model, effort: auth.effort, capacityId: auth.capacityId } } : {}),
      ...((auth?.effort ?? this._defaults?.effort) ? {requestedEffort:auth?.effort ?? this._defaults?.effort} : {}) }));
    this._ownedExits.set(session, () => ownedExit);
    if (opts.nativeBridge) this._ownedBridges.set(session, opts.nativeBridge);

    const runtime = this.runtime;
    const threadId = opts.threadId;
    if (this._engine === "mcp") attachSessionIdPersistence({
      session,
      store: this._store,
      runtime,
      threadId: bindingId,
      existing: existing ?? undefined,
      logPrefix: "CodexSessionAdapter",
    });
    const originalSend = session.send.bind(session);
    session.send = (message, options) => {
      auth?.check();
      return originalSend(message, auth ? { ...options, onAdmission: async attempt => {
        auth.check(); await options?.onAdmission?.(attempt); auth.check();
      } } : options);
    };
    this._configurations.set(session, attachEvidenceOwnership(session));
    session.onEvent((event) => {
      const signals = this._signals.get(threadId);
      if (signals && event.kind === "session_compact") {
        void signals.emit({
          id: newId("sig-compact"),
          kind: "session_compacted",
          source: `session-adapter:${runtime}`,
          content: {
            source: event.compactionSource ?? runtime,
            externalSessionId: event.externalSessionId,
            threadId,
          },
          timestamp: event.timestamp,
        });
      }
    });

    return session;
  }

  async getExternalSessionId(threadId: string): Promise<string | null> {
    return this._store.load(await this._authentication?.resolveBindingId?.(threadId, "codex") ?? this._authentication?.bindingId(threadId, "codex") ?? threadId, this.runtime);
  }

  checkAuthentication(session: HarnessSession): void { this._authLaunches.get(session)?.check(); }

  describeConstruction(session: HarnessSession): ConstructionBinding | undefined {
    return this._constructions.get(session);
  }

  observedConfiguration(session: HarnessSession): readonly ConfigurationEvidence[] | undefined {
    const facts = this._configurations.get(session);
    return facts === undefined ? undefined : Object.freeze([...facts]);
  }

  async clearSession(threadId: string): Promise<void> {
    return this._store.clear(this._authentication?.bindingId(threadId, "codex") ?? threadId, this.runtime);
  }

  async releaseIdleSession(session: HarnessSession): Promise<"released" | "unknown"> {
    const exited = this._ownedExits.get(session)?.();
    if (!exited) return "unknown";
    session.kill();
    try {
      await exited;
      const bridge=this._ownedBridges.get(session);
      if(bridge){await bridge.close();const state=bridge.status?.();if(!state||state.pendingCleanups||state.cleanupFailures)return "unknown";}
      return "released";
    } catch { return "unknown"; }
  }
}
