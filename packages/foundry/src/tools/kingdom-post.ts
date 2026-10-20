/**
 * @atlas
 * @kind adapter
 * @partOf feature:conversations, integration:kingdom
 */
import type {
  ApiRequest,
  ApiResponse,
  ApiTool,
  OwnershipScope,
  ToolRegistry,
  ToolResult,
} from '@inixiative/foundry-core';
import {
  foundryIdSchema,
  SignetHttpError,
  threadIdSchema,
  threadTextLimit,
} from '@inixiative/signet';
import { z } from 'zod';
import type { HeldRecord } from '../conversations/types';
import {
  KingdomAccessClient,
  type KingdomAccessSource,
  validateKingdomAccess,
} from '../providers/kingdom-access-client';

/** Where a held post goes: the conversation wrapper of the thread that wrote it. */
export interface HeldPosts {
  holdPost(
    threadId: string,
    post: { accessId: string; remoteThreadId: string; text: string; inReplyTo?: string },
  ): string;
}

const postInput = z.strictObject({
  accessId: z.string().uuid(),
  threadId: threadIdSchema,
  text: z.string().min(1).max(threadTextLimit),
  inReplyTo: foundryIdSchema.optional(),
});

/**
 * The joining side's post (docs/reference/CONVERSATIONS.md §4.5): a post into a conversation another
 * Foundry hosts, through a Signet this Foundry holds. Kept apart from the read-only
 * `KingdomAccessTool`. Its handler never calls Kingdom: it writes the post as a pending journal entry
 * and asks this owner, so the owner sees what their agent will say before any context leaves, on
 * every runtime. Released, it is posted with the same access source (`deliver`).
 */
export class KingdomPostTool implements ApiTool {
  readonly id = 'kingdom_post';
  readonly kind = 'api' as const;
  readonly capability = 'net:api' as const;
  private readonly sources: KingdomAccessSource[];
  constructor(
    sources: KingdomAccessSource[],
    private readonly resolve: () => HeldPosts | null,
    private readonly scope: OwnershipScope = {},
  ) {
    this.sources = validateKingdomAccess(sources);
  }
  scoped(scope: OwnershipScope): KingdomPostTool {
    return new KingdomPostTool(this.sources, this.resolve, scope);
  }
  /** The access sources this project and thread may post through (project allowlists attenuate grants). */
  private allowed(scope: OwnershipScope) {
    return this.sources.filter(
      (source) =>
        !!scope.projectId &&
        source.projectIds.includes(scope.projectId) &&
        (!source.threadIds || (!!scope.threadId && source.threadIds.includes(scope.threadId))),
    );
  }
  async request<T = unknown>(req: ApiRequest): Promise<ToolResult<ApiResponse<T>>> {
    const started = performance.now();
    try {
      if (!this.scope.projectId || !this.scope.threadId) throw Error('Caller scope required');
      if (req.url !== 'post') throw Error('Use url="post"');
      const input = postInput.parse(req.body);
      if (!this.allowed(this.scope).some((source) => source.id === input.accessId))
        throw Error('Access source unavailable to this thread');
      const posts = this.resolve();
      if (!posts) throw Error('This Foundry cannot hold posts now');
      const text = posts.holdPost(this.scope.threadId, {
        accessId: input.accessId,
        remoteThreadId: input.threadId,
        text: input.text,
        ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
      });
      return {
        ok: true,
        summary: text,
        data: {
          status: 200,
          statusText: 'OK',
          headers: {},
          body: { result: text } as T,
          durationMs: Math.round(performance.now() - started),
        },
      };
    } catch (error) {
      return { ok: false, summary: (error as Error).message, error: (error as Error).message };
    }
  }
  /** Post a released item; Kingdom's answer (or why it failed) comes back for the journal. */
  async deliver(record: HeldRecord): Promise<{ executionId?: string; error?: string }> {
    const source = this.sources.find((candidate) => candidate.id === record.accessId);
    if (!source || !record.remoteThreadId || !record.postId)
      return { error: 'The access source is no longer configured' };
    try {
      const { executionId } = await new KingdomAccessClient(source).threadPrompt({
        threadId: record.remoteThreadId,
        postId: record.postId,
        text: record.text,
        ...(record.inReplyTo ? { inReplyTo: record.inReplyTo } : {}),
      });
      return { executionId };
    } catch (error) {
      // Kingdom's refusal (a closed thread, the floor, a pause) is told by its status; local paths
      // and provider bodies are not published. Anything else leaves the outcome unconfirmed.
      return {
        error:
          error instanceof SignetHttpError
            ? `Kingdom refused the post (${error.status})`
            : 'Kingdom did not confirm the post; do not retry automatically',
      };
    }
  }
  get<T = unknown>(url: string) {
    return this.request<T>({ url, method: 'GET' });
  }
  post<T = unknown>(url: string, body: unknown) {
    return this.request<T>({ url, body, method: 'POST' });
  }
  put<T = unknown>(url: string, body: unknown) {
    return this.request<T>({ url, body, method: 'PUT' });
  }
  delete<T = unknown>(url: string) {
    return this.request<T>({ url, method: 'DELETE' });
  }
}

export function registerKingdomPost(
  tools: ToolRegistry,
  sources: KingdomAccessSource[],
  resolve: () => HeldPosts | null,
): void {
  if (!sources.length) return;
  tools.register(
    new KingdomPostTool(sources, resolve),
    'Post into a conversation another Foundry hosts, through a Kingdom access ID this project holds. url="post", body={accessId, threadId, text, inReplyTo?}. Every post is held for the owner\'s review before it leaves; released, it is posted once. Failed posts are not retried automatically.',
  );
}
