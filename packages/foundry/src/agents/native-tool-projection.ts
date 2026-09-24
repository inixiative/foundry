import { sameNativeOwner, type NativeEvidence, type NativeOwner, type ToolCallObservation } from "@inixiative/foundry-core";

/**
 * Project owned public native tool events into the dispatch's ordinary tool observation
 * channel (`ExecuteMeta.observeTool`), so the runtime's post-review input sees what the
 * native engine actually ran, through the one existing correlation path.
 *
 * Ownership is established in two steps that mirror the actual provider boundary:
 * - Registration carries the owner the provider admitted. The dispatch knows its logical owner
 *   (thread, project, generation, message, dispatch) before the provider adds the pool key
 *   (`providerSessionKey`), so registration is accepted when every logical field matches, the
 *   pool key (if present) is the expected central pool, and no review-job identity is attached.
 *   The full registered owner, including the pool key, is then captured per admission.
 * - Every later tool event must match that captured owner exactly (`sameNativeOwner`, all
 *   fields) and name a registered admission. Nothing is globally relaxed.
 *
 * All other rules are fail-closed: foreign, mismatched-generation, foreign-pool, review-owned
 * or unregistered events are counted and dropped; identity is the native call id, else the item
 * id (a logical id, never presented as a call id); one observation per identity (first begin
 * wins, orphan/mismatched results and later duplicates dropped); omitted output stays an explicit
 * omission, `ok` is only what the event states, an error without public text is labelled
 * unavailable. This never writes the journal; callers project only after the raw journal write.
 */
export interface NativeToolProjectorDiagnostics {
  projected: number; duplicates: number; unmatched: number; foreign: number; unregistered: number; identityMissing: number;
}
export interface NativeToolProjector {
  register(evidence: NativeEvidence): void;
  observe(evidence: NativeEvidence): void;
  readonly diagnostics: Readonly<NativeToolProjectorDiagnostics>;
}

const LOGICAL_OWNER_FIELDS = ["threadId", "projectId", "generation", "messageId", "dispatchId"] as const;

/** The dispatch's logical owner matches, the pool (when the provider has named it) is the expected one, and no review job owns it. */
export function admittedForDispatch(candidate: NativeOwner | undefined, owner: NativeOwner, expectedPool: string): boolean {
  if (!candidate) return false;
  if (!LOGICAL_OWNER_FIELDS.every(key => candidate[key] === owner[key])) return false;
  if (candidate.reviewJobId !== undefined || owner.reviewJobId !== undefined) return false;
  if (candidate.providerSessionKey !== undefined && candidate.providerSessionKey !== expectedPool) return false;
  if (owner.providerSessionKey !== undefined && owner.providerSessionKey !== expectedPool) return false;
  return true;
}

export function createNativeToolProjector(options: { owner: NativeOwner; expectedPool?: string; observeTool: (observation: ToolCallObservation) => void; now?: () => number }): NativeToolProjector {
  const now = options.now ?? (() => Date.now());
  const expectedPool = options.expectedPool ?? options.owner.providerSessionKey ?? options.owner.threadId;
  /** Registered admissions and the exact owner the provider admitted them with. */
  const admissions = new Map<string, NativeOwner>();
  const begins = new Map<string, NativeEvidence>();
  const ended = new Set<string>();
  const diagnostics: NativeToolProjectorDiagnostics = { projected: 0, duplicates: 0, unmatched: 0, foreign: 0, unregistered: 0, identityMissing: 0 };
  let sequence = 0;
  const identity = (e: NativeEvidence) => e.callId ? `call:${e.callId}` : e.itemId ? `item:${e.itemId}` : undefined;
  return {
    diagnostics,
    register(evidence) {
      if (!admittedForDispatch(evidence.owner, options.owner, expectedPool)) { diagnostics.foreign++; return; }
      if (!evidence.admissionId) return;
      // First registration of an admission fixes its exact owner; a re-registration must agree.
      const known = admissions.get(evidence.admissionId);
      if (known && !sameNativeOwner(known, evidence.owner)) { diagnostics.foreign++; return; }
      if (!known) admissions.set(evidence.admissionId, evidence.owner!);
    },
    observe(evidence) {
      if (evidence.kind !== "tool_use" && evidence.kind !== "tool_result") return;
      const registered = evidence.admissionId ? admissions.get(evidence.admissionId) : undefined;
      if (!registered) {
        // Unregistered admission: distinguish a foreign owner from a missing registration in diagnostics.
        if (!admittedForDispatch(evidence.owner, options.owner, expectedPool)) diagnostics.foreign++; else diagnostics.unregistered++;
        return;
      }
      if (!sameNativeOwner(evidence.owner, registered)) { diagnostics.foreign++; return; }
      const id = identity(evidence);
      if (!id) { diagnostics.identityMissing++; return; }
      const key = `${evidence.admissionId} ${id}`;
      if (evidence.kind === "tool_use") { if (!begins.has(key)) begins.set(key, evidence); else diagnostics.duplicates++; return; }
      if (ended.has(key)) { diagnostics.duplicates++; return; }
      const begin = begins.get(key);
      if (!begin?.toolName || (evidence.toolName && evidence.toolName !== begin.toolName) || (evidence.toolServer && begin.toolServer && evidence.toolServer !== begin.toolServer)) { diagnostics.unmatched++; return; }
      ended.add(key);
      const tool = begin.toolServer ? `${begin.toolServer}/${begin.toolName}` : begin.toolName;
      let inputSummary: string;
      if (begin.toolInputOmitted) inputSummary = `[public tool input omitted: ${begin.toolInputOmitted}]`;
      else { try { inputSummary = JSON.stringify(begin.toolInput ?? {}) ?? "{}"; } catch { inputSummary = "[unserializable tool input]"; } }
      const omittedTypes = evidence.toolOutputOmittedTypes?.length ? ` (${evidence.toolOutputOmittedTypes.join(", ")})` : "";
      const outputSummary = evidence.toolOutput ?? (evidence.toolOutputOmitted ? `[public non-text result omitted${omittedTypes}]` : undefined);
      const started = begin.observedAt ?? evidence.observedAt ?? now();
      const finished = evidence.observedAt ?? now();
      options.observeTool({
        // A native item without a call id keeps the `item:` prefix: a logical observation id, not a native call id.
        callId: evidence.callId ?? begin.callId ?? id,
        tool, inputSummary,
        ...(evidence.toolError !== undefined ? { ok: !evidence.toolError } : {}),
        ...(outputSummary !== undefined ? { outputSummary } : {}),
        ...(evidence.toolError === true ? { error: evidence.toolOutput ?? "[public error text unavailable]" } : {}),
        durationMs: Math.max(0, finished - started),
        sequence: ++sequence,
      });
      diagnostics.projected++;
    },
  };
}
