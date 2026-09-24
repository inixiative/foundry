import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { freezeEvidence, type CompletionOpts, type CompletionResult, type LLMProvider, type NativeEvidence } from "@inixiative/foundry-core";
import { NativeAuthentication } from "./native-authentication";
import { assertPrivateProfile, assertProfile } from "./private-profile";
import { nativeTextEnvironment } from "./native-text-environment";
import { withProfile } from "./default-profiles";
import { DECISION_CONTEXT, formatMessagesForNativeSession } from "./session-backed";
import type { NativeTextCall, NativeTextConfig, StatusProcess } from "./native-text-provider";

export interface CodexTextProcess extends StatusProcess {
  readonly stdin: { write(data: string): unknown; end(): unknown };
}
type Spawn = (argv: string[], options: { cwd: string; env: Record<string, string | undefined> }) => CodexTextProcess;

/** Tool surfaces a decision never needs. Observation independently refuses any non-text item. */
const DISABLED_FEATURES = ["shell_tool", "unified_exec", "apps", "plugins", "remote_plugin", "browser_use", "browser_use_external",
  "computer_use", "image_generation", "memories", "multi_agent", "goals", "hooks", "view_image", "sleep_tool", "skill_search",
  "tool_suggest", "shell_snapshot", "skill_mcp_dependency_install", "workspace_dependencies", "in_app_browser",
  "in_app_local_automation", "personality", "mentions_v2"];
const TEXT_ITEMS = new Set(["agent_message", "reasoning"]);
/** Subscription usage/rate limits: backoff, never a fallback. */
const RATE_LIMIT = /rate.?limit|usage.?limit|too many requests|\b429\b/i;
const MAX_OUTPUT = 1_000_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** One non-interactive, ephemeral, read-only turn. The prompt travels on stdin, never argv. */
export function codexDecisionArgs(model: string, cwd: string): string[] {
  return ["codex", "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
    "--sandbox", "read-only", "--cd", cwd, "--model", model, "-c", 'approval_policy="never"', "-c", 'web_search="disabled"',
    ...DISABLED_FEATURES.flatMap(feature => ["--disable", feature]), "-"];
}

/** `codex login status` reports the login method on stderr. Only a ChatGPT subscription qualifies. */
export async function codexSubscriptionStatus(proc: StatusProcess): Promise<boolean> {
  try {
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return code === 0 && `${stdout}\n${stderr}`.split("\n").some(line => line.trim() === "Logged in using ChatGPT");
  } catch { return false; }
}

export function createCodexTextProvider(config: NativeTextConfig) {
  return buildCodexTextProvider(config);
}

/** Bounded Codex subscription text calls; the Codex counterpart of the native Claude text provider.
 * Test transport seam: production callers use createCodexTextProvider. */
