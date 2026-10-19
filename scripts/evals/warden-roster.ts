/**
 * @atlas
 * @kind entrypoint
 * @partOf feature:evals
 */
/**
 * History: the hand-named roster was retired 2026-10-17. This reads an archived settings file (the
 * pre-filter eval's `--settings`) to replay its measurements; live settings declare no Wardens.
 *
 * The Warden roster an offline eval runs: every enabled domain-advising agent in a settings file,
 * composed from the role files of a probe's ladder (`<knowledge>/<node>/<agent id>/{instructions,
 * domainKnowledge}.md`, nodes `personal`, `org-<org>`, `project-<project>`). Shared by the charter
 * eval and the pre-filter eval so both see the same Wardens.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalWarden } from '../../packages/foundry/src/feedback/charter-eval';

export interface RosterWarden extends EvalWarden {
  /** The agent id in settings (`librarian-reuse`). */
  readonly id: string;
}

export function loadRoster(settingsPath: string, knowledge: string) {
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const agents = Object.entries(
    settings.agents as Record<
      string,
      { flowRole?: string; enabled?: boolean; domain?: string; prompt?: string }
    >,
  ).filter(([, a]) => a.flowRole === 'domain-advising' && a.enabled && a.domain && a.prompt);
  const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
  const ladder = (ctx: string, project?: string) =>
    ctx === 'userevidence'
      ? ['org-userevidence', 'project-zealot']
      : ['personal', 'org-inixiative', ...(project ? [`project-${project}`] : [])];
  const cache = new Map<string, RosterWarden[]>();
  /** The context's Wardens that hold domain knowledge (a cold Warden is never asked live either). */
  const wardensFor = (ctx: string, project?: string): RosterWarden[] => {
    const nodes = ladder(ctx, project);
    const key = nodes.join('|');
    if (!cache.has(key))
      cache.set(
        key,
        agents
          .map(([id, agent]) => ({
            id,
            domain: agent.domain!,
            instructions: [
              agent.prompt!,
              ...nodes.map((n) => read(join(knowledge, n, id, 'instructions.md'))),
            ]
              .filter(Boolean)
              .join('\n\n'),
            domainKnowledge: nodes
              .map((n) => read(join(knowledge, n, id, 'domainKnowledge.md')))
              .filter(Boolean)
              .join('\n\n'),
          }))
          .filter((w) => w.domainKnowledge.trim()),
      );
    return cache.get(key)!;
  };
  return {
    ids: new Map(agents.map(([id, a]) => [a.domain!, id])),
    wardensFor,
  };
}
