import { archiveSnapshotSchema } from '@inixiative/archive';
import type { ArchiveClient } from '@inixiative/archive/remote';
import type { RuntimeJob, RuntimeJobState } from './runtime-job-contracts';

/** Records the job in the local Archive; skipped when none is set up, a failed write throws. */
export async function archiveRuntimeJob(
  job: RuntimeJob,
  state: RuntimeJobState,
  title: string,
  archive: ArchiveClient | undefined,
) {
  if (!archive) return;
  const evidence = state.outcome ?? {};
  await archive.capture(
    archiveSnapshotSchema.parse({
      schemaVersion: 1,
      sourceId: await archive.sourceId(),
      source: 'foundry',
      sessionId: job.id,
      title,
      tags: ['Agentic', 'Signet'],
      goalIds: [],
      runIds: [job.id],
      capturedAt: Date.now(),
      coverage: {
        reasoning: 'unavailable',
        completeness: 'partial',
        omissions: [
          'Lifecycle receipts only; note bodies, credentials and private reasoning excluded',
        ],
      },
      entries: [
        {
          id: 'outcome',
          kind: 'event',
          text: JSON.stringify({
            jobId: job.id,
            installationId: job.installationId,
            signetId: state.signetId,
            status: state.phase,
            evidence,
          }),
          timestamp: Date.now(),
          sourceRef: `runtime-job:${job.id}`,
        },
      ],
    }),
  );
}
