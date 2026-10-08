import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rmdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kingdomUrl, readPrivateJson, writePrivateJson } from '@inixiative/signet';
import { z } from 'zod';
import {
  KingdomClient,
  type KingdomSelection,
  kingdomEnvelopeSchema,
  kingdomSelectionSchema,
  ownerKey,
  ownerKeySchema,
} from './kingdom-client';
import { NativeAuthentication, type NativeAuthenticationLaunch } from './native-authentication';

/** A Signet this Foundry's integration holds, keyed by the Kingdom owner that granted it. */
export const kingdomInferenceSourceSchema = z
  .object({
    id: ownerKeySchema,
    url: z.string().transform(kingdomUrl),
    credentialFile: z.string().refine(isAbsolute),
    spreadId: z.string().uuid().optional(),
    selection: kingdomSelectionSchema.default({}),
  })
  .strict();
export const kingdomInferenceAssignmentSchema = z
  .object({
    ownerKey: ownerKeySchema,
    spreadId: z.string().uuid().optional(),
    selection: kingdomSelectionSchema.optional(),
  })
  .strict();
export type KingdomInferenceSource = z.infer<typeof kingdomInferenceSourceSchema>;
export type KingdomInferenceAssignment = z.infer<typeof kingdomInferenceAssignmentSchema>;
const storedSchema = z.object({
  fingerprint: z.string(),
  threadId: z.string(),
  runtime: z.enum(['claude', 'codex']),
  envelope: kingdomEnvelopeSchema,
});

