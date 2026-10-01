import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { kingdomUrl } from './kingdom-client';
import { readPrivateJson } from './kingdom-credential-file';
import { accessSecretPattern } from './kingdom-secrets';
import { SignetClient, signetCredentialSchema } from './signet-client';

/** Access grants are independent of native inference installations and capacity. */
export const kingdomAccessSourceSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(120),
    url: z.string().transform((value, context) => {
      try {
        return kingdomUrl(value);
      } catch {
        context.addIssue({
          code: 'custom',
          message: 'Use an HTTPS origin or loopback HTTP origin.',
        });
        return z.NEVER;
      }
    }),
    credentialFile: z.string().refine(isAbsolute),
    integrationId: z.string().uuid(),
    signetId: z.string().uuid(),
    projectIds: z.array(z.string().min(1)).min(1),
    threadIds: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();
export type KingdomAccessSource = z.infer<typeof kingdomAccessSourceSchema>;
export const accessCredentialSchema = z
  .object({ secret: z.string().regex(accessSecretPattern) })
  .strict();
const descriptionSchema = z.object({
  signetId: z.string().uuid(),
  integrationId: z.string().uuid(),
  name: z.string(),
  expiresAt: z.string().datetime().nullable(),
  lifecycle: z.enum(['request', 'task', 'ongoing']).optional(),
  taskId: z.string().uuid().nullable().optional(),
  remainingRequests: z.number().int().nonnegative(),
  operations: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      resources: z.array(
        z.object({
          id: z.string().uuid(),
          name: z.string(),
          kind: z.string(),
          integrationId: z.string().uuid().optional(),
        }),
      ),
    }),
  ),
});
export const readOperationSchema = z
  .string()
  .max(80)
  .regex(/^[a-z][a-z.]*\.read$/);

export function validateKingdomAccess(sources: unknown): KingdomAccessSource[] {
  const parsed = z.array(kingdomAccessSourceSchema).parse(sources);
  if (new Set(parsed.map((source) => source.id)).size !== parsed.length)
    throw Error('Duplicate Kingdom access source');
  return parsed;
}

export class KingdomAccessHttpError extends Error {
  constructor(readonly status: number) {
    super(`Kingdom access refused (${status})`);
  }
}

/** Single requests only: never retry uncertain execution or follow credential-bearing redirects. */
export class KingdomAccessClient {
  constructor(private source: KingdomAccessSource) {
    this.source = kingdomAccessSourceSchema.parse(source);
  }
  private async post(
    action: 'describe' | 'execute',
    body: unknown,
    onDispatch?: () => void,
  ): Promise<unknown> {
    const stored = await readPrivateJson(this.source.credentialFile);
    if (signetCredentialSchema.safeParse(stored).success)
      return new SignetClient(
        this.source.url,
        this.source.credentialFile,
        this.source.signetId,
      ).post(action, body, onDispatch);
    const { secret } = accessCredentialSchema.parse(stored);
    onDispatch?.();
    const response = await fetch(`${this.source.url}/api/v1/access/${action}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new KingdomAccessHttpError(response.status);
    }
    const reader = response.body?.getReader();
    if (!reader) throw Error('Kingdom access response unavailable');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 1_048_576) throw Error('Kingdom access response exceeds limit');
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    return z.object({ data: z.unknown() }).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      .data;
  }
  async describe() {
    const description = descriptionSchema.parse(await this.post('describe', {}));
    if (
      description.integrationId !== this.source.integrationId ||
      description.signetId !== this.source.signetId
    )
      throw Error('Kingdom access credential belongs to another grant');
    if (description.expiresAt && Date.parse(description.expiresAt) <= Date.now())
      throw Error('Kingdom access expired');
    return {
      ...description,
      operations: description.operations.filter(
        (operation) => readOperationSchema.safeParse(operation.key).success,
      ),
    };
  }
  async closeTask(reason: 'completed' | 'cancelled') {
    const credential = signetCredentialSchema.parse(
      await readPrivateJson(this.source.credentialFile),
    );
    if (credential.lifecycle !== 'task' || !credential.taskId) throw Error('Task Signet required');
    return new SignetClient(this.source.url, this.source.credentialFile, this.source.signetId).post(
      'closeTask',
      { signetId: this.source.signetId, taskId: credential.taskId, reason },
    );
  }
  async read(
    input: {
      requestId: string;
      runId: string;
      operation: string;
      resourceId: string;
      limit: number;
    },
    onDispatch?: () => void,
  ) {
    // Discovery is advisory; the execute route rechecks current authority and caps under its lock.
    const description = await this.describe();
    if (
      !description.operations.some(
        (operation) =>
          operation.key === input.operation &&
          operation.resources.some((resource) => resource.id === input.resourceId),
      )
    )
      throw Error('Kingdom operation or resource unavailable');
    return z.object({ executionId: z.string().uuid(), result: z.unknown() }).parse(
      await this.post(
        'execute',
        {
          requestId: input.requestId,
          runId: input.runId,
          integrationId:
            description.operations
              .flatMap((operation) => operation.resources)
              .find((resource) => resource.id === input.resourceId)?.integrationId ??
            this.source.integrationId,
          signetId: this.source.signetId,
          ...(description.taskId ? { taskId: description.taskId } : {}),
          operation: readOperationSchema.parse(input.operation),
          input: { resourceId: input.resourceId, limit: input.limit },
        },
        onDispatch,
      ),
    );
  }
}
