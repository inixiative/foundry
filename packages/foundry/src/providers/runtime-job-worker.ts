import { lockRuntimeJob } from "./runtime-job-lock";
import { lstat, mkdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { z } from "zod";
import { installationCredentialSchema, readPrivateJson } from "./kastle-credential-file";
import type { KingdomRuntimeSettings } from "./kingdom-runtime-connection";
import { kastleUrl } from "./kastle-client";
import { SignetHttpError } from "./signet-client";
import { runtimeJobSchema } from "./runtime-job-contracts";
import { RuntimeJobRegistry } from "./runtime-job-handler";

const REQUEST_TIMEOUT_MS = 20000;

export class RuntimeJobWorker {
  private busy = false;
  private stopped = false;
  constructor(private settings: KingdomRuntimeSettings, private transport: typeof fetch = fetch, private handlers: RuntimeJobRegistry = new RuntimeJobRegistry()) { this.settings = { ...settings, url: kastleUrl(settings.url) }; }
  stop() { this.stopped = true; }
  private async send(action: string, body: unknown, timeoutMs: number): Promise<unknown> {
    if (this.stopped) throw Error("Worker stopped");
    const { secret } = installationCredentialSchema.parse(await readPrivateJson(this.settings.credentialFile));
    const response = await this.transport(`${this.settings.url}/api/v1/access/${action}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify(body),
    });
    if (!response.ok) { await response.body?.cancel(); throw new SignetHttpError(response.status); }
    return z.object({ data: z.unknown() }).parse(await response.json()).data;
  }
  private request(action: "pollRuntimeJob" | "reportRuntimeJob" | "runtimeHeartbeat", body: unknown): Promise<unknown> {
    return this.send(action, body, REQUEST_TIMEOUT_MS);
  }
  async check() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try { await this.run(); } finally { this.busy = false; }
  }
  private async run() {
    const candidate = await this.request("pollRuntimeJob", {});
    if (!candidate) return;
    const job = runtimeJobSchema.parse(candidate);
    const handler = this.handlers.require(job.kind);
    if (job.installationId !== this.settings.installationId || (!handler.ignoresExpiry && Date.parse(job.expiresAt) <= Date.now())) throw Error("Job identity unavailable");
    const payload = handler.payload.parse(candidate);
    const directory = join(dirname(resolve(this.settings.credentialFile)), "runtime-jobs", job.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const path of [dirname(directory), directory]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw Error("Job directory must be private");
    }
    const unlock = await lockRuntimeJob(join(directory, "active.sqlite"));
    if (!unlock) return;
    try {
      await handler.run(job, payload, {
        settings: this.settings, directory, runtimeDirectory: dirname(resolve(this.settings.credentialFile)),
        request: (action, body) => this.send(action, body, handler.requestTimeoutMs?.[action] ?? REQUEST_TIMEOUT_MS),
        stopped: () => this.stopped,
      });
    } finally { unlock(); }
  }
}
