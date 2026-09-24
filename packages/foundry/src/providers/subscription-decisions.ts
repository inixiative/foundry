import { freezeEvidence, sameNativeOwner, type CompletionOpts, type CompletionResult, type LLMMessage, type LLMProvider, type NativeEvidence, type NativeOwner, type OwnedAdmissionInspection } from "@inixiative/foundry-core";
import { createNativeTextProvider, type NativeTextConfig } from "./native-text-provider";
import { createCodexTextProvider } from "./codex-text-provider";
import { DECISION_PRIORITY } from "./decision-priority";

export interface SubscriptionDecisionConfig extends Omit<NativeTextConfig, "runId" | "maxCalls"> {
  maxCalls: number;
  maxQueued: number;
  callTimeoutMs: number;
  /** Decisions running at once across all threads, each its own native process. Default 1. */
  maxConcurrent?: number;
  /** Waiting decisions per logical thread. Default: maxQueued. */
  maxQueuedPerThread?: number;
  /** Load and rate-limit events (shedding, backoff); observers only. */
  onPressure?: (event: DecisionPressure) => void;
  /** First rate-limit backoff; doubles to 60 s. Default 5 s. */
  rateLimitBackoffMs?: number;
}
export type DecisionPressure =
  | { kind: "shed"; threadId: string; priority: number; queued: number }
  | { kind: "rate-limited"; until: number; backoffMs: number };
