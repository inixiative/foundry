/**
 * @atlas
 * @kind adapter
 * @partOf feature:threads, primitive:tools
 */
import type {
  ApiRequest,
  ApiResponse,
  ApiTool,
  OwnershipScope,
  ThreadPlan,
  ToolResult,
} from '@inixiative/foundry-core';
import { z } from 'zod';

/**
 * The thread's plan, written by its own agent (`set_plan` on Foundry's MCP server, the Plan view).
 * A call replaces each section it gives and keeps the others, so the agent can update one part.
 * A technical row is the CLAUDE.md rule made visible: per concern, the existing primitive it uses
 * (reuse / extend / combine / refactor / migrate, with where it lives) or, for `new`, why none fits
 * and what would have made the closest one fit.
 */

const item = z.strictObject({
  text: z.string().trim().min(1).max(300),
  detail: z.string().trim().min(1).max(4_000).optional(),
});
export const planPatchSchema = z
  .strictObject({
    outcomes: z
      .array(item.extend({ status: z.enum(['todo', 'doing', 'done', 'you']) }))
      .max(40)
      .optional(),
    pains: z.array(item).max(20).optional(),
    strategy: z.array(item).max(30).optional(),
    reasons: z.array(item).max(20).optional(),
    technical: z
      .array(
        z.strictObject({
          concern: z.string().trim().min(1).max(120),
          decision: z.enum(['reuse', 'extend', 'new', 'combine', 'refactor', 'migrate', 'none']),
          system: z.string().trim().min(1).max(200),
          path: z.string().trim().min(1).max(400).optional(),
          reason: z.string().trim().min(1).max(2_000),
        }),
      )
      .max(40)
      .optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'Give at least one section');
export type PlanPatch = z.infer<typeof planPatchSchema>;

/** Apply a patch to a thread's plan: given sections replace, others stay; empty sections start empty. */
export function applyPlanPatch(
  current: ThreadPlan | undefined,
  patch: PlanPatch,
  now = Date.now(),
): ThreadPlan {
  return {
    outcomes: patch.outcomes ?? current?.outcomes ?? [],
    pains: patch.pains ?? current?.pains ?? [],
    strategy: patch.strategy ?? current?.strategy ?? [],
    reasons: patch.reasons ?? current?.reasons ?? [],
    technical: patch.technical ?? current?.technical ?? [],
    updatedAt: now,
  };
}

/** What the plan tool reaches: the thread's record, persisted and published. */
export interface ThreadPlans {
  setPlan(threadId: string, patch: PlanPatch): ThreadPlan;
}

export const PLAN_TOOL_DESCRIPTION =
  'Record this thread\'s plan for the Plan view. url="set_plan", body={outcomes?, pains?, strategy?, reasons?, technical?}: each section given replaces that section.';

export class ThreadPlanTool implements ApiTool {
  readonly id = 'plan';
  readonly kind = 'api' as const;
  readonly capability = 'net:api' as const;
  constructor(
    private readonly resolve: () => ThreadPlans | null,
    private readonly scope: OwnershipScope = {},
  ) {}
  scoped(scope: OwnershipScope): ThreadPlanTool {
    return new ThreadPlanTool(this.resolve, scope);
  }
  async request<T = unknown>(req: ApiRequest): Promise<ToolResult<ApiResponse<T>>> {
    const started = performance.now();
    try {
      const threadId = this.scope.threadId;
      if (!threadId) throw Error('This tool runs only inside a thread');
      if (req.url !== 'set_plan') throw Error('Use set_plan');
      const plans = this.resolve();
      if (!plans) throw Error('This Foundry is not recording plans');
      const parsed = planPatchSchema.safeParse(req.body);
      if (!parsed.success)
        throw Error(
          `Plan not recorded: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      const plan = plans.setPlan(threadId, parsed.data);
      const summary = `Plan recorded: ${plan.outcomes.length} outcomes, ${plan.technical.length} technical decisions.`;
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
      return { ok: false, summary: (error as Error).message, error: (error as Error).message };
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
