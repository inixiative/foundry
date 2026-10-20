/**
 * @atlas
 * @kind client
 * @partOf integration:kingdom
 */
import { isAbsolute } from 'node:path';
import {
  kingdomUrl,
  readPrivateJson,
  SignetClient,
  selectsThread,
  signetCredentialSchema,
  threadsResourceKind,
} from '@inixiative/signet';
import { z } from 'zod';

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

/** Single requests only: never retry uncertain execution or follow credential-bearing redirects. */
export class KingdomAccessClient {
  constructor(private source: KingdomAccessSource) {
    this.source = kingdomAccessSourceSchema.parse(source);
  }
  private post(action: 'execute', body: unknown, onDispatch?: () => void) {
    return new SignetClient(this.source.url, this.source.credentialFile, this.source.signetId).post(
      action,
      body,
      onDispatch,
    );
  }
  /**
   * The grant as Kingdom describes it now, every operation, checked to be this source's own and
   * unexpired. Read per entry (signet 0.5): a resource whose lens this package can't read is
   * dropped, never the grant.
   */
  private async granted() {
    const { dropped: _dropped, ...description } = await new SignetClient(
      this.source.url,
      this.source.credentialFile,
      this.source.signetId,
    ).describe();
    if (
      description.integrationId !== this.source.integrationId ||
      description.signetId !== this.source.signetId
    )
      throw Error('Kingdom access credential belongs to another grant');
    if (description.expiresAt && Date.parse(description.expiresAt) <= Date.now())
      throw Error('Kingdom access expired');
    return description;
  }
  /** What the read-only access tool may use: the grant's read operations. */
  async describe() {
    const description = await this.granted();
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
    return this.execute(
      {
        requestId: input.requestId,
        runId: input.runId,
        integrationId:
          description.operations
            .flatMap((operation) => operation.resources)
            .find((resource) => resource.id === input.resourceId)?.integrationId ??
          this.source.integrationId,
        operation: readOperationSchema.parse(input.operation),
        input: { resourceId: input.resourceId, limit: input.limit },
      },
      description.taskId,
      onDispatch,
    );
  }

  /** One execution under this source's Signet (and its task, when it has one); never retried. */
  private async execute(
    request: {
      requestId: string;
      runId?: string;
      integrationId: string;
      operation: string;
      input: Record<string, unknown>;
    },
    taskId: string | null,
    onDispatch?: () => void,
  ) {
    return z
      .object({ executionId: z.string().uuid(), result: z.unknown() })
      .parse(
        await this.post(
          'execute',
          { ...request, signetId: this.source.signetId, ...(taskId ? { taskId } : {}) },
          onDispatch,
        ),
      );
  }

  /**
   * Post into a conversation this Foundry joined (the joining side, `kingdom_post`): the held
   * Signet's `thread.prompt` on the `threads` resource whose lens selects the thread. `postId` is
   * the post's own id, kept across a retry; each call is a new request id.
   */
  async threadPrompt(
    input: { threadId: string; postId: string; text: string; inReplyTo?: string },
    onDispatch?: () => void,
  ) {
    const description = await this.granted();
    const resource = description.operations
      .find((operation) => operation.key === 'thread.prompt')
      ?.resources.find(
        (candidate) =>
          candidate.kind === threadsResourceKind &&
          'threads' in candidate.lens &&
          selectsThread(candidate.lens.threads, input.threadId),
      );
    if (!resource) throw Error('This Signet does not reach that conversation thread');
    return this.execute(
      {
        requestId: crypto.randomUUID(),
        integrationId: resource.integrationId,
        operation: 'thread.prompt',
        input: {
          resourceId: resource.id,
          threadId: input.threadId,
          postId: input.postId,
          text: input.text,
          ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
        },
      },
      description.taskId,
      onDispatch,
    );
  }
}
