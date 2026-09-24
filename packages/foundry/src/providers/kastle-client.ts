import { z } from "zod";

export const kastleSelectionSchema = z.object({
  model: z.string().min(1).optional(), effort: z.string().min(1).optional(), poolId: z.string().uuid().optional(),
  capacityIds: z.array(z.string().uuid()).optional(), connectionIds: z.array(z.string().uuid()).optional(),
  category: z.string().optional(), projectId: z.string().uuid().optional(), tagIds: z.array(z.string().uuid()).optional(), inferredTags: z.array(z.string()).optional(),
}).strict();
export const kastleEnvelopeSchema = z.object({
  id: z.string().uuid(), kastleId: z.string().uuid(), installationId: z.string().uuid(), runId: z.string().uuid(), connectionId: z.string().uuid(), capacityId: z.string().uuid(),
  model: z.string(), effort: z.string(), runtime: z.enum(["claude", "codex"]), expiresAt: z.string().datetime(), gatewayPath: z.string(),
}).strict();
export type KastleSelection = z.infer<typeof kastleSelectionSchema>;
export type KastleRunEnvelope = z.infer<typeof kastleEnvelopeSchema>;
export const kastleUrl = (value: string) => {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw Error("Kastle requires an HTTPS origin or loopback HTTP");
  return url.origin;
};

export class KastleClient {
  readonly origin: string;
  constructor(origin: string, private credential: string) { this.origin = kastleUrl(origin); }
  private async post(action: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.origin}/api/v1/access/${action}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/json", authorization: `Bearer ${this.credential}` }, body: JSON.stringify(body),
    });
    if (!response.ok) { await response.body?.cancel(); throw Error(`Kastle ${action} failed (${response.status})`); }
    const result = z.object({ data: z.unknown() }).parse(await response.json());
    return result.data;
  }
  async resolve(runId: string, selection: KastleSelection, spreadId?: string): Promise<KastleRunEnvelope> {
    const run = kastleEnvelopeSchema.parse(await this.post("resolveRun", { runId, selection: kastleSelectionSchema.parse(selection), ...(spreadId ? { spreadId } : {}) }));
    const expected = `/api/v1/access/gateway/${run.id}${run.runtime === "codex" ? "/v1" : ""}`;
    if (run.gatewayPath !== expected || run.runId !== runId) throw Error("Kastle returned a mismatched run binding");
    return run;
  }
  async delegate(bindingId: string) {
    return z.object({ secret: z.string().regex(/^kastle_refresh_[a-zA-Z0-9_-]{43}$/), expiresAt: z.string().datetime() }).parse(await this.post("delegateRun", { bindingId }));
  }
  async refresh(bindingId: string) {
    return z.object({ id: z.string().uuid(), secret: z.string().regex(/^kastle_run_[a-zA-Z0-9_-]{43}$/), expiresAt: z.string().datetime() }).parse(await this.post("refreshRun", { bindingId }));
  }
  async revoke(bindingId: string) { await this.post("revokeRun", { bindingId }); }
}
