import { createHash, randomUUID } from "node:crypto";
import { freezeEvidence, type Thread, type ToolRegistry, type NativeBridgeSource, type NativeBridgeLease, type NativeEvidence, type NativeToolRecord, type NativeToolEvidence } from "@inixiative/foundry-core";
import type { ThreadRuntimeManager } from "../agents/thread-runtime";
import { createFoundryMcp } from "./server";
import { createLiveBridge } from "./transport";

export type NativeToolJournal = (record: NativeToolRecord) => NativeToolEvidence;

/** One stable source per viewer/live runtime; acquire is called only when the
 * provider constructs a new owned native process, never on a warm admission. */
export function nativeBridgeSource(thread: Thread, runtime: ThreadRuntimeManager, tools: ToolRegistry, journal: NativeToolJournal, deviceIdentityPath?: string): NativeBridgeSource {
  const pinned = runtime.get(thread.id);
  if (!pinned || pinned.thread !== thread || pinned.disposed) throw Error("Native tools require the actual live runtime");
  const owner = Object.freeze({ threadId: thread.id, projectId: thread.meta.projectId, generation: pinned.generation });
  const check = () => {
    if (thread.disposed || pinned.disposed || runtime.get(thread.id) !== pinned || thread.meta.projectId !== owner.projectId)
      throw Error("Native bridge owner is stale; no replacement or replay was admitted");
  };
  return Object.freeze<NativeBridgeSource>({
    key: randomUUID(),
    check: candidate => {
      check();
      if (candidate.threadId !== owner.threadId || candidate.projectId !== owner.projectId || candidate.generation !== owner.generation)
        throw Error("Native bridge ownership mismatch");
    },
    async acquire(): Promise<NativeBridgeLease> {
      check();
      const id = randomUUID(), name = `foundry_${id.replaceAll("-", "")}`;
      let active: NativeEvidence | undefined;
      const admissions = new Set<string>();
      const ownerFields = ["threadId", "projectId", "generation", "messageId", "dispatchId", "reviewJobId", "providerSessionKey"] as const;
      const records = new Map<string, NativeToolEvidence>();
      let evictedRecords = 0;
      const bridge = await createLiveBridge({ serverName: name, createMcp: () => createFoundryMcp({ thread, runtime, tools, deviceIdentityPath,
        captureOperation: () => freezeEvidence({ id: randomUUID(), bridgeId: id, association: active
          ? { kind: "registered-admission-window" as const, admissionId: active.admissionId, owner: active.owner }
          : { kind: "unassociated" as const } }),
        onInvocation: invocation => {
          if (!invocation.capture) return;
          const record: NativeToolRecord = freezeEvidence({ ...invocation.capture, owner, operation: invocation.operation,
            sdkRequestId: invocation.sdkRequestId, sdkSessionId: invocation.sdkSessionId,
            startedAt: invocation.startedAt, finishedAt: invocation.finishedAt, status: invocation.status, refusal: invocation.refusal,
            arguments: invocation.arguments ?? {}, result: invocation.result ?? "", digest: invocation.digest, nativeCorrelation: "unknown" });
          records.set(record.id, freezeEvidence({ record, persistence: "pending", publication: "pending" }));
          try { records.set(record.id, freezeEvidence(journal(record))); }
          catch { records.set(record.id, freezeEvidence({ record, persistence: "failed", publication: "reconciliation-needed", error: "tool-journal-failed" })); }
          // Journal is the durable history; this per-process inspection cache is bounded.
          if (records.size > 2000) { records.delete(records.keys().next().value!); evictedRecords++; }
        },
      }) });
      let unsubscribe: (() => void) | undefined;
      const close = () => { unsubscribe?.(); unsubscribe = undefined; return bridge.close(); };
      unsubscribe = thread.onDispose(() => { void close().catch(() => {}); });
      try { check(); } catch (error) { await close(); throw error; }
      return Object.freeze<NativeBridgeLease>({ id, name, owner,
        configurationHash: createHash("sha256").update(bridge.launch.claude.mcpConfigJson).digest("hex"),
        launch: Object.freeze({ claudeJson: bridge.launch.claude.mcpConfigJson, codexOverrides: bridge.launch.codex.configOverrides }),
        check() { check(); if (bridge.closed) throw Error("Owned native bridge is closed"); },
        register(evidence) {
          check(); if (bridge.closed) throw Error("Owned native bridge is closed");
          if (!evidence.admissionId || !evidence.owner || evidence.owner.threadId !== owner.threadId || evidence.owner.projectId !== owner.projectId || evidence.owner.generation !== owner.generation)
            throw Error("Native tool admission ownership mismatch");
          if (active && active.admissionId !== evidence.admissionId) throw Error("Previous native bridge admission is unresolved");
          if (admissions.has(evidence.admissionId)) throw Error("Native bridge admission is already registered");
          admissions.add(evidence.admissionId);
          active = freezeEvidence(evidence);
        },
        observe(evidence) {
          if (active?.admissionId === evidence.admissionId && active?.owner && evidence.owner
            && ownerFields.every(key => active!.owner![key] === evidence.owner![key])
            && (evidence.nativeOutcome !== "unknown" || (evidence.dispatch === "not-dispatched" && evidence.localOutcome === "rejected"))) active = undefined;
        },
        evidence(admissionId) { return Object.freeze([...records.values()].filter(e => admissionId === undefined || e.record.association.admissionId === admissionId)); },
        status() { const stats=bridge.stats();return Object.freeze({closed:bridge.closed,pendingCleanups:stats.pendingCleanups,cleanupFailures:stats.cleanupFailures,evictedRecords}); },
        close,
      });
    },
  });
}
