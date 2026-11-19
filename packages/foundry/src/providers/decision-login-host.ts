/**
 * @atlas
 * @kind provider
 * @partOf primitive:decisions
 */
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  ClaudeCodeSession,
  DecisionError,
  type DecisionResult,
  IN_SESSION_HOST_CHARTER,
  type PrimedEvent,
  type PrimedSessions,
  type PrimeSpec,
} from '@inixiative/agent-session';
import { RUN_MARKER } from '@inixiative/archive/exemption';
import {
  type CompletionOpts,
  type CompletionResult,
  freezeEvidence,
  type LLMMessage,
  type LLMProvider,
  type NativeEvidence,
  sha256Hex,
} from '@inixiative/foundry-core';
import { stampFoundryRun } from '../archives/run-stamp';
import { CLAUDE_HARNESS_INSTRUCTIONS_OFF } from '../prompts/instruction-stack';
import { DECISION_CALL_TIMEOUT_MAX_MS, DECISION_INPUT_CAP } from './decision-budget';
import { type NativeProfileSource, profileEnvironment, withProfile } from './default-profiles';
import { NativeAuthentication, withoutCompetingCredentials } from './native-authentication';
import { nativeTextEnvironment } from './native-text-environment';
import {
  type NativeTextCall,
  type NativeTextConfig,
  type StatusProcess,
  subscriptionStatus,
} from './native-text-provider';
import {
  createPrimedPool,
  type DecisionProcess,
  heldOnlyFor,
  isWardenSession,
  primedRequest,
  projectHostTarget,
} from './primed-decisions';
import { assertPrivateDirectory, assertPrivateProfile, assertProfile } from './private-profile';
import type { ProjectWardenHosts } from './project-warden-hosts';
import {
  fetchLoginQuotaResetAt,
  type LoginQuotaPause,
  makeLoginQuotaPause,
} from './provider-limits';

const STATUS_DEADLINE_MS = 20_000;
/** Re-check the Claude login at most this often, like the subscription worker. */
const STATUS_TTL_MS = 5 * 60_000;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = sha256Hex;

/**
 * Where decision hosts run their sessions, `~/.foundry/hosts` (`FOUNDRY_HOSTS_DIR` moves it): outside
 * every git work tree, because Claude Code runs its git context commands (status, log, rev-parse,
 * config) at each session and subagent start; under `.foundry/decision-receipts` a project host ran
 * them against Foundry's checkout for every Warden it started (152 git processes at once, 2026-11-19).
 */
export const decisionHostsDirectory = (
  environment: Record<string, string | undefined> = process.env,
) => resolve(environment.FOUNDRY_HOSTS_DIR ?? join(homedir(), '.foundry', 'hosts'));

export interface DecisionLoginHostConfig {
  source: NativeProfileSource;
  /** Existing private receipt parent; this host writes below it. */
  directory: string;
  model: string;
  /** Claude: the model id the CLI must report serving. Default: `model`. */
  expectedObservedModel?: string;
  effort?: string;
  /** Codex: hedge a decision still running after this long on a second branch; the first to finish wins. */
  hedgeAfterMs?: number;
  /** Concurrent decisions: turns on the warm Codex process, or Claude CLI processes. */
  maxConcurrent: number;
  /**
   * Primed pool, Claude: keys kept warm (least recently used beyond it is evicted and re-primes cold,
   * ~5-8 s). Size it for every decision role: a Warden roster needs one advice and one review key per Warden.
   */
  primedSessions?: number;
  callTimeoutMs: number;
  /** Characters a decision's serialized messages may take. Default DECISION_INPUT_CAP; raised only by offline evals. */
  inputCap?: number;
  /** Test seam: launcher used after credential registration, in place of Bun.spawn. */
  spawn?: (
    argv: string[],
    options: { cwd: string; env: Record<string, string | undefined> },
  ) => DecisionProcess;
  /** Test seam: Claude subscription status check, in place of `claude auth status --json`. */
  statusSpawn?: (env: Record<string, string | undefined>) => StatusProcess;
  onEvent?: (event: PrimedEvent) => void;
  /**
   * Project Warden hosts (Claude decisions by default): every Warden of a project held in one Claude
   * Code process this host launches on the decision login. Its Wardens' calls go there while it
   * serves and are refused unsent otherwise (`projectHostTarget`). With them this host builds no
   * primed pool: no call is sent anywhere else.
   */
  projectHosts?: ProjectWardenHosts;
  /**
   * Another host's pause on this same login (a classify stage host shares the decision host's), so the
   * login's used-up state is one; absent, this host makes and owns its own (Claude logins only).
   */
  quota?: LoginQuotaPause;
  /**
   * Primed pool, Claude: serve decisions as subagents of a bounded pool of side processes (agent-session
   * ClaudeSubagentSessions) instead of one primed process per key: `processes` side sessions, each
   * hosting up to `membersPerProcess` roles. Memory stays capped at the pool size. Offline evals only.
   */
  subagents?: { processes: number; membersPerProcess: number };
}

