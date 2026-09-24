/** Public, owned projection. Raw protocol and reasoning are deliberately absent. */
export interface NativeOwner {
  readonly threadId: string;
  readonly projectId?: string;
  readonly generation: string;
  readonly messageId?: string;
  readonly dispatchId: string;
  readonly reviewJobId?: string;
  /** Foundry's provider pool key, distinct from every native identity. */
  readonly providerSessionKey?: string;
}
/** Compare typed ownership fields, not serialization order or prompt text. */
export function sameNativeOwner(a: NativeOwner | undefined, b: NativeOwner | undefined): boolean {
  return !!a && !!b && (["threadId", "projectId", "generation", "messageId", "dispatchId", "reviewJobId", "providerSessionKey"] as const)
    .every(key => a[key] === b[key]);
}
export interface OwnedAdmissionInspection {
  readonly evidence: NativeEvidence;
  /** Physical call settlement is independent of a native terminal and local waiter. */
  readonly call: "settled" | "pending" | "unknown";
  readonly cleanup: "not-requested" | "pending" | "released" | "unknown";
  readonly capacity: "settled" | "unknown";
}
export interface NativeEvidence {
  readonly schema: 1;
  readonly owner?: NativeOwner;
  readonly admissionId?: string;
  readonly nativeSessionId?: string;
  readonly externalSessionId?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly itemId?: string;
  readonly callId?: string;
  readonly rpcRequestId?: string | number;
  readonly nativeOutcome: "unknown" | "completed" | "failed";
  readonly localOutcome?: "pending" | "resolved" | "rejected";
  readonly dispatch?: "not-dispatched" | "attempted";
  readonly transportOutcome?: "open" | "failed" | "closed";
  readonly rpcOutcome?: "pending" | "resolved" | "failed" | "unknown";
  readonly localFailure?: string;
  readonly localError?: string;
  readonly observedAt?: number;
  readonly terminal?: Readonly<{ type: string; eventId?: string; turnId?: string; subtype?: string; reason?: string; apiErrorStatus?: number }>;
  readonly content?: string;
  readonly correlation?: string;
  readonly kind?: string;
  readonly toolName?: string;
  readonly toolServer?: string;
  readonly toolMethod?: string;
  readonly toolInput?: Readonly<Record<string, unknown>>;
  readonly toolInputOmitted?: string;
  readonly toolOutput?: string;
  readonly toolOutputOmitted?: boolean;
  /** tool_result only: exact public tool names from tool-search reference blocks, in order,
   * duplicates preserved, copied and frozen. Never a retrieval success by itself. */
  readonly toolReferences?: readonly string[];
  /** tool_result only: public allowlisted labels of omitted result blocks; unknown shapes are
   * "unsupported". Present only with toolOutputOmitted. */
  readonly toolOutputOmittedTypes?: readonly string[];
  readonly toolError?: boolean;
  readonly observationFailures?: number;
  readonly configuration?: Readonly<{ requestedModel: string; observedModel?: string; requestedMaxTurns?: number | null;
    engine?: "mcp" | "app-server"; requestedEffort?: string; observedEffort?: string | null;
    history?: Readonly<{source:"thread/start"|"thread/resume";available:boolean;hasMore:boolean;turns:readonly Readonly<{id:string;status:string}>[]}>;
    turnBudgetEnforcement: "launch-option" | "unavailable"; tokenBudget: "unavailable"; effortBudget: "unavailable" }>;
  readonly text?: string;
  /** Public text form only; reasoning is never projected. Missing phase is not a final-answer acknowledgment. */
  readonly textKind?: "delta" | "snapshot";
  readonly textPhase?: "commentary" | "final_answer";
  /** Safe setup/status evidence, never launch paths or config values. */
  readonly runtimeStatus?: Readonly<{ type: string; status?: string; reason?: string; server?: string; tools?: readonly string[] }>;
  readonly bridge?: { readonly id: string; readonly configurationHash: string; readonly tools: readonly NativeToolEvidence[] };
}
export interface NativeToolRecord {
  readonly id: string;
  readonly bridgeId: string;
  readonly operation: string;
  readonly owner: { readonly threadId: string; readonly projectId?: string; readonly generation: string };
  readonly association: { readonly kind: "registered-admission-window" | "unassociated"; readonly admissionId?: string; readonly owner?: NativeOwner };
  readonly sdkRequestId?: string | number;
  readonly sdkSessionId?: string;
  readonly nativeCorrelation: "unknown";
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly result: string;
  readonly digest: string;
  readonly status: string;
  readonly refusal?: string;
}
export interface NativeToolEvidence {
  readonly record: NativeToolRecord;
  readonly persistence: "pending" | "committed" | "failed";
  readonly publication: "pending" | "published" | "reconciliation-needed";
  readonly error?: string;
}
/** Process lifetime grant. Data/functions never become part of a provider prompt. */
export interface NativeBridgeSource {
  readonly key: string;
  check(owner: NativeOwner): void;
  acquire(): Promise<NativeBridgeLease>;
}
export interface NativeBridgeLease {
  readonly id: string;
  readonly name: string;
  readonly owner: { readonly threadId: string; readonly projectId?: string; readonly generation: string };
  readonly configurationHash: string;
  readonly launch: { readonly claudeJson: string; readonly codexOverrides: readonly string[] };
  check(): void;
  register(evidence: NativeEvidence): void;
  observe(evidence: NativeEvidence): void;
  evidence(admissionId?: string): readonly NativeToolEvidence[];
  status?(): Readonly<{ closed: boolean; pendingCleanups: number; cleanupFailures: number; evictedRecords: number }>;
  close(): Promise<void>;
}
export interface NativeObservation {
  readonly owner: NativeOwner;
  readonly bridge?: NativeBridgeSource;
  /** Durable capacity check before constructing/resuming a process. Registration still rechecks atomically. */
  preflight?(owner: NativeOwner): void | Promise<void>;
  /** Required registration. A failed write here must prevent native admission. */
  register(evidence: NativeEvidence): void | Promise<void>;
  /** Fallible observer; never vetoes executor completion. */
  observe(evidence: NativeEvidence): void | Promise<void>;
}
export function freezeEvidence<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (v: unknown) => { if (v && typeof v === "object" && !Object.isFrozen(v)) { for (const nested of Object.values(v)) freeze(nested); Object.freeze(v); } };
  freeze(copy); return copy;
}
