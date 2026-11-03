/**
 * @atlas
 * @kind helper
 * @partOf feature:composition, feature:wardens
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InstructionNodeConfig, RoleComposition } from '../prompts/instruction-settings';

/**
 * What a region Warden composes from (Aron, 2026-11-02): Foundry's charter (what a Warden is, fixed),
 * the project's Warden brief, its region, and the thread context of the call. Never the CLAUDE.md /
 * AGENTS.md ladder: that is written for the agent doing the work and would confuse a Warden whose only
 * job is to recognise its domain and point.
 *
 * The brief is a short, high-level explanation of the project for Wardens, committed in the
 * repository's `.foundry/` and composed through the ladder like Foundry's other md files (imports,
 * tiers, dedupe, the audit log's `file:<path>` versions), with a personal `.local.md` beside it.
 */
export const WARDEN_BRIEF_FILE = '.foundry/warden-brief.md';
export const WARDEN_BRIEF_LOCAL_FILE = '.foundry/warden-brief.local.md';

/** The ladder nodes the project view adds for its Warden roles; settings may not define them. */
export const WARDEN_BRIEF_NODE = 'warden-brief';
export const WARDEN_BRIEF_LOCAL_NODE = 'warden-brief-local';
export const WARDEN_BRIEF_NODES: readonly string[] = [WARDEN_BRIEF_NODE, WARDEN_BRIEF_LOCAL_NODE];

/**
 * The Warden brief as two ladder nodes for exactly these roles (the project's region Wardens), in the
 * instructions slot. `{project}` is the repository root of the thread's working directory, so a
 * worktree's Wardens read the brief on its branch.
 */
export function wardenBriefNodes(roles: readonly string[]): Record<string, InstructionNodeConfig> {
  const when = { roles: [...roles], slots: ['instructions'] };
  return {
    [WARDEN_BRIEF_NODE]: {
      scope: 'project',
      personal: false,
      label: 'project Warden brief, checked into the codebase',
      when,
      sources: [{ path: `{project}/${WARDEN_BRIEF_FILE}` }],
    },
    [WARDEN_BRIEF_LOCAL_NODE]: {
      scope: 'project',
      personal: true,
      label: "project Warden brief, the user's private additions",
      when,
      sources: [{ path: `{project}/${WARDEN_BRIEF_LOCAL_FILE}` }],
    },
  };
}

/**
 * A region Warden's picks from the ladder: no node's general files (CLAUDE.md, AGENTS.md, rules,
 * auto memory) reach either slot. Role files and the Warden brief are slotted, so they still compose.
 * `exclude` and every other pick a setting makes are kept; a setting naming `general` for a Warden is
 * refused. There is no switch that brings the ladder back (Aron, 2026-11-02: "none").
 */
export function wardenComposition(role: string, own: RoleComposition | undefined): RoleComposition {
  for (const slot of ['instructions', 'domainKnowledge'] as const) {
    const pick = own?.[slot];
    if (pick && pick.general !== undefined)
      throw new Error(
        `[config] composition.roles.${role}.${slot}.general: a region Warden never composes the CLAUDE.md / AGENTS.md ladder (Aron, 2026-11-02); its instructions are the charter, the project's Warden brief (${WARDEN_BRIEF_FILE}) and its region. Remove "general".`,
      );
  }
  const slot = (pick: RoleComposition['instructions']) =>
    pick === false ? false : { ...pick, general: [] };
  return {
    ...own,
    instructions: slot(own?.instructions),
    domainKnowledge: slot(own?.domainKnowledge),
  };
}

/** The project's Warden brief as the repository has it (the committed file only), for the viewer. */
export function readWardenBrief(projectPath: string): {
  path: string;
  exists: boolean;
  chars: number;
  tokens: number;
  text: string;
} {
  const path = join(projectPath, WARDEN_BRIEF_FILE);
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  return {
    path: WARDEN_BRIEF_FILE,
    exists: existsSync(path),
    chars: text.length,
    tokens: Math.round(text.length / 4),
    text,
  };
}