/**
 * Launch flags of a project host (beside `--setting-sources ''`), as bare as a subscription launch
 * goes (Aron, 2026-11-02: "wardens should be as bare as possible"; `--bare` and
 * `CLAUDE_CODE_SIMPLE` refuse subscription logins): no MCP server but the host's own, no slash
 * commands or skills, the per-machine prompt sections out of the system prompt, no session written
 * to disk (`persistSession: false`).
 */
export const PROJECT_HOST_ARGS: readonly string[] = [
  '--strict-mcp-config',
  '--mcp-config',
  JSON.stringify({ mcpServers: { 'foundry-wardens': { type: 'sdk', name: 'foundry-wardens' } } }),
  '--disable-slash-commands',
  '--exclude-dynamic-system-prompt-sections',
  '--no-chrome',
];

/**
 * A project host's environment over the login's: no CLAUDE.md, no telemetry or other
 * non-essential traffic, no autoupdate. A `claude setup-token` login reaches it as
 * `CLAUDE_CODE_OAUTH_TOKEN` through the login's own launch (`NativeAuthentication`), so the CLI
 * reads no keychain; the default login is read by the CLI as usual.
 */
export const PROJECT_HOST_ENV: Readonly<Record<string, string>> = Object.freeze({
  ...CLAUDE_HARNESS_INSTRUCTIONS_OFF,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_AUTOUPDATER: '1',
});

/**
 * One decision host per decision profile and model: the decision login (checked as a subscription,
 * registered for the host's lifetime), its used-up pause, the decision receipts, the host's working
 * folder under the hosts directory, and the scheduler's per-call runs. With project hosts it launches
 * each project's Warden host and serves every call there; without them (`decisionRuntime: "claude"`
 * or `"codex"`) it builds the primed pool (`createPrimedPool`) and serves every call on it.
 */
