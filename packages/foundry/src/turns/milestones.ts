/**
 * @atlas
 * @kind service
 * @partOf feature:wardens
 */

import { newId } from '@inixiative/foundry-core';
import type { MilestoneKind, MilestoneMoment } from '../agents/flow-orchestrator';
import { classifyTool, foundryOperation } from './tool-gate';

/**
 * The milestone trigger's detector: which tool calls are milestones, the moments a workflow rule
 * applies to (Aron, 2026-11-16, after the #261 retrospective: the merge and review rules were in
 * context and skipped at the step they govern). A milestone is a call that lands work where others
 * see or depend on it: opening or merging a pull request, publishing a package, marking the thread
 * done, or changing a standing rule file. The same detector serves Claude's `pre-use` gate and the
 * observed calls of Codex and Muse, so every worker has one notion of a milestone.
 */

/** A runner in front of a tool: `npx changeset`, `bunx @inixiative/config train`, `pnpm exec …`. */
const RUNNER = String.raw`(?:(?:npx|bunx|bun\s+x|pnpm\s+(?:exec|dlx)|yarn\s+dlx)\s+)?`;
/** Global flags between a tool and its subcommand: `gh -R owner/repo`, `pnpm -r`, `npm --workspace=x`. */
const FLAGS = String.raw`(?:\s+-{1,2}[\w-]+(?:[= ](?!-)\S+)?)*`;

/**
 * Shell commands that are milestones, matched at the start of one command of a chain, ranked: a
 * chain that opens and merges a pull request is a merge.
 */
const SHELL_MILESTONES: ReadonlyArray<readonly [RegExp, MilestoneKind]> = [
  [new RegExp(String.raw`^gh${FLAGS}\s+pr\s+merge\b`), 'merge'],
  [
    new RegExp(String.raw`^${RUNNER}(?:npm|bun|pnpm|yarn(?:\s+npm)?)${FLAGS}\s+publish\b`),
    'publish',
  ],
  [new RegExp(String.raw`^${RUNNER}(?:@changesets\/cli|changeset)${FLAGS}\s+publish\b`), 'publish'],
  [new RegExp(String.raw`^${RUNNER}(?:@inixiative\/config\s+)?train\b.*\s--lane\b`), 'publish'],
  [new RegExp(String.raw`^gh${FLAGS}\s+pr\s+create\b`), 'pull-request'],
];

/** A command that only shows what it would do: never a milestone. */
const REHEARSAL = /\s(?:--help|--dry-run)\b/;

/** Files whose edit changes a standing rule: the rules files (nested too) and the instruction ladder. */
const RULE_FILES: readonly RegExp[] = [
  /(?:^|\/)docs\/rules\/.+\.md$/,
  /(?:^|\/)(?:CLAUDE|AGENTS)(?:\.local)?\.md$/,
];

/**
 * The command a shell call runs: Claude's and Codex's `command` (a string or argv), or `cmd`. An argv
 * that hands a script to a shell (`bash -lc '…'`) runs that script.
 */
export function shellCommandText(input: Readonly<Record<string, unknown>>): string | undefined {
  const command = input.command ?? input.cmd;
  if (Array.isArray(command)) {
    const argv = command.map(String);
    const script = argv.findIndex((arg) => /^-\w*c$/.test(arg));
    return (script >= 0 ? argv[script + 1] : argv.join(' ')) || undefined;
  }
  return typeof command === 'string' && command.trim() ? command : undefined;
}

/**
 * The commands a shell line runs, each with its leading environment assignments and `sudo` dropped.
 * Heredoc bodies and quoted text are data (a commit message, an `echo`, a `grep` pattern), never a
 * command, so they are removed before the line is split on `&&`, `||`, `;`, `|` and newlines.
 */
export function shellCommands(command: string): string[] {
  const code = command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\b/g, ' ')
    .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");
  return code
    .split(/&&|\|\||[;|\n]/)
    .map((part) =>
      part
        .trim()
        .replace(/^\(+\s*/, '')
        .replace(/^(?:\w+=\S*\s+|sudo\s+|exec\s+|time\s+)*/, ''),
    )
    .filter(Boolean);
}

/** The highest-ranked milestone a shell line reaches, if any. */
function shellMilestone(command: string): MilestoneKind | undefined {
  const commands = shellCommands(command).filter((part) => !REHEARSAL.test(` ${part}`));
  return SHELL_MILESTONES.find(([pattern]) => commands.some((part) => pattern.test(part)))?.[1];
}

/**
 * The milestone a tool call reaches, or undefined when it is not one. `when` says whether the chorus
 * hears of it before the call runs (Claude's pre-use gate) or once it has landed (an observed call).
 */
export function milestoneOf(
  call: {
    readonly callId?: string;
    readonly toolName: string;
    readonly toolInput: Readonly<Record<string, unknown>>;
  },
  when: MilestoneMoment['when'],
): MilestoneMoment | undefined {
  const milestoneId = `milestone-call:${call.callId ?? newId('call')}`;
  const base = { milestoneId, tool: call.toolName, when };
  if (foundryOperation(call.toolName) === 'set_status') {
    return call.toolInput.status === 'done'
      ? { ...base, kind: 'done', detail: 'set_status done' }
      : undefined;
  }
  const { capability, paths } = classifyTool({
    toolName: call.toolName,
    toolInput: call.toolInput as Record<string, unknown>,
  });
  if (capability === 'exec:shell') {
    const command = shellCommandText(call.toolInput);
    const kind = command ? shellMilestone(command) : undefined;
    return kind && command ? { ...base, kind, detail: command } : undefined;
  }
  if (capability === 'file:write') {
    const rules = paths.filter((path) => RULE_FILES.some((pattern) => pattern.test(path)));
    return rules.length ? { ...base, kind: 'rule-change', detail: rules.join(', ') } : undefined;
  }
  return undefined;
}
