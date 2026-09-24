import type { ContextSource, OwnershipScope, SourceLoadHint } from '@inixiative/foundry-core';
import { tokenCount } from '@inixiative/session-archive';
import { z } from 'zod';
import type { CredentialResolver } from '@inixiative/foundry-core';
import { credentialReferenceSchema, FoundryCredentials } from '../providers/credentials';
import { archiveRequest } from './publish';

export const archiveContextSchema = z
  .strictObject({
    projectId: z.string().min(1),
    kind: z.enum(['archive', 'kingdom']).optional(),
    kastleId: z.uuid().optional(),
    keepId: z.uuid().optional(),
    tokenEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]+$/)
      .optional(),
    credential: credentialReferenceSchema.optional(),
    connectionId: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    budget: z.number().int().min(128).max(16000).default(2048),
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.tokenEnv) === Boolean(value.credential))
      ctx.addIssue({ code: 'custom', message: 'Choose exactly one credential source' });
    if (value.kind === 'archive' && (value.credential?.type === 'kingdom-runtime' || value.connectionId))
      ctx.addIssue({ code: 'custom', message: 'Runtime credentials and connections require Kingdom' });
    if (value.connectionId && value.keepId)
      ctx.addIssue({ code: 'custom', message: 'Remote archives do not support Keeps' });
    if (value.kind !== 'archive' && !value.kastleId)
      ctx.addIssue({ code: 'custom', message: 'Kingdom archive sources require kastleId' });
    if (value.kind === 'archive' && (value.kastleId || value.keepId))
      ctx.addIssue({ code: 'custom', message: 'Standalone sources do not use Kastles or Keeps' });
  });
const resultSchema = z.object({
  data: z.object({
    archives: z.array(
      z.object({
        archiveId: z.union([z.uuid(), z.string().regex(/^[a-f0-9]{64}$/)]),
        revision: z.number().int(),
        digest: z.string(),
        title: z.string(),
        chunks: z.array(
          z.object({
            entryId: z.string(),
            sourceRef: z.string(),
            start: z.number().int(),
            end: z.number().int(),
            text: z.string(),
          }),
        ),
      }),
    ),
  }),
});

export class ArchiveContextSource implements ContextSource {
  readonly focusable = true;
  constructor(
    readonly id: string,
    private readonly url: string,
    private readonly config: z.infer<typeof archiveContextSchema>,
    private readonly owner?: OwnershipScope,
    private readonly transport: typeof fetch = fetch,
    private readonly credentials: CredentialResolver = new FoundryCredentials(),
  ) {}
  bind(scope: OwnershipScope): ContextSource {
    return new ArchiveContextSource(this.id, this.url, this.config, scope, this.transport, this.credentials);
  }
  async load(hint?: SourceLoadHint): Promise<string> {
    if (!this.owner?.projectId || this.owner.projectId !== this.config.projectId) return '';
    const result = resultSchema.parse(
      await archiveRequest(
        {
          ...this.config,
          url: this.url,
          keepIds: [],
          ...(this.config.kind === 'archive'
            ? { kind: 'archive' as const }
            : { kastleId: this.config.kastleId! }),
        },
        'search',
        {
          ...(this.config.kind === 'archive'
            ? { projectId: this.config.projectId }
            : { kastleId: this.config.kastleId, keepId: this.config.keepId }),
          query: hint?.focus?.slice(0, 1000) ?? '',
          budget: this.config.budget,
        },
        this.transport,
        this.credentials,
      ),
    );
    const records: unknown[] = [];
    for (const archive of result.data.archives)
      for (const chunk of archive.chunks) {
        const entry = {
          archiveId: archive.archiveId,
          revision: archive.revision,
          digest: archive.digest,
          title: archive.title,
          ...chunk,
        };
        if (
          tokenCount(JSON.stringify({ kind: 'historical-session-evidence', records: [...records, entry] })) <=
          this.config.budget
        )
          records.push(entry);
      }
    return records.length ? JSON.stringify({ kind: 'historical-session-evidence', records }) : '';
  }
}
