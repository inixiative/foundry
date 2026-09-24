import { freezeEvidence, sameNativeOwner, type CompletionOpts, type CompletionResult, type LLMMessage, type LLMProvider, type NativeEvidence, type NativeOwner, type OwnedAdmissionInspection } from "@inixiative/foundry-core";
import { createNativeTextProvider, type NativeTextConfig } from "./native-text-provider";
import { createCodexTextProvider } from "./codex-text-provider";

export interface SubscriptionDecisionConfig extends Omit<NativeTextConfig, "runId" | "maxCalls"> {
  maxCalls: number;
  maxQueued: number;
  callTimeoutMs: number;
}
type TextRun = Pick<ReturnType<typeof createNativeTextProvider>, "provider" | "snapshot" | "close">;
type Outcome = { admission: "not-admitted" | "attempted" | "unknown"; settlement: "settled" | "unknown" };
type Record = { owner: NativeOwner; inspection: OwnedAdmissionInspection };
type Pending = { messages: LLMMessage[]; opts: CompletionOpts; owner: NativeOwner; deadline: number;
  resolve(value: CompletionResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** Decisions run on the decision profile's own runtime: Codex exec or text-only Claude. */
export function createSubscriptionDecisions(config: SubscriptionDecisionConfig) {
  return buildSubscriptionDecisions(config, config.source.runtime === "codex" ? createCodexTextProvider : createNativeTextProvider);
}

export function buildSubscriptionDecisions(config: SubscriptionDecisionConfig, createRun: (config: NativeTextConfig) => TextRun) {
  config = structuredClone(config);
  if (!Number.isSafeInteger(config.maxCalls) || config.maxCalls < 1 || config.maxCalls > 10_000
    || !Number.isSafeInteger(config.maxQueued) || config.maxQueued < 1 || config.maxQueued > 128
    || !Number.isSafeInteger(config.callTimeoutMs) || config.callTimeoutMs < 100 || config.callTimeoutMs > 30_000)
    throw Error("Invalid subscription decision bounds");
  const queue: Pending[] = [], records = new Map<string, Record>(), outcomes = new WeakMap<object, Outcome>();
  let active = false, closed = false, attempts = 0, current: TextRun | undefined;
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
  const pump = async () => {
    if (active || closed) return;
    const pending = queue.shift();
    if (!pending) return;
    active = true;
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
      run = current = createRun({ ...config, runId: crypto.randomUUID(), maxCalls: 1,
        callTimeoutMs: Math.min(config.callTimeoutMs, pending.deadline - Date.now()) });
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
      pending.resolve(completion);
    } catch {
      const call = run?.snapshot().calls[0];
      const settled = !call || (call.processExit !== "pending" && call.statusProcessExit !== "pending"
        && (call.processExit === "not-started" || call.release === "released"));
      const error = Error("Subscription decision failed; no fallback or retry");
      outcomes.set(error, { admission: call?.admission ? "attempted" : "not-admitted", settlement: settled ? "settled" : "unknown" });
      if (registered?.admissionId) records.set(registered.admissionId, { owner, inspection: {
        evidence: freezeEvidence({ ...registered, nativeOutcome: "unknown", localOutcome: "rejected" }),
        call: settled ? "settled" : "unknown", capacity: settled ? "settled" : "unknown", cleanup: call?.release === "released" ? "released" : "unknown",
      } });
      if (!settled || call?.failure) close();
      pending.reject(error);
    } finally {
      if (run && !finalized) { try { run.close(); } catch { close(); } }
      active = false; current = undefined;
      void pump();
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
      if (closed || attempts >= config.maxCalls || queue.length >= config.maxQueued) return Promise.reject(reject("Subscription decision admission closed or full"));
      if ((opts.model && opts.model !== config.model) || opts.tools === true || opts.toolDefinitions?.length || opts.nativeObservation?.bridge
        || (opts.maxTurns !== undefined && opts.maxTurns !== 1) || (opts.timeout !== undefined && (!Number.isSafeInteger(opts.timeout) || (opts.timeout !== 0 && opts.timeout < 100))))
        return Promise.reject(reject("Subscription decision scope or model refused"));
      const id = crypto.randomUUID(), threadId = opts.threadId ?? `decision:${id}`;
      const owner = freezeEvidence({ ...(opts.nativeObservation?.owner ?? { threadId, generation: id, dispatchId: id }), providerSessionKey: threadId });
      const options = { ...opts, ...(opts.nativeObservation ? { nativeObservation: { ...opts.nativeObservation, owner } } : {}) };
      return new Promise((resolve, rejectCall) => {
        const pending: Pending = { messages: structuredClone(messages), opts: options, owner,
          deadline: Date.now() + Math.min(opts.timeout || config.callTimeoutMs, config.callTimeoutMs), resolve, reject: rejectCall,
          timer: setTimeout(() => {
            const index = queue.indexOf(pending);
            if (index >= 0) { queue.splice(index, 1); rejectCall(reject("Subscription decision expired in queue")); }
          }, Math.min(opts.timeout || config.callTimeoutMs, config.callTimeoutMs)) };
        queue.push(pending);
        void pump();
      });
    },
  };
  /** Shutdown: close admission, stop the active run and wait (bounded) for its settlement. */
  const shutdown = async (timeoutMs = 5_000) => {
    close();
    try { current?.close(); } catch { /* Settlement below still bounds shutdown. */ }
    for (const deadline = Date.now() + timeoutMs; active && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 20));
  };
  return { provider, close, shutdown, snapshot: () => ({ closed, active, queued: queue.length, attempts }) };
}
