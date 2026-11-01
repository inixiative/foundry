/**
 * @atlas
 * @kind config
 * @partOf feature:composition
 */

/** Who may see a piece of corpus: one person privately, one person publicly, the team, the org. */
export type CorpusTier = 'personal_private' | 'personal_public' | 'team' | 'org';

/** Audiences that may see content at each tier. Untiered content is personal_private. */
const VISIBLE_TO: Record<CorpusTier, readonly CorpusTier[]> = {
  personal_private: ['personal_private'],
  personal_public: ['personal_private', 'personal_public', 'team'],
  team: ['personal_private', 'personal_public', 'team'],
  org: ['personal_private', 'personal_public', 'team', 'org'],
};

export const CORPUS_TIERS = Object.keys(VISIBLE_TO) as readonly CorpusTier[];

/** Whether content at `tier` may reach `audience`. */
export function visibleTo(tier: CorpusTier, audience: CorpusTier): boolean {
  return VISIBLE_TO[tier].includes(audience);
}
