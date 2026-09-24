import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rmdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { NativeAuthentication, type NativeAuthenticationLaunch } from "./native-authentication";
import { KastleClient, kastleEnvelopeSchema, kastleSelectionSchema, kastleUrl, type KastleSelection } from "./kastle-client";
import { installationCredentialSchema, readPrivateJson, writePrivateJson } from "./kastle-credential-file";

export const kastleSourceSchema = z.object({ id: z.string().uuid(), url: z.string().transform(kastleUrl), credentialFile: z.string().refine(isAbsolute), spreadId: z.string().uuid().optional(), selection: kastleSelectionSchema.default({}) }).strict();
export const kastleAssignmentSchema = z.object({ kastleId: z.string().uuid(), spreadId: z.string().uuid().optional(), selection: kastleSelectionSchema.optional() }).strict();
export type KastleSource = z.infer<typeof kastleSourceSchema>;
export type KastleAssignment = z.infer<typeof kastleAssignmentSchema>;
const storedSchema = z.object({ fingerprint: z.string(), threadId: z.string(), runtime: z.enum(["claude", "codex"]), envelope: kastleEnvelopeSchema });

export class KastleAuthentication {
  private sources: Map<string, KastleSource>;
  private bindings = new Map<string, { fingerprint: string; manager: NativeAuthentication; envelope: z.infer<typeof kastleEnvelopeSchema> }>();
  private pending = new Map<string, Promise<void>>();
  private assignments: Map<string, KastleAssignment>;
  constructor(private options: { directory: string; sources: KastleSource[]; defaultKastleId?: string; assignments?: Record<string, KastleAssignment> }) {
    this.options = { ...options };
    if (!isAbsolute(options.directory)) throw Error("Kastle profile directory must be absolute");
    this.sources = new Map(options.sources.map(source => { const parsed = kastleSourceSchema.parse(source); return [parsed.id, parsed]; }));
    if (this.sources.size !== options.sources.length) throw Error("Duplicate Kastle source");
    this.assignments = new Map(Object.entries(options.assignments ?? {}).map(([thread, assignment]) => [thread, kastleAssignmentSchema.parse(assignment)]));
    if (options.defaultKastleId && !this.sources.has(options.defaultKastleId)) throw Error("Unknown default Kastle");
    for (const assignment of this.assignments.values()) if (!this.sources.has(assignment.kastleId)) throw Error("Unknown assigned Kastle");
  }
  private selection(threadId: string) {
    const assignment = this.assignments.get(threadId);
    const id = assignment?.kastleId ?? this.options.defaultKastleId;
    const source = id && this.sources.get(id);
    if (!source) throw Error("No Kastle assigned to this thread");
    const selection: KastleSelection = { ...source.selection, ...assignment?.selection };
    const spreadId = assignment?.spreadId ?? source.spreadId;
    const fingerprint = createHash("sha256").update(JSON.stringify({ source, selection, spreadId })).digest("hex");
    return { source, selection, spreadId, fingerprint };
  }
  bindingId(threadId: string, runtime: "claude" | "codex") {
    const entry = this.bindings.get(`${runtime}:${threadId}`);
    if (!entry) throw Error("Kastle binding has not been resolved yet");
    return entry.manager.bindingId(threadId, runtime);
  }
  async resolveBindingId(threadId: string, runtime: "claude" | "codex"): Promise<string> {
    const launch = await this.prepare(threadId, runtime);
    launch.release();
    return launch.bindingId;
  }
  async prepare(threadId: string, runtime: "claude" | "codex"): Promise<NativeAuthenticationLaunch> {
    const key = `${runtime}:${threadId}`;
    let pending = this.pending.get(key);
    if (!pending) { pending = this.resolve(threadId, runtime).catch(error => { this.pending.delete(key); throw error; }); this.pending.set(key, pending); }
    await pending;
    const selected = this.selection(threadId), entry = this.bindings.get(key)!;
    if (entry.fingerprint !== selected.fingerprint) throw Error("Kastle selection changed; create a new native run");
    const launch = await entry.manager.prepare(threadId, runtime);
    return Object.freeze({ ...launch, model: entry.envelope.model, effort: entry.envelope.effort, capacityId: entry.envelope.capacityId });
  }
  private async resolve(threadId: string, runtime: "claude" | "codex") {
    const { source, selection, spreadId, fingerprint } = this.selection(threadId);
    const directory = join(this.options.directory, createHash("sha256").update(`${runtime}:${threadId}`).digest("hex"));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = join(directory, ".binding-lock");
    await mkdir(lock, { mode: 0o700 });
    try {
      const bindingFile = join(directory, "binding.json"), credentialFile = join(directory, "run-credential.json");
      let envelope: z.infer<typeof kastleEnvelopeSchema>;
      if (existsSync(bindingFile)) {
        const stored = storedSchema.parse(await readPrivateJson(bindingFile));
        if (stored.fingerprint !== fingerprint || stored.runtime !== runtime || stored.threadId !== threadId) throw Error("Persisted Kastle selection changed; use a new thread");
        envelope = stored.envelope;
      } else {
        const installed = installationCredentialSchema.parse(await readPrivateJson(source.credentialFile));
        const client = new KastleClient(source.url, installed.secret);
        const intentFile = join(directory, "intent.json");
        let runId: string;
        if (existsSync(intentFile)) {
          const intent = z.object({ runId: z.string().uuid(), fingerprint: z.string() }).parse(await readPrivateJson(intentFile));
          if (intent.fingerprint !== fingerprint) throw Error("Kastle run intent changed; use a new thread");
          runId = intent.runId;
        } else {
          runId = crypto.randomUUID();
          await writePrivateJson(intentFile, { runId, fingerprint });
        }
        envelope = await client.resolve(runId, selection, spreadId);
        if (envelope.kastleId !== source.id) throw Error("Kastle installation belongs to another Kastle");
        if (envelope.runtime !== runtime) throw Error("Kastle selected a different native runtime");
        const delegated = await client.delegate(envelope.id);
        await writePrivateJson(credentialFile, { url: source.url, bindingId: envelope.id, refreshCredential: delegated.secret, expiresAt: delegated.expiresAt });
        await writePrivateJson(bindingFile, { fingerprint, threadId, runtime, envelope });
      }
      if (Date.parse(envelope.expiresAt) <= Date.now()) throw Error("Persisted Kastle run expired; start a new run");
      const manager = new NativeAuthentication({ directory: join(directory, "profiles"), defaultSourceId: envelope.id, sources: [{
        id: envelope.id, connectionId: envelope.connectionId, runtime, mode: "gateway", baseUrl: `${source.url}${envelope.gatewayPath}`,
        credential: { type: "command", command: process.execPath, args: [fileURLToPath(new URL("./kastle-token-helper.ts", import.meta.url)), credentialFile], refreshIntervalMs: 60000 },
      }] });
      this.bindings.set(`${runtime}:${threadId}`, { fingerprint, manager, envelope });
    } finally { await rmdir(lock); }
  }
}
