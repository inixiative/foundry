/**
 * @atlas
 * @kind transformer
 * @partOf feature:acp
 */
import { isAbsolute, join } from 'node:path';
import type { PlanEntry, ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk';
import {
  FETCH_TOOLS,
  READ_TOOLS,
  SEARCH_TOOLS,
  SHELL_TOOLS,
  TOOL_PATH_KEYS,
  toolInputPaths,
  WRITE_TOOLS,
} from '@inixiative/foundry/client';

const THINK_TOOLS: ReadonlySet<string> = new Set(['TodoWrite', 'update_plan', 'Task']);

/** The ACP tool kind hosts render a native tool as; unknown tools are `other`. */
export function toolKind(name: string): ToolKind {
  if (SEARCH_TOOLS.has(name)) return 'search';
  if (WRITE_TOOLS.has(name)) return 'edit';
  if (READ_TOOLS.has(name)) return 'read';
  if (SHELL_TOOLS.has(name)) return 'execute';
  if (FETCH_TOOLS.has(name)) return 'fetch';
  if (THINK_TOOLS.has(name)) return 'think';
  if (name === 'ExitPlanMode') return 'switch_mode';
  return 'other';
}

const TITLE_KEYS = [
  ...TOOL_PATH_KEYS,
  'command',
  'CommandLine',
  'pattern',
  'Pattern',
  'url',
  'Url',
  'query',
  'Query',
  'description',
] as const;
const clip = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** The paths a tool call touches, from its public input, absolute against the session's cwd. */
export function toolLocations(
  input: Readonly<Record<string, unknown>> | undefined,
  cwd?: string,
): ToolCallLocation[] {
  const seen = new Set<string>();
  const locations: ToolCallLocation[] = [];
  for (const value of toolInputPaths(input)) {
    const path = isAbsolute(value) || !cwd ? value : join(cwd, value);
    if (seen.has(path)) continue;
    seen.add(path);
    locations.push({ path });
  }
  return locations;
}

/** A short human title: the tool and what it acts on. */
export function toolTitle(
  name: string,
  input: Readonly<Record<string, unknown>> | undefined,
): string {
  if (!input) return name;
  for (const key of TITLE_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return `${name}: ${clip(value.trim())}`;
  }
  return name;
}

/** The executor's own plan tools: Claude `TodoWrite {todos}`, Codex `update_plan {plan}`. */
export const PLAN_TOOLS = new Set(['TodoWrite', 'update_plan']);

const PLAN_STATUS: Record<string, PlanEntry['status']> = {
  pending: 'pending',
  in_progress: 'in_progress',
  inProgress: 'in_progress',
  completed: 'completed',
};

/** ACP plan entries from a plan tool's input, or null when it carries none. */
export function planEntries(
  toolName: string,
  input: Readonly<Record<string, unknown>> | undefined,
): PlanEntry[] | null {
  if (!input || !PLAN_TOOLS.has(toolName)) return null;
  const [list, label] = toolName === 'TodoWrite' ? [input.todos, 'content'] : [input.plan, 'step'];
  if (!Array.isArray(list)) return null;
  return list.flatMap((item) => {
    const entry = item as Record<string, unknown> | null;
    const content = entry?.[label];
    if (typeof content !== 'string' || !content.trim()) return [];
    return [
      {
        content,
        priority: 'medium' as const,
        status: PLAN_STATUS[String(entry?.status)] ?? 'pending',
      },
    ];
  });
}
