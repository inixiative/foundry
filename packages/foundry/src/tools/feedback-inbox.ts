/**
 * @atlas
 * @kind adapter
 * @partOf feature:feedback, primitive:tools
 */
import type {
  ApiRequest,
  ApiResponse,
  ApiTool,
  OwnershipScope,
  ToolResult,
} from '@inixiative/foundry-core';
import { z } from 'zod';
import type { FeedbackService } from '../feedback/service';
import { type FeedbackView, feedbackView, newestFirst } from '../feedback/view';

/**
 * The feedback inbox on a Feedback thread's MCP bridge (Aron, 2026-11-14: "you should work through
 * this with the agent"): `feedback_inbox` lists items, `feedback_item` reads one, `feedback_status`
 * archives or reopens. The same service and views as the viewer's `/api/feedback` routes; a status
 * change is journalled on the item's own thread with this thread as its actor. Answering an item's
 * tuning prompts stays the person's, in the inbox.
 */

export const feedbackInboxSchema = z.strictObject({
  projectId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .nullable()
    .optional()
    .describe('Only this project (null: feedback given outside every project); omit for all'),
  status: z.enum(['open', 'archived']).optional().describe('Only open or only archived items'),
  limit: z.number().int().min(1).max(200).optional().describe('At most this many (default 50)'),
});
export const feedbackItemSchema = z.strictObject({ itemId: z.string().trim().min(1).max(200) });
export const feedbackStatusSchema = z.strictObject({
  itemIds: z.array(z.string().trim().min(1).max(200)).min(1).max(200),
  status: z
    .enum(['open', 'archived'])
    .describe('archived: dealt with or dropped; open: back in the inbox'),
});

export const FEEDBACK_INBOX_DESCRIPTION =
  "List the feedback inbox, newest first: each item's id, status, project, stage and attention, and its statement. Filter by projectId (null for feedback given outside every project) or status (open, archived).";
export const FEEDBACK_ITEM_DESCRIPTION =
  'Read one feedback item in full: its statement and quote, origin thread and turn, tags, where it was routed, its tuning, applied changes, exposures and recurrences.';
export const FEEDBACK_STATUS_DESCRIPTION =
  "Archive feedback items that are dealt with or dropped, or reopen archived ones (status 'open'). Do it when the person agrees an item is handled; the change is journalled on each item's thread.";

/** The tool ids `FeedbackInboxTool` answers, in the order the bridge registers them. */
export const FEEDBACK_TOOL_NAMES = ['feedback_inbox', 'feedback_item', 'feedback_status'] as const;

const line = (view: FeedbackView) =>
  `- ${view.id} [${view.inbox}; ${view.stage}; ${view.attention}] ${view.projectId ?? 'no project'}: ${view.statement.replace(/\s+/g, ' ').slice(0, 300)}`;

export class FeedbackInboxTool implements ApiTool {
  readonly id = 'feedback';
  readonly kind = 'api' as const;
  readonly capability = 'net:api' as const;
  constructor(
    private readonly resolve: () => FeedbackService | null,
    private readonly scope: OwnershipScope = {},
  ) {}
  scoped(scope: OwnershipScope): FeedbackInboxTool {
    return new FeedbackInboxTool(this.resolve, scope);
  }
  /** `url` is one of `FEEDBACK_TOOL_NAMES`; `body` is its arguments. */
  async request<T = unknown>(req: ApiRequest): Promise<ToolResult<ApiResponse<T>>> {
    const started = performance.now();
    try {
      const threadId = this.scope.threadId;
      if (!threadId) throw Error('This tool runs only inside a thread');
      const feedback = this.resolve();
      if (!feedback) throw Error('Feedback is unavailable in this Foundry.');
      if (!feedback.isFeedbackThread(threadId))
        throw Error('The feedback inbox answers a Feedback thread only');
      const summary = this.answer(feedback, threadId, req.url, req.body ?? {});
      return {
        ok: true,
        summary,
        data: {
          status: 200,
          statusText: 'OK',
          headers: {},
          body: { result: summary } as T,
          durationMs: Math.round(performance.now() - started),
        },
      };
    } catch (error) {
      const summary =
        error instanceof z.ZodError
          ? `Not done: ${error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
          : (error as Error).message;
      return { ok: false, summary, error: summary };
    }
  }

  private answer(feedback: FeedbackService, threadId: string, url: string, raw: unknown): string {
    if (url === 'feedback_inbox') {
      const args = feedbackInboxSchema.parse(raw);
      const items =
        args.projectId === undefined
          ? feedback.lifecycle.items
          : feedback.lifecycle.forProject(args.projectId);
      const views = items
        .filter((item) => !args.status || item.inbox === args.status)
        .map((item) => feedbackView(feedback, item))
        .sort(newestFirst);
      const shown = views.slice(0, args.limit ?? 50);
      if (!shown.length) return 'No feedback items match.';
      const more = views.length - shown.length;
      return [
        `${views.length} item${views.length === 1 ? '' : 's'}${more ? ` (showing the newest ${shown.length})` : ''}:`,
        ...shown.map(line),
      ].join('\n');
    }
    if (url === 'feedback_item') {
      const { itemId } = feedbackItemSchema.parse(raw);
      const item = feedback.lifecycle.get(itemId);
      if (!item) throw Error(`feedback item ${itemId} not found`);
      return JSON.stringify(feedbackView(feedback, item), null, 2);
    }
    if (url === 'feedback_status') {
      const { itemIds, status } = feedbackStatusSchema.parse(raw);
      const changed = feedback.setInbox(itemIds, status, `thread:${threadId}`);
      const unchanged = itemIds.length - changed.length;
      return `${status === 'archived' ? 'Archived' : 'Reopened'} ${changed.length} item${changed.length === 1 ? '' : 's'}${unchanged ? `; ${unchanged} already ${status}` : ''}.`;
    }
    throw Error(`unknown feedback operation: ${url}`);
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