export function buildCodexTextProvider(config: NativeTextConfig, controlled?: { spawn: Spawn; statusSpawn: (profileDirectory: string) => StatusProcess }) {
  config = structuredClone(config);
  const source = config.source;
  const maxCalls = config.maxCalls ?? 2, timeout = config.callTimeoutMs ?? 15_000;
  if (source.runtime !== "codex" || source.mode !== "native-profile") throw Error("Codex text decisions require an explicit Codex native profile; API fallback is refused");
  if (config.expectedObservedModel !== undefined && config.expectedObservedModel !== config.model)
    throw Error("Codex exec does not acknowledge an observed model; expectedObservedModel cannot be enforced");
  if (!uuid.test(config.runId) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(config.model) || !isAbsolute(config.directory)
    || !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 4
    || !Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30_000) throw Error("Invalid bounded Codex text configuration");
  assertPrivateProfile(config.directory);
  assertProfile(source.profileDirectory, "codex");
  const directory = join(config.directory, config.runId);
  // Codex serves concurrent sessions on one login; decision processes share the profile.
  const auth = new NativeAuthentication({ directory, sources: [source], defaultSourceId: source.id, shared: true });
  mkdirSync(directory, { mode: 0o700 });
  const cwd = join(directory, "fixture"); mkdirSync(cwd, { mode: 0o700 });
  const reportPath = join(directory, "codex-text.json");
  const calls: NativeTextCall[] = [];
  const configuration = { requestedModel: config.model, requestedMaxTurns: 1, turnBudgetEnforcement: "launch-option" as const,
    tokenBudget: "unavailable" as const, effortBudget: "unavailable" as const };
  let busy = false, closed = false, abort: (() => void) | undefined;
  const persist = () => {
    try {
      writeFileSync(`${reportPath}.tmp`, JSON.stringify({ schema: 1, runId: config.runId, runtime: "codex",
        mode: controlled ? "controlled-transport" : "native-subscription", sourceId: source.id, connectionId: source.connectionId,
        model: config.model, maxCalls, callTimeoutMs: timeout, closed, calls }, null, 2), { mode: 0o600 });
      renameSync(`${reportPath}.tmp`, reportPath);
    } catch (error) { closed = true; throw error; }
  };
  persist();
  const provider: LLMProvider = {
    id: "native-text-codex",
    async complete(messages, opts: CompletionOpts = {}) {
      if (closed || busy || calls.length >= maxCalls) throw Error("Codex text admission closed or occupied; no retry or queue");
      if ((opts.model && opts.model !== config.model) || opts.tools === true || opts.toolDefinitions?.length
        || opts.nativeObservation?.bridge || (opts.cwd && opts.cwd !== cwd)
        || (opts.maxTurns !== undefined && opts.maxTurns !== 1)
        || (opts.timeout !== undefined && (!Number.isSafeInteger(opts.timeout) || opts.timeout < 100 || opts.timeout > timeout)))
        throw Error("Codex text scope or model override refused");
      const prompt = `${DECISION_CONTEXT}\n\n${formatMessagesForNativeSession(messages)}`;
      if (prompt.length > 100_000) throw Error("Codex text input cap exceeded");
      busy = true;
      const id = crypto.randomUUID(), threadId = `codex-text:${config.runId}:${id}`;
      const owner = freezeEvidence({ ...(opts.nativeObservation?.owner ?? {
        threadId, projectId: config.runId, generation: config.runId, messageId: id, dispatchId: id,
      }), providerSessionKey: threadId });
      const call: NativeTextCall = { id, owner, inputHash: hash(JSON.stringify(messages)), startedAt: Date.now(),
        release: "not-requested", processExit: "not-started", statusProcessExit: "not-started", deadline: false, valid: false };
      calls.push(call);
      let child: CodexTextProcess | undefined, statusChild: StatusProcess | undefined, release: (() => void) | undefined;
      let rateLimited = false;
      let result: CompletionResult | undefined;
      const stop = () => { for (const proc of [child, statusChild]) { try { proc?.kill(); } catch { closed = true; } } };
      abort = stop;
      let deadlineReject!: (error: Error) => void;
      const deadline = new Promise<never>((_, reject) => { deadlineReject = reject; });
      void deadline.catch(() => {});
      const timer = setTimeout(() => {
        call.deadline = true; closed = true; stop(); deadlineReject(Error("Codex text deadline; no further admissions"));
      }, opts.timeout ?? timeout);
      try {
        persist();
        statusChild = controlled ? controlled.statusSpawn(source.profileDirectory) : Bun.spawn(["codex", "login", "status"], {
          env: withProfile(nativeTextEnvironment(process.env), "codex", source.profileDirectory),
          stdin: "ignore", stdout: "pipe", stderr: "pipe",
        });
        call.statusProcessExit = "pending";
        void statusChild.exited.then(() => { call.statusProcessExit = "exited"; }, () => { closed = true; });
        if (!await Promise.race([deadline, codexSubscriptionStatus(statusChild)]) || closed) throw Error("Authenticated Codex ChatGPT subscription required");
        await Promise.race([deadline, Promise.resolve(opts.nativeObservation?.preflight?.(owner))]);
        if (closed) throw Error("Codex text admission closed");
        const launch = await auth.prepare(threadId, "codex");
        const admission = freezeEvidence<NativeEvidence>({ schema: 1, owner, admissionId: crypto.randomUUID(),
          nativeOutcome: "unknown", localOutcome: "pending", dispatch: "not-dispatched", configuration });
        call.admission = admission; persist();
        // Registration precedes the native write, so a refused admission never reaches Codex.
        await Promise.race([deadline, Promise.resolve(opts.nativeObservation?.register(admission))]);
        if (closed) throw Error("Codex text admission deadline");
        const command = launch.launch(codexDecisionArgs(config.model, cwd), process.env);
        release = launch.release;
        const env = nativeTextEnvironment(command.env);
        try {
          child = controlled ? controlled.spawn(command.argv, { cwd, env })
            : Bun.spawn(command.argv, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        } catch (error) { launch.release(); release = undefined; throw error; }
        call.processExit = "pending";
        void child.exited.then(() => { call.processExit = "exited"; }, () => { closed = true; });
        child.stdin.write(prompt); child.stdin.end();
        const stderr = new Response(child.stderr).text().then(text => text.slice(-8_192), () => "");
        const outcome = await Promise.race([deadline, readTurn(child, () => { closed = true; stop(); })]);
        const code = await Promise.race([deadline, child.exited]);
        rateLimited = !outcome.violation && RATE_LIMIT.test(`${outcome.error ?? ""}\n${await Promise.race([stderr, Bun.sleep(500).then(() => "")])}`);
        const terminal = freezeEvidence<NativeEvidence>({ ...admission, nativeSessionId: outcome.threadId, externalSessionId: outcome.threadId,
          nativeOutcome: outcome.completed && !outcome.violation ? "completed" : "failed", localOutcome: "resolved", dispatch: "attempted",
          transportOutcome: "closed", terminal: { type: outcome.completed ? "turn.completed" : "turn.failed" } });
        call.terminal = terminal; persist();
        if (code !== 0 || !outcome.completed || outcome.violation || !outcome.threadId || outcome.content === undefined || call.deadline)
          throw Error("Codex text completion is not proven");
        await opts.nativeObservation?.observe(terminal);
        result = { content: outcome.content, model: config.model, native: terminal,
          ...(outcome.usage ? { tokens: outcome.usage } : {}) };
        call.usage = outcome.usage;
        if ((call as NativeTextCall).processExit !== "exited" || call.deadline) throw Error("Codex text process exit is not proven");
        launch.release(); release = undefined;
        call.release = "released";
        call.valid = true;
      } catch {
        closed = true;
        call.failure = !child ? "not-admitted" : call.deadline ? "deadline" : rateLimited ? "rate-limited" : "provider-or-evidence";
      } finally {
        stop();
        const exits = [child, statusChild].filter((proc): proc is StatusProcess => proc !== undefined);
        if (exits.length) {
          let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([Promise.all(exits.map(proc => proc.exited.catch(() => {}))),
            new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 2_000); })]);
          clearTimeout(cleanupTimer);
        }
        if (release && call.processExit === "exited") {
          try { release(); call.release = "released"; } catch { call.release = "unknown"; }
        }
        if (call.processExit === "pending" || call.statusProcessExit === "pending") {
          call.valid = false; closed = true; call.failure ??= "provider-or-evidence";
        }
        clearTimeout(timer);
        call.finishedAt = Date.now();
        if (!call.valid && call.release === "not-requested") call.release = child ? "unknown" : "released";
        busy = false; abort = undefined;
        persist();
      }
      if (!call.valid || !result) throw Object.assign(Error("Codex text call failed; inspect retained ownership and release evidence"), { evidencePath: reportPath, callId: id });
      return result;
    },
  };
  return { provider, reportPath, snapshot: () => freezeEvidence({ closed, calls }),
    /** Closes admission and stops an in-flight process; its exit releases the profile lock. */
    close: () => { closed = true; abort?.(); persist(); } };
}

