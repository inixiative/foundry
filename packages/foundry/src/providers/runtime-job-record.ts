import { join } from "node:path";
import { archiveRuntimeJob } from "./archive-runtime-job";
import { readPrivateJson, writePrivateJson } from "./kastle-credential-file";
import { jobStateSchema, type RuntimeJob, type RuntimeJobState } from "./runtime-job-contracts";
import type { RuntimeJobContext } from "./runtime-job-handler";

/** Resumable private phase state for a job, with its local Archive capture and Kingdom report. */
export class RuntimeJobRecord {
  state: RuntimeJobState | undefined;
  private constructor(private job: RuntimeJob, private context: RuntimeJobContext, private file: string, private title: string) {}
  static async open(job: RuntimeJob, context: RuntimeJobContext, title: string): Promise<RuntimeJobRecord> {
    const record = new RuntimeJobRecord(job, context, join(context.directory, "state.json"), title);
    try { record.state = jobStateSchema.parse(await readPrivateJson(record.file)); }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    return record;
  }
  /** A terminal state persisted by an earlier attempt whose archive or report did not complete. */
  get terminal(): boolean { return this.state?.phase === "finished" || this.state?.phase === "failed"; }
  async save(next: RuntimeJobState): Promise<void> { await writePrivateJson(this.file, next); this.state = next; }
  report(status: "awaitingApproval" | "running" | "completed" | "failed"): Promise<unknown> {
    return this.context.request("reportRuntimeJob", { jobId: this.job.id, status,
      ...(this.state?.requestId ? { requestId: this.state.requestId } : {}), ...(this.state?.outcome ? { outcome: this.state.outcome } : {}) });
  }
  /** Archives the terminal state, then reports it. Archive failure precedes any report. */
  async finish(): Promise<void> {
    const state = jobStateSchema.parse(this.state);
    await archiveRuntimeJob(this.context.runtimeDirectory, this.job, state, this.title);
    await this.report(state.phase === "finished" ? "completed" : "failed");
  }
}
