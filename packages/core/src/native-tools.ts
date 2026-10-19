/**
 * @atlas
 * @kind constant
 * @partOf primitive:tools
 */
import type { Capability } from './capability';

// Native harness tools by what they do: one list for Foundry's tool gate and work items, and for
// Oracle, which reads the same calls out of Archive sessions and never imports Foundry.

/** Shell tools: Claude Code's Bash and its job tools, Codex's shell and exec_command. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set([
  'Bash',
  'BashOutput',
  'KillShell',
  'shell',
  'exec_command',
]);
/** Tools whose path argument is a file the call writes: Claude Code's editors, Codex's patch. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'apply_patch',
]);
export const READ_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'NotebookRead',
  'LS',
  'Glob',
  'Grep',
]);
export const FETCH_TOOLS: ReadonlySet<string> = new Set(['WebFetch', 'WebSearch']);

/** The capability a native tool call exercises, by its name alone. */
export function toolCapability(toolName: string): Capability {
  if (SHELL_TOOLS.has(toolName)) return 'exec:shell';
  if (WRITE_TOOLS.has(toolName)) return 'file:write';
  if (READ_TOOLS.has(toolName)) return 'file:read';
  if (FETCH_TOOLS.has(toolName)) return 'net:fetch';
  if (toolName.startsWith('mcp__')) return 'net:api';
  return `tool:${toolName}`;
}

/** A Linear issue fetch under any MCP server name. Globs match case-insensitively (`toolGlobMatcher`). */
export const LINEAR_ISSUE_TOOLS: readonly string[] = Object.freeze(['mcp__*linear*__get_issue']);

/** Tools that fetch a work item: Linear issues and documents, Notion pages, under any MCP server name. */
export const DEFAULT_CONSUMED_TOOLS: readonly string[] = Object.freeze([
  ...LINEAR_ISSUE_TOOLS,
  'mcp__*linear*__get_document',
  'mcp__*notion*__*fetch*',
]);

/** Whether a tool name matches any of the globs, case-insensitively. */
export function toolGlobMatcher(globs: readonly string[]): (toolName: string) => boolean {
  const compiled = globs.map((glob) => new Bun.Glob(glob.toLowerCase()));
  return (toolName) => {
    const name = toolName.toLowerCase();
    return compiled.some((glob) => glob.match(name));
  };
}

/** Fields a fetch tool names its item by, in the order they are tried. */
export const WORK_ITEM_ID_KEYS = [
  'id',
  'issueId',
  'issue_id',
  'documentId',
  'pageId',
  'page_id',
  'url',
] as const;

/** The item a fetch call names: the first non-empty string among `WORK_ITEM_ID_KEYS`. */
export function workItemId(input: Readonly<Record<string, unknown>>): string | undefined {
  return WORK_ITEM_ID_KEYS.map((key) => input[key]).find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
}