interface TurnOutcome {
  threadId?: string;
  content?: string;
  /** Native failure text (turn.failed or error events), kept only to classify rate limits. */
  error?: string;
  completed: boolean;
  violation: boolean;
  usage?: { input: number; output: number };
}

/** Parse `codex exec --json` events. Any tool, file, command or error item fails the decision. */
async function readTurn(child: CodexTextProcess, refuse: () => void): Promise<TurnOutcome> {
  const outcome: TurnOutcome = { completed: false, violation: false };
  const violate = () => { if (!outcome.violation) { outcome.violation = true; refuse(); } };
  const decoder = new TextDecoder();
  let buffer = "", size = 0;
  const line = (text: string) => {
    if (!text.trim()) return;
    let event: Record<string, unknown>;
    try { event = JSON.parse(text); } catch { return violate(); }
    const item = event.item as Record<string, unknown> | undefined;
    switch (event.type) {
      case "thread.started": if (typeof event.thread_id === "string") outcome.threadId = event.thread_id; else violate(); break;
      case "turn.started": break;
      case "item.started": case "item.updated": case "item.completed":
        // A CLI notice, not model output or tool use (e.g. "Falling back from WebSockets to HTTPS transport").
        if (item?.type === "error") { if (typeof item.message === "string") outcome.error = item.message.slice(0, 2_000); break; }
        if (!item || !TEXT_ITEMS.has(item.type as string)) return violate();
        if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") outcome.content = item.text;
        break;
      case "turn.failed": case "error": {
        const error = (event.type === "error" ? event : event.error) as Record<string, unknown> | undefined;
        if (typeof error?.message === "string") outcome.error = error.message.slice(0, 2_000);
        break;
      }
      case "turn.completed": {
        if (outcome.completed) return violate();
        outcome.completed = true;
        const usage = event.usage as Record<string, unknown> | undefined;
        if (typeof usage?.input_tokens === "number" && typeof usage.output_tokens === "number")
          outcome.usage = { input: usage.input_tokens, output: usage.output_tokens };
        break;
      }
      default: violate();
    }
  };
  for await (const chunk of child.stdout) {
    size += chunk.byteLength;
    if (size > MAX_OUTPUT) { violate(); break; }
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const text of lines) line(text);
  }
  line(buffer + decoder.decode());
  return outcome;
}
