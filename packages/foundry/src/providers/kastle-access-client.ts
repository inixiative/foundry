import { SignetClient, signetCredentialSchema } from "./signet-client";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { kastleUrl } from "./kastle-client";
import { readPrivateJson } from "./kastle-credential-file";

/** Access grants are independent of native inference installations and capacity. */
export const kastleAccessSourceSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(120), url: z.string().transform((value, context) => {
    try { return kastleUrl(value); }
    catch { context.addIssue({ code: "custom", message: "Use an HTTPS origin or loopback HTTP origin." }); return z.NEVER; }
  }),
  credentialFile: z.string().refine(isAbsolute), connectionId: z.string().uuid(), signetId: z.string().uuid(),
  projectIds: z.array(z.string().min(1)).min(1), threadIds: z.array(z.string().min(1)).min(1).optional(),
}).strict();
export type KastleAccessSource = z.infer<typeof kastleAccessSourceSchema>;
export const accessCredentialSchema = z.object({ secret: z.string().regex(/^kastle_[a-zA-Z0-9_-]{43}$/) }).strict();
const descriptionSchema = z.object({
  signetId: z.string().uuid(), connectionId: z.string().uuid(), integrationId: z.string().uuid(), name: z.string(),
  expiresAt: z.string().datetime().nullable(), lifecycle: z.enum(["request", "task", "ongoing"]).optional(), taskId: z.string().uuid().nullable().optional(), remainingRequests: z.number().int().nonnegative(),
  operations: z.array(z.object({ key: z.string(), name: z.string(), resources: z.array(z.object({ id: z.string().uuid(), name: z.string(), kind: z.string(), connectionId: z.string().uuid().optional() })) })),
});
export const readOperationSchema = z.string().max(80).regex(/^[a-z][a-z.]*\.read$/);

export function validateKastleAccess(sources: unknown): KastleAccessSource[] {
  const parsed = z.array(kastleAccessSourceSchema).parse(sources);
  if (new Set(parsed.map(source => source.id)).size !== parsed.length) throw Error("Duplicate Kastle access source");
  return parsed;
}

export class KastleAccessHttpError extends Error {
  constructor(readonly status: number) { super(`Kastle access refused (${status})`); }
}

/** Single requests only: never retry uncertain execution or follow credential-bearing redirects. */
export class KastleAccessClient {
  constructor(private source: KastleAccessSource) { this.source = kastleAccessSourceSchema.parse(source); }
  private async post(action: "describe" | "execute", body: unknown, onDispatch?: () => void): Promise<unknown> {
    const stored = await readPrivateJson(this.source.credentialFile);
    if (signetCredentialSchema.safeParse(stored).success) return new SignetClient(this.source.url, this.source.credentialFile, this.source.signetId).post(action, body, onDispatch);
    const { secret } = accessCredentialSchema.parse(stored);
    onDispatch?.();
    const response = await fetch(`${this.source.url}/api/v1/access/${action}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(20000),
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify(body),
    });
    if (!response.ok) { await response.body?.cancel(); throw new KastleAccessHttpError(response.status); }
    const reader = response.body?.getReader();
    if (!reader) throw Error("Kastle access response unavailable");
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 1_048_576) throw Error("Kastle access response exceeds limit");
        chunks.push(next.value);
      }
    } finally { await reader.cancel(); }
    return z.object({ data: z.unknown() }).parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))).data;
  }
  async describe() {
    const description = descriptionSchema.parse(await this.post("describe", {}));
    if (description.connectionId !== this.source.connectionId || description.signetId !== this.source.signetId)
      throw Error("Kastle access credential belongs to another grant");
    if (description.expiresAt && Date.parse(description.expiresAt) <= Date.now()) throw Error("Kastle access expired");
    return { ...description, operations: description.operations.filter(operation => readOperationSchema.safeParse(operation.key).success) };
  }
  async closeTask(reason: "completed" | "cancelled") {
    const credential = signetCredentialSchema.parse(await readPrivateJson(this.source.credentialFile));
    if (credential.lifecycle !== "task" || !credential.taskId) throw Error("Task Signet required");
    return new SignetClient(this.source.url, this.source.credentialFile, this.source.signetId).post("closeTask", { signetId: this.source.signetId, taskId: credential.taskId, reason });
  }
  async read(input: { requestId: string; runId: string; operation: string; resourceId: string; limit: number }, onDispatch?: () => void) {
    // Discovery is advisory; the execute route rechecks current authority and caps under its lock.
    const description = await this.describe();
    if (!description.operations.some(operation => operation.key === input.operation && operation.resources.some(resource => resource.id === input.resourceId)))
      throw Error("Kastle operation or resource unavailable");
    return z.object({ executionId: z.string().uuid(), result: z.unknown() }).parse(await this.post("execute", {
      requestId: input.requestId, runId: input.runId, connectionId: description.operations.flatMap(operation => operation.resources).find(resource => resource.id === input.resourceId)?.connectionId ?? this.source.connectionId, signetId: this.source.signetId,
      ...(description.taskId ? { taskId: description.taskId } : {}),
      operation: readOperationSchema.parse(input.operation), input: { resourceId: input.resourceId, limit: input.limit },
    }, onDispatch));
  }
}
