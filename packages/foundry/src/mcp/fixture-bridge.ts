import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { freezeEvidence, sameNativeOwner, type Thread, type NativeBridgeSource, type NativeBridgeLease, type NativeEvidence, type NativeOwner, type NativeToolEvidence, type NativeToolRecord } from "@inixiative/foundry-core";
import type { ThreadRuntimeManager } from "../agents/thread-runtime";
import { assertPrivateProfile } from "../providers/private-profile";
import { bindLiveAuthority } from "./authority";
import { createLiveBridge } from "./transport";
import type { FoundryMcp, ToolInvocationRecord } from "./server";
import type { NativeToolJournal } from "./native-bridge";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const path = z.string().max(256).regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/).refine(value => value.split("/").length <= 9);
const inputs = {
  fixture_read: z.object({ path }).strict(),
  fixture_write: z.object({ path, content: z.string().refine(value => Buffer.byteLength(value) <= 262144) }).strict(),
  fixture_command: z.object({ command: z.string().min(1).max(8000) }).strict(),
};
export type FixtureRequest = { id: string } & ({ kind: "read"; path: string } | { kind: "write"; path: string; content: string } | { kind: "command"; command: string });
export interface FixtureResult { id: string; status: "completed" | "denied" | "failed"; exitCode?: number; output?: string; stderr?: string }
export interface FixtureBridgeOptions {
  thread: Thread;
  runtime: ThreadRuntimeManager;
  /** Trusted owner-selected immutable inventory, image and bounds. Never tool arguments. */
  descriptor: { armId: string; inventoryHash: string; image: string; maxCalls: number; timeoutMs: number; deadlineAt: number };
  launchRoot: string;
  invoke(request: Readonly<FixtureRequest>): Promise<FixtureResult>;
  journal: NativeToolJournal;
}

/** Fixed fixture operations only. The caller wires authorize into the broker's
 * structural guard; no model/domain guard runs in this pre-execution callback.
 * The Lab owner retains broker seal/close authority, never the MCP client. */
