import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { freezeEvidence, sameNativeOwner, type CompletionOpts, type CompletionResult, type LLMProvider, type NativeEvidence, type NativeOwner, type TokenCounts } from "@inixiative/foundry-core";
import { NativeAuthentication, type NativeAuthenticationSource } from "./native-authentication";
import { assertPrivateProfile, assertProfile } from "./private-profile";
import { withProfile } from "./default-profiles";
import { ClaudeCodeSessionAdapter, FileExternalSessionStore, type ClaudeCodeSessionAdapterConfig } from "./session-adapter";
import { nativeTextEnvironment } from "./native-text-environment";
import { SessionBackedProvider } from "./session-backed";

type Spawn = NonNullable<NonNullable<ClaudeCodeSessionAdapterConfig["defaults"]>["spawn"]>;
type Child = ReturnType<Spawn>;
export type StatusProcess = Pick<Child, "stdout" | "stderr" | "exited" | "kill">;
export interface NativeTextConfig {
  source: Extract<NativeAuthenticationSource, { mode: "native-profile" }>;
  /** Existing private parent; a new run directory is created exclusively below it. */
  directory: string;
  runId: string;
  model: string;
  /** Canonical model acknowledgement, if the requested name is an alias. */
  expectedObservedModel?: string;
  maxCalls?: number;
  callTimeoutMs?: number;
}
export interface NativeTextCall {
  id: string;
  owner: NativeOwner;
  inputHash: string;
  startedAt: number;
  finishedAt?: number;
  admission?: NativeEvidence;
  terminal?: NativeEvidence;
  release: "not-requested" | "released" | "unknown" | "unavailable";
  processExit: "not-started" | "pending" | "exited";
  statusProcessExit: "not-started" | "pending" | "exited";
  deadline: boolean;
  valid: boolean;
  /** Numeric counters only; the raw provider usage object is not retained here. */
  usage?: Omit<TokenCounts, "providerUsage">;
  /** not-admitted: refused before any native launch, so nothing remains owned. */
  failure?: "provider-or-evidence" | "deadline" | "not-admitted" | "rate-limited";
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
// Keep ownership/settlement facts, never prompts, model text, tool arguments or raw protocol.
const evidence = (e: NativeEvidence): NativeEvidence => freezeEvidence({
  schema: 1, owner: e.owner, admissionId: e.admissionId, nativeSessionId: e.nativeSessionId,
  externalSessionId: e.externalSessionId, threadId: e.threadId, turnId: e.turnId,
  nativeOutcome: e.nativeOutcome, localOutcome: e.localOutcome, dispatch: e.dispatch,
  transportOutcome: e.transportOutcome, rpcOutcome: e.rpcOutcome,
  terminal: e.terminal && { type: e.terminal.type, turnId: e.terminal.turnId, subtype: e.terminal.subtype },
  observationFailures: e.observationFailures, configuration: e.configuration,
});

/** Bounded shared subscription provider; no scheduler, CLI or automatic model calls. */
export function createNativeTextProvider(config: NativeTextConfig) {
  return buildNativeTextProvider(config);
}

/** Test transport seam. Production callers use createNativeTextProvider. */
export function buildNativeTextProvider(config: NativeTextConfig, controlled?: {
  spawn: Spawn;
  statusSpawn: (profileDirectory: string) => StatusProcess;
}) {
  config = structuredClone(config);
  const source = config.source;
  const maxCalls = config.maxCalls ?? 2, timeout = config.callTimeoutMs ?? 15_000;
  if (source.runtime !== "claude" || source.mode !== "native-profile") throw Error("Only an explicit Claude native profile supports this text-only pilot; Codex and API fallback are refused");
  if (!uuid.test(config.runId) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(config.model)
    || (config.expectedObservedModel !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(config.expectedObservedModel)) || !isAbsolute(config.directory)
    || !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 4
    || !Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30_000) throw Error("Invalid bounded native text configuration");
  assertPrivateProfile(config.directory);
  assertProfile(source.profileDirectory, source.runtime);
  const directory = join(config.directory, config.runId);
  const auth = new NativeAuthentication({ directory, sources: [source], defaultSourceId: source.id });
  mkdirSync(directory, { mode: 0o700 }); // Existing runs cannot be replayed after restart.
  const cwd = join(directory, "fixture"); mkdirSync(cwd, { mode: 0o700 });
  const reportPath = join(directory, "native-text.json");
  const calls: NativeTextCall[] = [];
  let busy = false, closed = false;
  const persist = () => {
    try {
      writeFileSync(`${reportPath}.tmp`, JSON.stringify({ schema: 1, runId: config.runId,
        mode: controlled ? "controlled-transport" : "native-subscription",
        sourceId: source.id, connectionId: source.connectionId, model: config.model, expectedObservedModel: config.expectedObservedModel ?? config.model,
        maxCalls, callTimeoutMs: timeout, closed, calls }, null, 2), { mode: 0o600 });
      renameSync(`${reportPath}.tmp`, reportPath);
    } catch (error) { closed = true; throw error; }
  };
  persist();
  const provider: LLMProvider = {
    id: "native-text-claude",
    async complete(messages, opts: CompletionOpts = {}) {
      if (closed || busy || calls.length >= maxCalls) throw Error("Native text admission closed or occupied; no retry or queue");
      if ((opts.model && opts.model !== config.model) || opts.tools === true || opts.toolDefinitions?.length
        || opts.nativeObservation?.bridge || (opts.cwd && opts.cwd !== cwd)
        || (opts.maxTurns !== undefined && opts.maxTurns !== 1)
        || (opts.timeout !== undefined && (!Number.isSafeInteger(opts.timeout) || opts.timeout < 100 || opts.timeout > timeout)))
        throw Error("Native text scope or model override refused");
      if (JSON.stringify(messages).length > 100_000) throw Error("Native text input cap exceeded");
      busy = true;
      const id = crypto.randomUUID(), threadId = `native-text:${config.runId}:${id}`;
      const owner = freezeEvidence({ ...(opts.nativeObservation?.owner ?? {
        threadId, projectId: config.runId, generation: config.runId, messageId: id, dispatchId: id,
      }), providerSessionKey: threadId });
      const call: NativeTextCall = { id, owner, inputHash: hash(JSON.stringify(messages)), startedAt: Date.now(),
        release: "not-requested", processExit: "not-started", statusProcessExit: "not-started", deadline: false, valid: false };
      calls.push(call);
      let child: Child | undefined, statusChild: StatusProcess | undefined, badObservation = false;
      let result: CompletionResult | undefined;
      const stop = () => { for (const proc of [child, statusChild]) { try { proc?.kill(); } catch { closed = true; } } };
      let deadlineReject!: (error: Error) => void;
      const deadline = new Promise<never>((_, reject) => { deadlineReject = reject; });
      const timer = setTimeout(() => {
        call.deadline = true; closed = true; stop(); deadlineReject(Error("Native text deadline; no further admissions"));
      }, opts.timeout ?? timeout);
      const adapter = new ClaudeCodeSessionAdapter({ authentication: auth,
        store: new FileExternalSessionStore(join(directory, `${id}.bindings.json`)),
        defaults: { spawn: (argv, options) => {
          if (child || call.deadline || closed) throw Error("Native process admission refused");
          const isolated = { ...options, env: nativeTextEnvironment(options.env) };
          child = controlled ? controlled.spawn(argv, isolated) : Bun.spawn(argv, { ...isolated, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
          call.processExit = "pending";
          void child.exited.then(() => { call.processExit = "exited"; }, () => { closed = true; });
          return child;
        } },
      });
      const native = new SessionBackedProvider({ id: provider.id, adapter, defaultCwd: cwd, defaultModel: config.model });
      const owned = (e: NativeEvidence) => sameNativeOwner(e.owner, owner)
        && !!call.admission?.admissionId && e.admissionId === call.admission.admissionId;
      try {
        persist();
        statusChild = controlled ? controlled.statusSpawn(source.profileDirectory) : Bun.spawn(["claude", "auth", "status", "--json"], {
          env: withProfile(nativeTextEnvironment(process.env), "claude", source.profileDirectory),
          stdin: "ignore", stdout: "pipe", stderr: "pipe",
        });
        call.statusProcessExit = "pending";
        void statusChild.exited.then(() => { call.statusProcessExit = "exited"; }, () => { closed = true; });
        const subscribed = await Promise.race([deadline, subscriptionStatus(statusChild)]);
        if (!subscribed || closed) throw Error("Authenticated native subscription required");
        result = await Promise.race([deadline, native.complete(messages, { ...opts, model: config.model,
          cwd, threadId, tools: false, maxTurns: 1, timeout: opts.timeout ?? timeout,
          nativeObservation: {
            owner,
            preflight: async () => { if (closed) throw Error("Native text admission closed"); await opts.nativeObservation?.preflight?.(owner); },
            register: async e => {
              if (closed || call.admission || !e.admissionId || !sameNativeOwner(e.owner, owner)) throw Error("Native admission ownership mismatch");
              call.admission = evidence(e); persist();
              await opts.nativeObservation?.register(e);
              if (closed) throw Error("Native admission deadline");
            },
            observe: e => {
              if (!owned(e) || e.kind === "tool_use" || e.kind === "tool_result" || e.observationFailures) {
                badObservation = true; closed = true; stop();
              }
              call.terminal = evidence(e); persist();
              return opts.nativeObservation?.observe(e);
            },
          },
        })]);
        const terminal = result.native;
        if (!terminal || !owned(terminal) || !terminal.terminal || terminal.nativeOutcome !== "completed"
          || terminal.localOutcome !== "resolved" || terminal.transportOutcome !== "open" || terminal.observationFailures
          || badObservation || call.deadline || terminal.configuration?.turnBudgetEnforcement !== "launch-option"
          || terminal.configuration?.requestedMaxTurns !== 1
          || terminal.configuration.observedModel !== (config.expectedObservedModel ?? config.model)) throw Error("Native text completion is not proven");
        call.terminal = evidence(terminal);
        if (result.tokens) { const { providerUsage: _providerUsage, ...usage } = result.tokens; call.usage = usage; }
        const inspection = await native.completionLifecycle.inspectOwnedAdmission!(owner, terminal.admissionId!);
        if (inspection?.capacity !== "settled" || inspection.call !== "settled" || !owned(inspection.evidence)) throw Error("Native text capacity remains unknown");
        call.release = await Promise.race([deadline, native.completionLifecycle.releaseOwnedAdmission!(owner, terminal.admissionId!)]);
        if (call.release !== "released" || call.processExit !== "exited" || call.deadline) throw Error("Native text process release is not proven");
        call.valid = true;
      } catch {
        closed = true;
        call.failure = call.deadline ? "deadline" : "provider-or-evidence";
        if (call.admission) {
          const inspection = await native.completionLifecycle.inspectOwnedAdmission!(owner, call.admission.admissionId!).catch(() => undefined);
          if (inspection && owned(inspection.evidence)) call.terminal = evidence(inspection.evidence);
        }
      } finally {
        stop();
        const exits = [child, statusChild].filter((proc): proc is Child | StatusProcess => proc !== undefined);
        if (exits.length) {
          let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([Promise.all(exits.map(proc => proc.exited.catch(() => {}))),
            new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 2_000); })]);
          clearTimeout(cleanupTimer);
        }
        if (call.processExit === "pending" || call.statusProcessExit === "pending") {
          call.valid = false; closed = true; call.failure ??= "provider-or-evidence";
        }
        clearTimeout(timer);
        call.finishedAt = Date.now();
        if (!call.valid && call.release === "not-requested") call.release = "unknown";
        busy = false;
        persist();
      }
      if (!call.valid || !result) throw Object.assign(Error("Native text call failed; inspect retained ownership and release evidence"), { evidencePath: reportPath, callId: id });
      return result;
    },
  };
  return { provider, reportPath, snapshot: () => freezeEvidence({ closed, calls }),
    close: () => { closed = true; persist(); } };
}

/** Supported read-only status command. Never persist raw output or account identity. */
export async function subscriptionStatus(proc: StatusProcess): Promise<boolean> {
  try {
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if (code !== 0) return false;
    const status = JSON.parse(stdout);
    return status.loggedIn === true && status.authMethod === "claude.ai";
  } catch { return false; }
}