export class KingdomAuthentication {
  private sources: Map<string, KingdomInferenceSource>;
  private bindings = new Map<
    string,
    {
      fingerprint: string;
      manager: NativeAuthentication;
      envelope: z.infer<typeof kingdomEnvelopeSchema>;
    }
  >();
  private pending = new Map<string, Promise<void>>();
  private assignments: Map<string, KingdomInferenceAssignment>;
  constructor(
    private options: {
      directory: string;
      sources: KingdomInferenceSource[];
      defaultOwnerKey?: string;
      assignments?: Record<string, KingdomInferenceAssignment>;
    },
  ) {
    this.options = { ...options };
    if (!isAbsolute(options.directory)) throw Error('Kingdom profile directory must be absolute');
    this.sources = new Map(
      options.sources.map((source) => {
        const parsed = kingdomInferenceSourceSchema.parse(source);
        return [parsed.id, parsed];
      }),
    );
    if (this.sources.size !== options.sources.length) throw Error('Duplicate Kingdom owner source');
    this.assignments = new Map(
      Object.entries(options.assignments ?? {}).map(([thread, assignment]) => [
        thread,
        kingdomInferenceAssignmentSchema.parse(assignment),
      ]),
    );
    if (options.defaultOwnerKey && !this.sources.has(options.defaultOwnerKey))
      throw Error('Unknown default Kingdom owner');
    for (const assignment of this.assignments.values())
      if (!this.sources.has(assignment.ownerKey)) throw Error('Unknown assigned Kingdom owner');
  }
  private selection(threadId: string) {
    const assignment = this.assignments.get(threadId);
    const id = assignment?.ownerKey ?? this.options.defaultOwnerKey;
    const source = id && this.sources.get(id);
    if (!source) throw Error('No Kingdom owner assigned to this thread');
    const selection: KingdomSelection = { ...source.selection, ...assignment?.selection };
    const spreadId = assignment?.spreadId ?? source.spreadId;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ source, selection, spreadId }))
      .digest('hex');
    return { source, selection, spreadId, fingerprint };
  }
  bindingId(threadId: string, runtime: 'claude' | 'codex') {
    const entry = this.bindings.get(`${runtime}:${threadId}`);
    if (!entry) throw Error('Kingdom binding has not been resolved yet');
    return entry.manager.bindingId(threadId, runtime);
  }
  async resolveBindingId(threadId: string, runtime: 'claude' | 'codex'): Promise<string> {
    const launch = await this.prepare(threadId, runtime);
    launch.release();
    return launch.bindingId;
  }
  async prepare(
    threadId: string,
    runtime: 'claude' | 'codex',
  ): Promise<NativeAuthenticationLaunch> {
    const key = `${runtime}:${threadId}`;
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.resolve(threadId, runtime).catch((error) => {
        this.pending.delete(key);
        throw error;
      });
      this.pending.set(key, pending);
    }
    await pending;
    const selected = this.selection(threadId),
      entry = this.bindings.get(key)!;
    if (entry.fingerprint !== selected.fingerprint)
      throw Error('Kingdom selection changed; create a new native run');
    const launch = await entry.manager.prepare(threadId, runtime);
    return Object.freeze({
      ...launch,
      model: entry.envelope.model,
      effort: entry.envelope.effort,
      capacityId: entry.envelope.capacityId,
    });
  }
  private async resolve(threadId: string, runtime: 'claude' | 'codex') {
    const { source, selection, spreadId, fingerprint } = this.selection(threadId);
    const directory = join(
      this.options.directory,
      createHash('sha256').update(`${runtime}:${threadId}`).digest('hex'),
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = join(directory, '.binding-lock');
    await mkdir(lock, { mode: 0o700 });
    try {
      const bindingFile = join(directory, 'binding.json'),
        credentialFile = join(directory, 'run-credential.json');
      let envelope: z.infer<typeof kingdomEnvelopeSchema>;
      if (existsSync(bindingFile)) {
        const stored = storedSchema.parse(await readPrivateJson(bindingFile));
        if (
          stored.fingerprint !== fingerprint ||
          stored.runtime !== runtime ||
          stored.threadId !== threadId
        )
          throw Error('Persisted Kingdom selection changed; use a new thread');
        envelope = stored.envelope;
      } else {
        const client = await KingdomClient.fromFile(source.credentialFile);
        if (client.origin !== source.url) throw Error('Kingdom Signet belongs to another Kingdom');
        const intentFile = join(directory, 'intent.json');
        let runId: string;
        if (existsSync(intentFile)) {
          const intent = z
            .object({ runId: z.string().uuid(), fingerprint: z.string() })
            .parse(await readPrivateJson(intentFile));
          if (intent.fingerprint !== fingerprint)
            throw Error('Kingdom run intent changed; use a new thread');
          runId = intent.runId;
        } else {
          runId = crypto.randomUUID();
          await writePrivateJson(intentFile, { runId, fingerprint });
        }
        envelope = await client.resolve(runId, selection, spreadId);
        if (ownerKey(envelope.owner) !== source.id)
          throw Error('Kingdom Signet belongs to another owner');
        if (envelope.runtime !== runtime)
          throw Error('Kingdom selected a different native runtime');
        const delegated = await client.delegate(envelope.id);
        await writePrivateJson(credentialFile, {
          url: source.url,
          bindingId: envelope.id,
          refreshCredential: delegated.secret,
          expiresAt: delegated.expiresAt,
        });
        await writePrivateJson(bindingFile, { fingerprint, threadId, runtime, envelope });
      }
      if (Date.parse(envelope.expiresAt) <= Date.now())
        throw Error('Persisted Kingdom run expired; start a new run');
      const manager = new NativeAuthentication({
        directory: join(directory, 'profiles'),
        defaultSourceId: envelope.id,
        sources: [
          {
            id: envelope.id,
            connectionId: envelope.integrationId,
            runtime,
            mode: 'gateway',
            baseUrl: `${source.url}${envelope.gatewayPath}`,
            credential: {
              type: 'command',
              command: process.execPath,
              args: [
                fileURLToPath(new URL('./kingdom-token-helper.ts', import.meta.url)),
                credentialFile,
              ],
              refreshIntervalMs: 60000,
            },
          },
        ],
      });
      this.bindings.set(`${runtime}:${threadId}`, { fingerprint, manager, envelope });
    } finally {
      await rmdir(lock);
    }
  }
}