type TextRun = Pick<ReturnType<typeof createNativeTextProvider>, "provider" | "snapshot" | "close">;
type Outcome = { admission: "not-admitted" | "attempted" | "unknown"; settlement: "settled" | "unknown" };
type Record = { owner: NativeOwner; inspection: OwnedAdmissionInspection };
type Pending = { messages: LLMMessage[]; opts: CompletionOpts; owner: NativeOwner; deadline: number;
  priority: number; thread: string; seq: number;
  resolve(value: CompletionResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** Decisions run on the decision profile's own runtime: Codex exec or text-only Claude. */
export function createSubscriptionDecisions(config: SubscriptionDecisionConfig) {
  return buildSubscriptionDecisions(config, config.source.runtime === "codex" ? createCodexTextProvider : createNativeTextProvider);
}

export function buildSubscriptionDecisions(options: SubscriptionDecisionConfig, createRun: (config: NativeTextConfig) => TextRun) {
  const { onPressure, ...bounds } = options;
  const config = structuredClone(bounds);
  if (!Number.isSafeInteger(config.maxCalls) || config.maxCalls < 1 || config.maxCalls > 10_000
    || !Number.isSafeInteger(config.maxQueued) || config.maxQueued < 1 || config.maxQueued > 1_024
    || (config.maxQueuedPerThread !== undefined && (!Number.isSafeInteger(config.maxQueuedPerThread) || config.maxQueuedPerThread < 1 || config.maxQueuedPerThread > config.maxQueued))
    || !Number.isSafeInteger(config.callTimeoutMs) || config.callTimeoutMs < 100 || config.callTimeoutMs > 30_000
    || (config.maxConcurrent !== undefined && (!Number.isSafeInteger(config.maxConcurrent) || config.maxConcurrent < 1 || config.maxConcurrent > 32)))
    throw Error("Invalid subscription decision bounds");
  const maxConcurrent = config.maxConcurrent ?? 1, maxQueuedPerThread = config.maxQueuedPerThread ?? config.maxQueued;
  // Background classes never take every slot, so a turn waiting to start finds capacity.
  const classCap = (priority: number) => priority >= DECISION_PRIORITY.turn ? maxConcurrent
    : Math.max(1, Math.floor(maxConcurrent * (priority >= DECISION_PRIORITY.guard ? 3 / 4 : 1 / 2)));
  const queue: Pending[] = [], records = new Map<string, Record>(), outcomes = new WeakMap<object, Outcome>();
  const initialBackoff = config.rateLimitBackoffMs ?? 5_000;
  let active = 0, closed = false, attempts = 0, seq = 0, shed = 0, backoffUntil = 0, backoffMs = initialBackoff;
  let backoffTimer: ReturnType<typeof setTimeout> | undefined;
  const running = new Set<TextRun>(), runningPriorities: number[] = [], lastServed = new Map<string, number>();
  const pressure = (event: DecisionPressure) => { try { onPressure?.(event); } catch { /* Observers cannot change scheduling. */ } };
  const reject = (message: string) => {
    const error = Error(message);
    outcomes.set(error, { admission: "not-admitted", settlement: "settled" });
    return error;
  };
  const close = () => {
    closed = true;
    for (const pending of queue.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(reject("Subscription decision admission closed"));
    }
  };
  const check = (pending: Pending) => {
    if (closed || Date.now() >= pending.deadline) throw reject("Subscription decision expired or revoked");
  };
  const find = (owner: NativeOwner, id: string) => {
    const record = records.get(id);
    return record && sameNativeOwner(record.owner, owner) ? record : undefined;
  };
  /** Highest priority first; within it the thread served longest ago (fairness), then arrival order. */
  const next = (): Pending | undefined => {
    if (!queue.length) return undefined;
    const priority = Math.max(...queue.map(p => p.priority));
    if (runningPriorities.filter(p => p <= priority).length >= classCap(priority)) return undefined;
    const candidates = queue.filter(p => p.priority === priority);
    const served = (p: Pending) => lastServed.get(p.thread) ?? -1;
    const chosen = candidates.reduce((best, p) => served(p) < served(best) || (served(p) === served(best) && p.seq < best.seq) ? p : best);
    queue.splice(queue.indexOf(chosen), 1);
    return chosen;
  };
  const pump = () => {
    if (Date.now() < backoffUntil) {
      backoffTimer ??= setTimeout(() => { backoffTimer = undefined; pump(); }, backoffUntil - Date.now());
      return;
    }
    for (let pending: Pending | undefined; !closed && active < maxConcurrent && (pending = next());) void start(pending);
  };
  const start = async (pending: Pending) => {
    active++; runningPriorities.push(pending.priority); lastServed.set(pending.thread, ++seq);
    clearTimeout(pending.timer);
    let finalized = false;
    let run: TextRun | undefined, registered: NativeEvidence | undefined, physicalOwner: NativeOwner | undefined;
    const { opts, owner } = pending;
    const inspectable = (native: NativeEvidence): NativeEvidence => freezeEvidence({ schema: 1,
      owner, admissionId: native.admissionId, nativeSessionId: native.nativeSessionId,
      externalSessionId: native.externalSessionId, threadId: native.threadId, turnId: native.turnId,
      nativeOutcome: "unknown", localOutcome: "pending", dispatch: native.dispatch });
    try {
      check(pending);
      let preflightTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.resolve(opts.nativeObservation?.preflight?.(owner)), new Promise<never>((_, fail) => {
          preflightTimer = setTimeout(() => fail(reject("Subscription preflight deadline")), Math.max(0, pending.deadline - Date.now()));
        })]);
      } finally { clearTimeout(preflightTimer); }
      check(pending);
      if (attempts >= config.maxCalls || pending.deadline - Date.now() < 100) throw reject("Subscription decision budget exhausted");
      attempts++;
      run = createRun({ ...config, runId: crypto.randomUUID(), maxCalls: 1,
        callTimeoutMs: Math.min(config.callTimeoutMs, pending.deadline - Date.now()) });
      running.add(run);
      const result = await run.provider.complete(pending.messages, { ...opts, cwd: undefined, threadId: undefined,
        timeout: undefined, tools: false, maxTurns: 1, model: config.model,
        nativeObservation: { owner,
          preflight: async () => { check(pending); await opts.nativeObservation?.preflight?.(owner); check(pending); },
          register: async native => {
            check(pending);
            if (registered || !native.admissionId || !native.owner || records.has(native.admissionId)) throw Error("Duplicate or missing subscription admission");
            physicalOwner = freezeEvidence(native.owner);
            if (!sameNativeOwner({ ...physicalOwner, providerSessionKey: owner.providerSessionKey }, owner))
              throw Error("Subscription admission owner mismatch");
            registered = inspectable(native);
            records.set(native.admissionId, { owner, inspection: { evidence: registered, call: "pending", capacity: "unknown", cleanup: "not-requested" } });
            await opts.nativeObservation?.register(registered);
            check(pending);
          },
          observe: native => {
            if (!registered || native.admissionId !== registered.admissionId || !sameNativeOwner(native.owner, physicalOwner))
              throw Error("Subscription observation owner mismatch");
          },
        },
      });
      check(pending);
      const call = run.snapshot().calls[0];
      if (!call?.valid || call.release !== "released" || call.processExit !== "exited" || call.statusProcessExit !== "exited"
        || !registered?.admissionId || !result.native || !sameNativeOwner(result.native.owner, physicalOwner)
        || result.native.admissionId !== registered.admissionId) throw Error("Subscription decision acceptance unproved");
      try { run.close(); finalized = true; } catch { close(); throw Error("Subscription receipt finalization failed"); }
      const native = freezeEvidence({ ...result.native, owner, content: result.content });
      const completion: CompletionResult = { content: result.content, model: result.model, tokens: result.tokens, native };
      records.set(registered.admissionId, { owner, inspection: { evidence: native, call: "settled", capacity: "settled", cleanup: "released" } });
      try { void Promise.resolve(opts.nativeObservation?.observe(native)).catch(close); } catch { close(); }
      outcomes.set(completion, { admission: "attempted", settlement: "settled" });
      backoffMs = initialBackoff;
      pending.resolve(completion);
    } catch {
      const call = run?.snapshot().calls[0];
      const settled = !call || (call.processExit !== "pending" && call.statusProcessExit !== "pending"
        && (call.processExit === "not-started" || call.release === "released"));
      const limited = settled && call?.failure === "rate-limited";
      const error = Error(limited ? "Subscription decision rate limited; no fallback or retry" : "Subscription decision failed; no fallback or retry");
      if (limited) {
        backoffUntil = Math.max(backoffUntil, Date.now() + backoffMs);
        pressure({ kind: "rate-limited", until: backoffUntil, backoffMs });
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
      outcomes.set(error, { admission: call?.admission ? "attempted" : "not-admitted", settlement: settled ? "settled" : "unknown" });
      if (registered?.admissionId) records.set(registered.admissionId, { owner, inspection: {
        evidence: freezeEvidence({ ...registered, nativeOutcome: "unknown", localOutcome: "rejected" }),
        call: settled ? "settled" : "unknown", capacity: settled ? "settled" : "unknown", cleanup: call?.release === "released" ? "released" : "unknown",
      } });
      // Refusal before any native launch leaves nothing owned; anything else closes admission.
      if (!settled || (call?.failure && call.failure !== "not-admitted" && call.failure !== "rate-limited")) close();
      pending.reject(error);
    } finally {
      if (run && !finalized) { try { run.close(); } catch { close(); } }
      if (run) running.delete(run);
      active--; runningPriorities.splice(runningPriorities.indexOf(pending.priority), 1);
      pump();
    }
  };
  const provider: LLMProvider = {
    id: "subscription-decisions", nativeOwnership: "required-prewrite",
    completionLifecycle: { kind: "session",
      admission: ({ result, error }) => { const value = result ?? error; return value && typeof value === "object" ? outcomes.get(value)?.admission ?? "unknown" : "unknown"; },
      settlement: ({ result, error }) => { const value = result ?? error; return value && typeof value === "object" ? outcomes.get(value)?.settlement ?? "unknown" : "unknown"; },
      inspectOwnedAdmission: async (owner, id) => { const record = find(owner, id); return record && freezeEvidence(record.inspection); },
      releaseOwnedAdmission: async (owner, id) => { const record = find(owner, id); return record ? record.inspection.cleanup === "released" ? "released" : "unknown" : "unavailable"; },
    },
    complete(messages, opts = {}) {
      if (closed || attempts >= config.maxCalls) return Promise.reject(reject("Subscription decision admission closed or full"));
      const priority = opts.priority ?? DECISION_PRIORITY.turn;
      if (!Number.isFinite(priority)) return Promise.reject(reject("Subscription decision priority refused"));
      const thread = (opts.nativeObservation?.owner?.threadId ?? opts.threadId ?? "decision").split(":aux:")[0]!;
      // Full queues shed the oldest lower-priority wait (thread first, then global) instead of refusing a more urgent call.
      for (const [scope, limit] of [[queue.filter(p => p.thread === thread), maxQueuedPerThread], [queue, config.maxQueued]] as const) {
        if (scope.length < limit) continue;
        const lowest = Math.min(...scope.map(p => p.priority));
        const victim = lowest < priority ? scope.find(p => p.priority === lowest) : undefined;
        if (!victim) return Promise.reject(reject("Subscription decision admission closed or full"));
        queue.splice(queue.indexOf(victim), 1); clearTimeout(victim.timer); shed++;
        victim.reject(reject("Subscription decision shed under load; no fallback or retry"));
        pressure({ kind: "shed", threadId: victim.thread, priority: victim.priority, queued: queue.length });
      }
      if ((opts.model && opts.model !== config.model) || opts.tools === true || opts.toolDefinitions?.length || opts.nativeObservation?.bridge
        || (opts.maxTurns !== undefined && opts.maxTurns !== 1) || (opts.timeout !== undefined && (!Number.isSafeInteger(opts.timeout) || (opts.timeout !== 0 && opts.timeout < 100))))
        return Promise.reject(reject("Subscription decision scope or model refused"));
      const id = crypto.randomUUID(), threadId = opts.threadId ?? `decision:${id}`;
      const owner = freezeEvidence({ ...(opts.nativeObservation?.owner ?? { threadId, generation: id, dispatchId: id }), providerSessionKey: threadId });
      const options = { ...opts, ...(opts.nativeObservation ? { nativeObservation: { ...opts.nativeObservation, owner } } : {}) };
      return new Promise((resolve, rejectCall) => {
        const pending: Pending = { messages: structuredClone(messages), opts: options, owner, priority, thread, seq: ++seq,
          deadline: Date.now() + Math.min(opts.timeout || config.callTimeoutMs, config.callTimeoutMs), resolve, reject: rejectCall,
          timer: setTimeout(() => {
            const index = queue.indexOf(pending);
            if (index >= 0) { queue.splice(index, 1); rejectCall(reject("Subscription decision expired in queue")); }
          }, Math.min(opts.timeout || config.callTimeoutMs, config.callTimeoutMs)) };
        queue.push(pending);
        pump();
      });
    },
  };
  /** Shutdown: close admission, stop active runs and wait (bounded) for their settlement. */
  const shutdown = async (timeoutMs = 5_000) => {
    close(); clearTimeout(backoffTimer);
    for (const run of running) { try { run.close(); } catch { /* Settlement below still bounds shutdown. */ } }
    for (const deadline = Date.now() + timeoutMs; active && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 20));
  };
  return { provider, close, shutdown, snapshot: () => ({ closed, active: active > 0, running: active, queued: queue.length, attempts, shed,
    ...(backoffUntil > Date.now() ? { backoffUntil } : {}) }) };
}
