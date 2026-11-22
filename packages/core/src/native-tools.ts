/**
 * @atlas
 * @kind constant
 * @partOf primitive:tools
 */
import type { Capability } from './capability';

// Native harness tools by what they do: one list for Foundry's tool gate and work items, and for
// Oracle, which reads the same calls out of Archive sessions and never imports Foundry.

/** Shell tools: Claude Code's Bash and its job tools, Codex's shell and exec_command, Antigravity/Gemini CLI's run_command. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set([
  'Bash',
  'BashOutput',
  'KillShell',
  'shell',
  'exec_command',
  'run_command',
]);
/** Tools whose path argument is a file the call writes: Claude Code's editors, Codex's patch, Antigravity/Gemini CLI editors. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'apply_patch',
  'edit_file',
  'write_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
]);
/** Local file/directory read and search tools across Claude Code, Codex, Antigravity, and Gemini CLI. */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'NotebookRead',
  'LS',
  'Glob',
  'Grep',
  'read_file',
  'view_file',
  'list_dir',
  'grep_search',
  'find_by_name',
]);
/** Network fetch/search tools across Claude Code, Antigravity, and Gemini CLI. */
export const FETCH_TOOLS: ReadonlySet<string> = new Set([
  'WebFetch',
  'WebSearch',
  'search_web',
  'read_url_content',
]);
/** Search tools (subset of read/fetch plus ToolSearch) rendered as ACP `search` calls. */
export const SEARCH_TOOLS: ReadonlySet<string> = new Set([
  'Glob',
  'Grep',
  'WebSearch',
  'ToolSearch',
  'grep_search',
  'find_by_name',
  'search_web',
]);

/** Input keys native tools use to name a local file or directory path, in priority order. */
export const TOOL_PATH_KEYS = [
  'file_path',
  'path',
  'notebook_path',
  'Path',
  'TargetFile',
  'AbsolutePath',
  'DirectoryPath',
  'SearchPath',
  'SearchDirectory',
] as const;

/** Trimmed, non-empty, deduplicated local paths named in a tool call's input. */
export function toolInputPaths(input: Readonly<Record<string, unknown>> | undefined): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const key of TOOL_PATH_KEYS) {
    const value = input[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    paths.push(trimmed);
  }
  return paths;
}

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