export function createDecisionLoginHost(config: DecisionLoginHostConfig) {
  const { source } = config;
  const { runtime } = source;
  if (source.mode !== 'native-profile')
    throw Error('Primed decisions require a native subscription profile; API fallback is refused');
  const observedModel = config.expectedObservedModel ?? config.model;
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(config.model) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(observedModel) ||
    (runtime === 'codex' && observedModel !== config.model) ||
    !isAbsolute(config.directory) ||
    !Number.isSafeInteger(config.maxConcurrent) ||
    config.maxConcurrent < 1 ||
    config.maxConcurrent > 32 ||
    !Number.isSafeInteger(config.callTimeoutMs) ||
    config.callTimeoutMs < 100 ||
    config.callTimeoutMs > DECISION_CALL_TIMEOUT_MAX_MS
  )
    throw Error('Invalid primed decision configuration');
  assertPrivateProfile(config.directory);
  assertProfile(source.profileDirectory, runtime);
  const hostId = Bun.randomUUIDv7();
  // Receipts stay in the receipt directory; the sessions run in the host's own folder, outside any git work tree.
  const root = join(config.directory, `primed-${hostId}`);
  mkdirSync(root, { mode: 0o700 });
  const hosts = decisionHostsDirectory();
  mkdirSync(hosts, { recursive: true, mode: 0o700 });
  try {
    assertPrivateDirectory(hosts);
  } catch {
    throw Error(
      `Foundry's decision hosts folder ${hosts}, where Wardens run outside any git checkout, must be a directory you own with mode 0700 and not a symlink; fix it with \`chmod 700 ${hosts}\` (or remove it so Foundry makes it again)`,
    );
  }
  const workspace = join(hosts, `primed-${hostId}`);
  mkdirSync(workspace, { mode: 0o700 });
  // Its sessions run below these: Archive drops them as Foundry's own, never a person's work; the
  // parent's marker still stamps them once this host's folder is removed on close.
  stampFoundryRun(hosts);
  stampFoundryRun(workspace);
  /** The host's folder, once it is closed and its sessions are gone; one the CLI left something in is kept for inspection. */
  let workspaceClosed = false;
  const removeWorkspace = () => {
    if (!workspaceClosed) return;
    try {
      // A project host still stopping keeps the folder, and its marker with it.
      if (readdirSync(workspace).join() !== RUN_MARKER) return;
      unlinkSync(join(workspace, RUN_MARKER));
      rmdirSync(workspace);
    } catch {
      /* the CLI left something */
    }
  };
  const receiptsPath = join(root, 'decisions.jsonl');
  writeFileSync(
    join(root, 'host.json'),
    JSON.stringify(
      {
        schema: 1,
        hostId,
        runtime,
        transport: runtime === 'codex' ? 'codex-app-server' : 'claude-cli',
        mode: config.spawn ? 'controlled-transport' : 'native-subscription',
        sourceId: source.id,
        integrationId: source.integrationId,
        model: config.model,
        maxConcurrent: config.maxConcurrent,
        startedAt: Date.now(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  // Decisions share the user's login like any other process on it: a shared registration for their lifetime.
  // Codex runs on a private home kept across hosts in the receipt directory: the login only, no user instructions.
  const auth = new NativeAuthentication({
    directory: config.directory,
    sources: [source],
    defaultSourceId: source.id,
    shared: true,
    ...(runtime === 'codex' ? { privateHome: true } : {}),
  });
  let releaseFailures = 0;
  const release = (launch: { release(): void }) => {
    try {
      launch.release();
    } catch {
      releaseFailures++;
    }
  };
  const claude = runtime === 'claude' ? claudeLogin() : undefined;
  if (config.projectHosts && !claude)
    throw Error('Project Warden hosts run on a Claude decision login');
  /** This login used up: one pause for its scheduler and its project hosts, from the pool's own readings first. */
  const ownsQuota = !config.quota && runtime === 'claude';
  const quota =
    config.quota ??
    (ownsQuota
      ? makeLoginQuotaPause({
          fetchResetAt: () => fetchLoginQuotaResetAt(source),
          hostLimits: () => pool?.sessions.limits(),
        })
      : undefined);
  const onEvent = (event: PrimedEvent) => {
    if (event.type === 'limits') quota?.observe(event.limits);
    config.onEvent?.(event);
  };
  const claudeSpawn = (
    argv: string[],
    options: { cwd: string; env: Record<string, string | undefined> },
    env: Record<string, string | undefined>,
  ) => {
    // The user's hooks, permissions and plugins never apply to a decision.
    const command = [...argv, '--setting-sources', ''];
    return config.spawn
      ? config.spawn(command, { cwd: options.cwd, env })
      : (Bun.spawn(command, {
          cwd: options.cwd,
          env,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        }) as unknown as DecisionProcess);
  };
  const codexSpawn = async (
    argv: string[],
    options: { cwd: string; env: Record<string, string | undefined> },
  ) => {
    const launch = await auth.prepare(`primed-decisions:${hostId}`, 'codex');
    let child: DecisionProcess;
    try {
      const command = launch.launch(argv, options.env);
      const env = nativeTextEnvironment(command.env);
      child = config.spawn
        ? config.spawn(command.argv, { cwd: options.cwd, env })
        : (Bun.spawn(command.argv, {
            cwd: options.cwd,
            env,
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
          }) as unknown as DecisionProcess);
    } catch (error) {
      release(launch);
      throw error;
    }
    const done = () => release(launch);
    void child.exited.then(done, done);
    return child;
  };
  // With project hosts every call is a Warden's and goes to its project's host, so no pool is built.
  const pool = config.projectHosts
    ? undefined
    : createPrimedPool({
        model: config.model,
        ...(config.effort ? { effort: config.effort } : {}),
        ...(config.hedgeAfterMs !== undefined ? { hedgeAfterMs: config.hedgeAfterMs } : {}),
        maxConcurrent: config.maxConcurrent,
        ...(config.primedSessions !== undefined ? { primedSessions: config.primedSessions } : {}),
        ...(config.subagents ? { subagents: config.subagents } : {}),
        callTimeoutMs: config.callTimeoutMs,
        profileDirectory: source.profileDirectory,
        workspace,
        onEvent,
        login: claude
          ? { runtime: 'claude', spawn: claudeSpawn, env: claude.env }
          : { runtime: 'codex', spawn: codexSpawn },
      });

  /** The Claude login, checked as a subscription (never an API key) at most every five minutes and registered
   * as a shared holder for the host's lifetime; every decision process launches with its environment. */
  function claudeLogin() {
    let registered:
      | { env: Record<string, string | undefined>; launch: { release(): void } }
      | undefined;
    let pending: Promise<void> | undefined;
    let verifiedAt = 0,
      closed = false;
    const verify = async () => {
      const env = withProfile(
        nativeTextEnvironment(process.env),
        'claude',
        source.profileDirectory,
      );
      const child = config.statusSpawn
        ? config.statusSpawn(env)
        : (Bun.spawn(['claude', 'auth', 'status', '--json'], {
            env,
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
          }) as unknown as StatusProcess);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const subscribed = await Promise.race([
          subscriptionStatus(child),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), STATUS_DEADLINE_MS);
          }),
        ]);
        if (!subscribed)
          throw new DecisionError(
            'Authenticated Claude subscription required; no API fallback',
            'auth',
            'not-dispatched',
            true,
          );
      } finally {
        clearTimeout(timer);
        try {
          child.kill();
        } catch {
          /* exited */
        }
      }
      verifiedAt = Date.now();
      if (registered) return;
      const launch = await auth.prepare(`primed-decisions:${hostId}`, 'claude');
      try {
        const command = launch.launch(['claude'], nativeTextEnvironment(process.env));
        // This process is the holder: its registration is reclaimable once it is gone.
        launch.adopt?.(process.pid);
        registered = { env: nativeTextEnvironment(command.env), launch };
      } catch (error) {
        release(launch);
        throw error;
      }
      // A host closed while registering never keeps the login.
      if (closed) {
        release(launch);
        registered = undefined;
        throw Error('Decision host closed');
      }
    };
    return {
      ready: (): Promise<void> => {
        if (closed) return Promise.reject(Error('Decision host closed'));
        if (registered && Date.now() - verifiedAt < STATUS_TTL_MS) return Promise.resolve();
        pending ??= verify().finally(() => {
          pending = undefined;
        });
        return pending;
      },
      env: () => {
        if (!registered) throw Error('Claude decision login is not registered');
        return { ...registered.env, DISABLE_AUTOUPDATER: '1' };
      },
      release: () => {
        closed = true;
        if (registered) release(registered.launch);
        registered = undefined;
      },
    };
  }

  const configuration = {
    requestedModel: config.model,
    ...(config.effort ? { requestedEffort: config.effort } : {}),
    requestedMaxTurns: 1,
    turnBudgetEnforcement: 'launch-option' as const,
    tokenBudget: 'unavailable' as const,
    effortBudget: 'unavailable' as const,
  };
  const receipt = (call: NativeTextCall, extra: Record<string, unknown>) => {
    // Ownership, model and settlement facts only: never prompts, context or answers.
    try {
      appendFileSync(
        receiptsPath,
        JSON.stringify({ schema: 1, hostId, ...call, ...extra }) + '\n',
        { mode: 0o600 },
      );
    } catch {
      /* receipts are observers */
    }
  };

  const failure = (error: DecisionError): NonNullable<NativeTextCall['failure']> =>
    error.dispatch === 'not-dispatched'
      ? error.reason === 'rate-limited' || error.reason === 'not-held'
        ? error.reason
        : 'not-admitted'
      : error.reason === 'rate-limited'
        ? 'rate-limited'
        : error.reason === 'timeout' || error.reason === 'aborted'
          ? 'deadline'
          : error.reason === 'native-failed'
            ? 'native-failed'
            : // The shared process was lost or recycled and its exit observed: nothing of this call still runs.
              error.reason === 'transport' && error.settled
              ? 'process-lost'
              : 'provider-or-evidence';

  /** A scheduler run: one decision on the shared host. */
  const createRun = (run: NativeTextConfig) => {
    if (!uuid.test(run.runId)) throw Error('Invalid primed decision run');
    const calls: NativeTextCall[] = [];
    let closed = false;
    // Closing the run (revocation, shutdown) cancels its decision: refused before dispatch, or interrupted and settled.
    const abort = new AbortController();
    const provider: LLMProvider = {
      id: `primed-${runtime}-decisions`,
      async complete(messages: LLMMessage[], opts: CompletionOpts = {}): Promise<CompletionResult> {
        if (closed || calls.length >= (run.maxCalls ?? 1))
          throw Error('Decision admission closed or occupied; no retry or queue');
        const timeout = run.callTimeoutMs ?? config.callTimeoutMs;
        if (
          (opts.model && opts.model !== config.model) ||
          opts.tools === true ||
          opts.toolDefinitions?.length ||
          opts.nativeObservation?.bridge ||
          (opts.maxTurns !== undefined && opts.maxTurns !== 1) ||
          (opts.timeout !== undefined &&
            (!Number.isSafeInteger(opts.timeout) || opts.timeout < 100 || opts.timeout > timeout))
        )
          throw Error('Decision scope or model override refused');
        if (JSON.stringify(messages).length > (config.inputCap ?? DECISION_INPUT_CAP))
          throw Error('Decision input cap exceeded');
        const id = Bun.randomUUIDv7(),
          fallbackThread = `primed:${hostId}:${id}`;
        const owner = freezeEvidence({
          ...(opts.nativeObservation?.owner ?? {
            threadId: fallbackThread,
            projectId: hostId,
            generation: run.runId,
            messageId: id,
            dispatchId: id,
          }),
          providerSessionKey:
            opts.nativeObservation?.owner?.providerSessionKey ?? opts.threadId ?? fallbackThread,
        });
        const sessionKey = owner.providerSessionKey!;
        // Calls without a logical session (e.g. `decision:<id>`) do not keep a primed session afterwards.
        const oneShot = sessionKey === fallbackThread || sessionKey.startsWith('decision:');
        const call: NativeTextCall = {
          id,
          owner,
          inputHash: hash(JSON.stringify(messages)),
          startedAt: Date.now(),
          transport: 'primed',
          release: 'not-requested',
          processExit: 'not-started',
          statusProcessExit: 'not-started',
          deadline: false,
          valid: false,
        };
        calls.push(call);
        let spec: PrimeSpec,
          input: string,
          target: PrimedSessions | undefined = pool?.sessions,
          admission: NativeEvidence | undefined,
          result: DecisionResult | undefined,
          failedHedge = false,
          heldOnly = false;
        try {
          ({ spec, input } = primedRequest(messages, opts, sessionKey));
          // Project hosts serve only Warden calls; with them there is no pool to send any other call to.
          if (!pool && !isWardenSession(sessionKey))
            throw Error('No primed pool with project Warden hosts; not a Warden call');
          await opts.nativeObservation?.preflight?.(owner);
          await claude?.ready();
          if (closed) throw Error('Decision admission closed');
          // A project host's spares hold no thread state (every thread of the project shares them):
          // they split at the stable prefix, and the thread section rides with the moment.
          // A Warden whose project host does not serve is refused unsent, never run on primed.
          // Held-only advice (a user message's, which catches up) is served warm or skipped: a Warden
          // with no held spare is refused unsent too. The queue refuses one before queueing it; a host
          // that went while the call waited is caught here.
          const projectHost = projectHostTarget(config.projectHosts, sessionKey);
          if (projectHost === 'not-serving')
            throw new DecisionError(
              'Project Warden host not serving',
              'not-held',
              'not-dispatched',
              true,
            );
          heldOnly = heldOnlyFor(sessionKey, opts) && !!projectHost;
          if (projectHost) target = projectHost;
          if (!target) throw Error('No primed pool with project Warden hosts; not a Warden call');
          const { capacity } = target.snapshot();
          if (capacity) call.hostCapacity = capacity;
          result = await target.decide(spec, {
            ...(projectHost && spec.context && !opts.takesNoHeldCall ? { standby: '' } : {}),
            ...(heldOnly ? { heldOnly: true } : {}),
            input,
            timeoutMs: Math.min(opts.timeout ?? timeout, timeout),
            signal: abort.signal,
            onAdmission: async (a) => {
              admission = freezeEvidence<NativeEvidence>({
                schema: 1,
                owner,
                admissionId: a.admissionId,
                nativeOutcome: 'unknown',
                localOutcome: 'pending',
                dispatch: 'not-dispatched',
                configuration,
              });
              call.admission = admission;
              // Registration precedes the native write, so a refused admission never reaches the runtime.
              await opts.nativeObservation?.register(admission);
              if (closed) throw Error('Decision admission closed');
            },
          });
          const terminal = freezeEvidence<NativeEvidence>({
            ...admission!,
            nativeSessionId: result.threadId,
            externalSessionId: result.threadId,
            turnId: result.turnId,
            nativeOutcome: 'completed',
            localOutcome: 'resolved',
            dispatch: 'attempted',
            transportOutcome: 'open',
            terminal: {
              type: 'turn/completed',
              ...(result.turnId ? { turnId: result.turnId } : {}),
            },
            configuration: {
              ...configuration,
              ...(result.model ? { observedModel: result.model } : {}),
            },
          });
          call.terminal = terminal;
          call.settled = true;
          call.prime = result.prime;
          if (result.tokens) {
            const { providerUsage: _usage, ...usage } = result.tokens;
            call.usage = usage;
          }
          // The runtime reports the model serving the session; a substitution is refused.
          if (result.model && result.model !== observedModel)
            throw Error('The decision runtime served a different model than requested');
          await opts.nativeObservation?.observe(terminal);
          call.valid = true;
          call.release = 'released';
          return {
            content: result.content,
            model: config.model,
            native: terminal,
            ...(result.tokens ? { tokens: result.tokens } : {}),
          };
        } catch (error) {
          if (error instanceof DecisionError) {
            failedHedge = !!error.hedged;
            call.settled = error.settled;
            call.reason = error.reason;
            call.failure = failure(error);
            call.deadline = error.reason === 'timeout';
            call.release = error.settled ? 'released' : 'unknown';
            if (admission)
              call.terminal = freezeEvidence<NativeEvidence>({
                ...admission,
                localOutcome: 'rejected',
                dispatch: error.dispatch,
                nativeOutcome:
                  error.dispatch === 'attempted' && error.reason === 'native-failed'
                    ? 'failed'
                    : 'unknown',
              });
          } else {
            // Our own refusal: before any admission nothing was sent; after a result the turn had settled.
            call.settled = true;
            call.release = 'released';
            call.failure = admission ? 'provider-or-evidence' : 'not-admitted';
          }
          throw Object.assign(
            Error('Decision call failed; inspect retained ownership and release evidence'),
            { evidencePath: receiptsPath, callId: id },
          );
        } finally {
          call.finishedAt = Date.now();
          receipt(
            call,
            result
              ? {
                  prime: result.prime,
                  timing: result.timing,
                  ...(result.hedged ? { hedged: true } : {}),
                  ...(result.transportFallback ? { transportFallback: true } : {}),
                }
              : failedHedge
                ? { hedged: true }
                : {},
          );
          if (oneShot && spec! && target) void target.evict(spec.key).catch(() => undefined);
        }
      },
    };
    return {
      provider,
      snapshot: () => freezeEvidence({ closed, calls }),
      close: () => {
        closed = true;
        abort.abort();
      },
    };
  };

  // Project Warden hosts: this host starts each project's host process on its own decision login.
  if (config.projectHosts && claude) {
    if (!quota) throw Error('Project Warden hosts need the decision login pause');
    const loginQuota = quota;
    config.projectHosts.bindLauncher(loginQuota, async (projectId, extension) => {
      await claude.ready();
      // Below the stamped host folder, outside any git work tree: Archive drops it as Foundry's own run.
      const dir = join(
        workspace,
        `project-${hash(projectId).slice(0, 12)}-${crypto.randomUUID().slice(0, 8)}`,
      );
      mkdirSync(dir, { mode: 0o700 });
      /** Its folder, once nothing runs in it; one the CLI left something in is kept for inspection. */
      const removeDir = () => {
        try {
          rmdirSync(dir);
        } catch {
          /* the CLI left something */
        }
        removeWorkspace();
      };
      let child: DecisionProcess | undefined;
      let session: ClaudeCodeSession | undefined;
      let ended!: Promise<string>;
      try {
        session = new ClaudeCodeSession({
          model: config.model,
          ...(config.effort ? { effort: config.effort } : {}),
          cwd: dir,
          maxTurns: null,
          persistSession: false,
          // why: without its charter a Haiku host declined the setup message twice (2026-11-19).
          baseContext: IN_SESSION_HOST_CHARTER,
          // The login's profile; the Wardens are their own instructions, never the user's CLAUDE.md.
          env: { ...profileEnvironment('claude', source.profileDirectory), ...PROJECT_HOST_ENV },
          spawn: (argv, options) => {
            child = claudeSpawn([...argv, ...PROJECT_HOST_ARGS], options, {
              ...withoutCompetingCredentials(options.env),
              ...claude.env(),
              // why: the strip drops every CLAUDE_CODE_* key, the host's raised subagent cap included.
              ...extension.env,
              ...PROJECT_HOST_ENV,
            });
            return child;
          },
        });
        session.extend(extension);
        const started = session;
        ended = new Promise<string>((resolve) => {
          started.onEvent((event) => {
            if (event.kind === 'session_end') resolve(event.transportOutcome ?? 'ended');
            if (event.kind === 'rate_limit' && event.limits) loginQuota.observe(event.limits);
          });
        });
        await session.start();
      } catch (error) {
        // A launch that failed, building or starting, leaves no folder behind.
        session?.kill();
        await child?.exited.catch(() => undefined);
        removeDir();
        throw error;
      }
      const running = session;
      // A real launch is a Bun subprocess with a pid; a test transport may have none.
      const pid = (child as { pid?: unknown } | undefined)?.pid;
      return {
        ...(typeof pid === 'number' ? { pid } : {}),
        ended,
        stop: async () => {
          running.kill();
          await child?.exited.catch(() => undefined);
          removeDir();
        },
      };
    });
  }

  return {
    /** The primed pool: built only without project hosts (`decisionRuntime: "claude"` or `"codex"`). */
    pool: pool?.sessions,
    hostId,
    receiptsPath,
    createRun,
    quota,
    releaseFailures: () => releaseFailures,
    close: async () => {
      if (ownsQuota) quota?.close();
      try {
        await pool?.close();
      } finally {
        claude?.release();
        workspaceClosed = true;
        removeWorkspace();
      }
    },
  };
}
