import { isAbsolute, join } from 'node:path';
import type { ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk';

const KINDS: Record<string, ToolKind> = {
  Read: 'read',
  NotebookRead: 'read',
  LS: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  apply_patch: 'edit',
  Glob: 'search',
  Grep: 'search',
  WebSearch: 'search',
  ToolSearch: 'search',
  Bash: 'execute',
  BashOutput: 'execute',
  KillShell: 'execute',
  shell: 'execute',
  exec_command: 'execute',
  WebFetch: 'fetch',
  TodoWrite: 'think',
  update_plan: 'think',
  Task: 'think',
  ExitPlanMode: 'switch_mode',
};

/** The ACP tool kind hosts render a native tool as; unknown tools are `other`. */
export function toolKind(name: string): ToolKind {
  return KINDS[name] ?? 'other';
}

const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const;
const clip = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** The paths a tool call touches, from its public input, absolute against the session's cwd. */
export function toolLocations(
  input: Readonly<Record<string, unknown>> | undefined,
  cwd?: string,
): ToolCallLocation[] {
  if (!input) return [];
  const locations: ToolCallLocation[] = [];
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value !== 'string' || !value) continue;
    locations.push({ path: isAbsolute(value) || !cwd ? value : join(cwd, value) });
  }
  return locations;
}

/** A short human title: the tool and what it acts on. */
export function toolTitle(
  name: string,
  input: Readonly<Record<string, unknown>> | undefined,
): string {
  if (!input) return name;
  for (const key of [...PATH_KEYS, 'command', 'pattern', 'url', 'query', 'description']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return `${name}: ${clip(value.trim())}`;
  }
  return name;
}
