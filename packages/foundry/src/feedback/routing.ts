/**
 * @atlas
 * @kind service
 * @partOf feature:feedback
 */
import type { Cartographer, RouteResult } from '../agents/cartographer';
import { configuredExperts } from '../agents/configured-experts';
import type { FoundryConfig } from '../viewer/config';
import { resolveProjectView } from '../viewer/config-resolve';
import type { FeedbackCategory, FeedbackLevel, FeedbackRouteRecord, FeedbackSlot } from './types';

/** The thread's own instructions slot: the last resort when no Warden owns the rule. */
export const MAIN_ROLE = 'main';

export const slotFor = (category: FeedbackCategory): FeedbackSlot =>
  category === 'fact' ? 'domainKnowledge' : 'instructions';

export function defaultLevel(category: FeedbackCategory, hasProject: boolean): FeedbackLevel {
  if (category === 'convention' || category === 'fact')
    return hasProject ? 'project-personal' : 'computer';
  if (category === 'approach' || category === 'scope') return 'org-personal';
  return 'computer';
}

/**
 * Warden agent id for each domain of the project's chorus: its region Wardens, which only its project
 * view carries (settings declare no Wardens). Without a project, or with its chorus off, there are none.
 */
export function wardenRoles(
  config: FoundryConfig,
  projectId: string | null | undefined,
): Map<string, string> {
  const view = projectId ? resolveProjectView(config, projectId)?.config : undefined;
  if (!view) return new Map();
  return new Map(configuredExperts(view).experts.map((e) => [e.domain, e.agentId]));
}

/**
 * Route a sharpened rule to the Warden(s) whose domain it belongs to, with the thread's Cartographer.
 * No domain, or a keyword fallback, goes to `main`: weak routing is said, never dressed up.
 */
export async function routeFeedback(input: {
  cartographer: Pick<Cartographer, 'route'>;
  config: FoundryConfig;
  itemId: string;
  statement: string;
  category: FeedbackCategory;
  projectId: string | null | undefined;
  timeoutMs?: number;
}): Promise<FeedbackRouteRecord> {
  const result: RouteResult = await input.cartographer.route(input.statement, undefined, {
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  const wardens = wardenRoles(input.config, input.projectId);
  const source = result.source ?? 'model';
  const roles =
    source === 'model'
      ? [...new Set(result.domains.map((d) => wardens.get(d)).filter((r): r is string => !!r))]
      : [];
  return {
    itemId: input.itemId,
    roles: roles.length ? roles : [MAIN_ROLE],
    slot: slotFor(input.category),
    level: defaultLevel(input.category, !!input.projectId),
    route: { domains: result.domains, source, confidence: result.confidence },
  };
}
