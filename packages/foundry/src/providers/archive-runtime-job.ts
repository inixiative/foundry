import { LocalArchiveStore } from "@inixiative/session-archive/local";
import { archiveSnapshotSchema } from "@inixiative/session-archive";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeJob, RuntimeJobState } from "./runtime-job-contracts";

export async function archiveRuntimeJob(directory: string, job: RuntimeJob, state: RuntimeJobState, title = "Foundry connection check") {
  await mkdir(join(directory, "archives"), { recursive: true, mode: 0o700 });
  const store = new LocalArchiveStore(join(directory, "archives", "archives.sqlite"));
  try {
    const { allergies: _allergies, ...evidence } = state.outcome ?? {};
    store.capture(archiveSnapshotSchema.parse({ schemaVersion: 1, sourceId: store.sourceId, source: "foundry", sessionId: job.id,
      title,
      tags: ["Agentic", "Signet"], goalIds: [], runIds: [job.id], capturedAt: Date.now(),
      coverage: { reasoning: "unavailable", completeness: "partial", omissions: ["Lifecycle receipts only; note bodies, credentials and private reasoning excluded"] },
      entries: [{ id: "outcome", kind: "event", text: JSON.stringify({ jobId: job.id, installationId: job.installationId, signetId: state.signetId, status: state.phase, evidence }), timestamp: Date.now(), sourceRef: `runtime-job:${job.id}` }],
    }));
  } finally { store.close(); }
}