export function fixtureBridgeSource(options: FixtureBridgeOptions) {
  const { thread, runtime, invoke, journal } = options;
  const pinned = runtime.get(thread.id);
  if (!pinned || pinned.thread !== thread || pinned.disposed) throw Error("Fixture bridge requires the registered runtime");
  const launchRoot = options.launchRoot;
  assertPrivateProfile(launchRoot);
  const descriptor = z.object({ armId: z.string().uuid(), inventoryHash: z.string().regex(/^[a-f0-9]{64}$/), image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    maxCalls: z.number().int().min(1).max(80), timeoutMs: z.number().int().min(100).max(30000), deadlineAt: z.number().int() }).strict().parse(options.descriptor);
  if (descriptor.deadlineAt <= Date.now() || descriptor.deadlineAt > Date.now() + 900000) throw Error("Invalid fixture lifetime");
  const owner = freezeEvidence({ threadId: thread.id, projectId: thread.meta.projectId, generation: pinned.generation });
  const toolPolicy = freezeEvidence({ version: "isolated-fixture-v1" as const, digest: sha(JSON.stringify({ schema: 1, owner, ...descriptor, operations: Object.keys(inputs) })) });
  let acquired = false, closed = false, active: NativeEvidence | undefined;
  const permitted = new Map<string, { hash: string; admissionId: string; owner: NativeOwner; used: boolean }>();
  const check = () => {
    if (closed || thread.disposed || pinned.disposed || runtime.get(thread.id) !== pinned || thread.meta.projectId !== owner.projectId || Date.now() >= descriptor.deadlineAt)
      throw Error("Fixture authority expired or revoked");
  };
  const checkAdmission = (captured: NativeEvidence | undefined) => {
    check();
    if (!captured?.admissionId || !captured.owner || active?.admissionId !== captured.admissionId || !sameNativeOwner(active.owner, captured.owner)) throw Error("Fixture active admission required");
  };
  const authorize = async (request: Readonly<FixtureRequest>): Promise<"allow" | "deny"> => {
    try {
      const grant = permitted.get(request.id);
      if (!grant || grant.used || grant.hash !== sha(JSON.stringify(request))) return "deny";
      checkAdmission(active);
      if (active!.admissionId !== grant.admissionId || !sameNativeOwner(active!.owner, grant.owner)) return "deny";
      grant.used = true;
      return "allow";
    } catch { return "deny"; }
  };
  const source: NativeBridgeSource = Object.freeze({ key: randomUUID(), toolPolicy,
    check(candidate: NativeOwner) {
      check();
      if (candidate.threadId !== owner.threadId || candidate.projectId !== owner.projectId || candidate.generation !== owner.generation) throw Error("Fixture owner mismatch");
    },
    async acquire(): Promise<NativeBridgeLease> {
      check();
      if (acquired) throw Error("Fixture source already owns a native process; use a fresh arm");
      acquired = true;
      const id = randomUUID(), name = `fixture_${id.replaceAll("-", "")}`;
      const cwd = mkdtempSync(join(launchRoot, "fixture-native-"));
      const records = new Map<string, NativeToolEvidence>(), admissions = new Set<string>(), replay = new Set<string>();
      let pending = 0, attempts = 0, cleanupFailures = 0, evictedRecords = 0;
      const createMcp = (): FoundryMcp => {
        const authority = bindLiveAuthority({ thread, runtime });
        const server = new McpServer({ name, version: "1" });
        const retained: ToolInvocationRecord[] = [], listeners = new Set<(record: ToolInvocationRecord) => void>();
        server.server.registerCapabilities({ tools: {} });
        server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Object.entries(inputs).map(([name, schema]) => ({ name, description: `Isolated fixture ${name.slice(8)}`, inputSchema: z.toJSONSchema(schema) as any })) }));
        server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
          const invocationId = randomUUID(), startedAt = Date.now(), captured = active ? freezeEvidence(active) : undefined;
          const operation = request.params.name;
          const association: NativeToolRecord["association"] = captured
            ? { kind: "registered-admission-window", admissionId: captured.admissionId, owner: captured.owner } : { kind: "unassociated" };
          let status: "ok" | "refused" | "error" = "refused", result = "", dispatched = false;
          const finish = () => {
            const body = JSON.stringify({ id: invocationId, sdkRequestId: extra.requestId, status, dispatched, ...(result ? { result } : {}) });
            const record: NativeToolRecord = freezeEvidence({ id: invocationId, bridgeId: id, operation, owner, association,
              sdkRequestId: extra.requestId, sdkSessionId: extra.sessionId, nativeCorrelation: "unknown", startedAt, finishedAt: Date.now(),
              arguments: {}, result: body, digest: sha(body), status });
            try {
              const persisted = freezeEvidence(journal(record));
              if (JSON.stringify(persisted.record) !== JSON.stringify(record)) throw Error("Journal record mismatch");
              records.set(invocationId, persisted);
              if (persisted.persistence !== "committed") closed = true;
            }
            catch { records.set(invocationId, freezeEvidence({ record, persistence: "failed", publication: "reconciliation-needed", error: "fixture-tool-journal-failed" })); closed = true; }
            if (records.size > 2000) { records.delete(records.keys().next().value!); evictedRecords++; }
            const transportRecord: ToolInvocationRecord = freezeEvidence({ operation, owner: authority.scope(), generation: owner.generation,
              sdkRequestId: extra.requestId, sdkSessionId: extra.sessionId, startedAt, finishedAt: record.finishedAt, status, digest: record.digest, nativeCorrelation: "unknown",
              capture: { id: invocationId, bridgeId: id, association } });
            retained.push(transportRecord); if (retained.length > 200) retained.shift();
            for (const listener of listeners) { try { listener(transportRecord); } catch {} }
            const durable = records.get(invocationId)!.persistence === "committed";
            const delivered = durable ? body : JSON.stringify({ id: invocationId, sdkRequestId: extra.requestId, status: "error", dispatched, reason: "journal-unavailable" });
            return { isError: status !== "ok" || !durable, content: [{ type: "text" as const, text: delivered }] };
          };
          try {
            checkAdmission(captured);
            if (authority.check() || pending || attempts >= descriptor.maxCalls || replay.size >= 256) return finish();
            const replayKey = JSON.stringify([extra.sessionId, extra.requestId]);
            if (extra.requestId === undefined || replay.has(replayKey)) return finish();
            replay.add(replayKey);
            const schema = Object.hasOwn(inputs, operation) ? inputs[operation as keyof typeof inputs] : undefined;
            const parsed = schema?.safeParse(request.params.arguments);
            if (!parsed?.success) return finish();
            const tool = freezeEvidence({ id: invocationId, kind: operation.slice(8), ...parsed.data }) as FixtureRequest;
            permitted.set(invocationId, { hash: sha(JSON.stringify(tool)), admissionId: captured!.admissionId!, owner: captured!.owner!, used: false });
            attempts++; pending++;
            try {
              dispatched = true;
              let timer: ReturnType<typeof setTimeout> | undefined;
              const work = Promise.resolve().then(() => invoke(tool)).finally(() => { pending--; permitted.delete(invocationId); });
              // Keep the in-flight operation counted after a local deadline. The
              // trusted broker owns container cleanup; timeout is never release.
              let response: FixtureResult;
              const grant = permitted.get(invocationId)!;
              try {
                response = await Promise.race([work, new Promise<never>((_, reject) => {
                  timer = setTimeout(() => { closed = true; reject(Error("Fixture operation cleanup unknown")); }, Math.min(descriptor.timeoutMs, descriptor.deadlineAt - Date.now()) + 15000);
                })]);
              } finally { clearTimeout(timer); }
              if (!grant.used) throw Error("Fixture broker bypassed structural authorization");
              if (response.id !== invocationId || !["completed", "denied", "failed"].includes(response.status)) throw Error("Fixture broker evidence mismatch");
              checkAdmission(captured);
              if (authority.check()) throw Error("Fixture authority revoked after operation");
              const text = JSON.stringify(response);
              if (Buffer.byteLength(text) > 420000) throw Error("Fixture response cap");
              result = text; status = response.status === "completed" ? "ok" : response.status === "denied" ? "refused" : "error";
            } catch (error) { closed = true; throw error; }
          } catch { status = dispatched ? "error" : "refused"; }
          return finish();
        });
        return { server, authority, invocations: () => retained.slice(), diagnostics: () => ({ observerFailures: { synchronous: 0, asynchronous: 0 } }),
          onRecord(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
      };
      let bridge: Awaited<ReturnType<typeof createLiveBridge>>;
      try { bridge = await createLiveBridge({ serverName: name, createMcp, launchRoot, maxSessions: 1, maxBodyBytes: 400000 }); }
      catch (error) { closed = true; rmSync(cwd, { recursive: true, force: true }); throw error; }
      let closing: Promise<void> | undefined;
      const close = () => {
        closed = true;
        return closing ??= (async () => {
          await bridge.close();
          if (pending) { cleanupFailures++; throw Error("Fixture operation remains owned; cleanup unproved"); }
          rmSync(cwd, { recursive: true, force: true });
        })();
      };
      const unbind = thread.onDispose(() => { void close().catch(() => {}); });
      try { check(); } catch (error) { unbind(); await close(); throw error; }
      return Object.freeze({ id, name, owner, toolPolicy, fixtureCwd: cwd,
        configurationHash: sha(bridge.launch.claude.mcpConfigJson), launch: { claudeJson: bridge.launch.claude.mcpConfigJson, codexOverrides: [] },
        check() { check(); if (bridge.closed) throw Error("Fixture bridge closed"); },
        register(evidence: NativeEvidence) {
          source.check(evidence.owner!);
          if (!evidence.admissionId || active || pending || admissions.has(evidence.admissionId) || admissions.size >= descriptor.maxCalls) throw Error("Fixture admission refused");
          admissions.add(evidence.admissionId); active = freezeEvidence(evidence);
        },
        observe(evidence: NativeEvidence) {
          if (active && active.admissionId === evidence.admissionId && sameNativeOwner(active.owner, evidence.owner)
            && (evidence.nativeOutcome !== "unknown" || evidence.dispatch === "not-dispatched" && evidence.localOutcome === "rejected")) active = undefined;
        },
        evidence(admissionId?: string) { return Object.freeze([...records.values()].filter(value => admissionId === undefined || value.record.association.admissionId === admissionId)); },
        status() { const stats = bridge.stats(); return { closed, pendingCleanups: stats.pendingCleanups + pending, cleanupFailures: stats.cleanupFailures + cleanupFailures, evictedRecords }; },
        close() { unbind(); return close(); },
      });
    },
  });
  return { source, authorize };
}
