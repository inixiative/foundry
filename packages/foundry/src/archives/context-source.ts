import { tokenCount } from '@inixiative/archive';
import { localArchive } from '@inixiative/archive/remote';
import type { ContextSource, OwnershipScope, SourceLoadHint } from '@inixiative/foundry-core';
import { z } from 'zod';
import type { ArchiveConnector } from './local';

export const archiveContextSchema = z.strictObject({
  projectId: z.string().min(1),
  budget: z.number().int().min(128).max(16000).default(2048),
});

/** Historical session evidence for the bound project, searched in the local Archive. */
export class ArchiveContextSource implements ContextSource {
  readonly focusable = true;
  constructor(
    readonly id: string,
    private readonly config: z.infer<typeof archiveContextSchema>,
    private readonly owner?: OwnershipScope,
    private readonly connect: ArchiveConnector = () => localArchive(),
  ) {}
  bind(scope: OwnershipScope): ContextSource {
    return new ArchiveContextSource(this.id, this.config, scope, this.connect);
  }
  async load(hint?: SourceLoadHint): Promise<string> {
    if (!this.owner?.projectId || this.owner.projectId !== this.config.projectId) return '';
    const archive = this.connect();
    if (!archive) return '';
    const result = await archive.search({
      projectId: this.config.projectId,
      query: hint?.focus?.slice(0, 1000) ?? '',
      budget: this.config.budget,
    });
    const records: unknown[] = [];
    for (const found of result.archives)
      for (const { entryId, sourceRef, start, end, text } of found.chunks) {
        const entry = {
          archiveId: found.archiveId,
          revision: found.revision,
          digest: found.digest,
          title: found.title,
          entryId,
          sourceRef,
          start,
          end,
          text,
        };
        if (
          tokenCount(
            JSON.stringify({ kind: 'historical-session-evidence', records: [...records, entry] }),
          ) <= this.config.budget
        )
          records.push(entry);
      }
    return records.length ? JSON.stringify({ kind: 'historical-session-evidence', records }) : '';
  }
}
