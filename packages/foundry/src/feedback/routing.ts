import type { Cartographer, RouteResult } from '../agents/cartographer';
import { configuredExperts } from '../agents/configured-experts';
import type { FoundryConfig } from '../viewer/config';
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

/** Warden agent id for each enabled configured domain. */
export function wardenRoles(config: FoundryConfig): Map<string, string> {
  return new Map(configuredExperts(config).experts.map((e) => [e.domain, e.agentId]));
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
  hasProject: boolean;
  timeoutMs?: number;
}): Promise<FeedbackRouteRecord> {
  const result: RouteResult = await input.cartographer.route(input.statement, undefined, {
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  const wardens = wardenRoles(input.config);
  const source = result.source ?? 'model';
  const roles =
    source === 'model'
      ? [...new Set(result.domains.map((d) => wardens.get(d)).filter((r): r is string => !!r))]
      : [];
  return {
    itemId: input.itemId,
    roles: roles.length ? roles : [MAIN_ROLE],
    slot: slotFor(input.category),
    level: defaultLevel(input.category, input.hasProject),
    route: { domains: result.domains, source, confidence: result.confidence },
  };
}
