/**
 * @atlas
 * @kind service
 * @partOf feature:feedback
 */
import { configuredExperts } from '../agents/configured-experts';
import { MAIN_ROLE, threadRoles } from '../prompts/instruction-settings';
import type { FoundryConfig } from '../viewer/config';
import { resolveProjectView } from '../viewer/config-resolve';
import type { FeedbackCategory, FeedbackLevel, FeedbackSlot } from './types';

/**
 * Every role a feedback item may be applied to: the thread roles, the shared base `main`, and the
 * project's region Wardens.
 */
export function feedbackRoleChoices(
  config: FoundryConfig,
  projectId: string | null | undefined,
): string[] {
  const view = (projectId ? resolveProjectView(config, projectId)?.config : undefined) ?? config;
  return [
    ...threadRoles(view.composition).map((role) => role.id),
    MAIN_ROLE,
    ...wardenRoles(config, projectId).values(),
  ];
}

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
