// ---------------------------------------------------------------------------
// Work items: what the `consumed` trigger asks the Wardens about
//
// A work item is a ticket, spec, issue or page the main thread took in: a `Read` of a file whose path
// matches the project's `chorus.consumed.paths`, or a tool call whose name matches `tools` (a Linear
// issue or document, a Notion page). Its text is the file itself for a read (an observation's output
// may be a bounded summary), the call's output for a fetch; either way clipped to `maxChars`.
// ---------------------------------------------------------------------------

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { computeHash } from '@inixiative/foundry-core';
import { classifyTool } from '../turns/tool-gate';
import type { ConsumedSettings } from '../viewer/config';
import type { ToolObservation } from './domain-librarian';
import type { WorkItemMoment } from './flow-orchestrator';

/**
 * Linear issues and documents, Notion pages, under any MCP server name that says which it is. Tool
 * names match case-insensitively (`mcp__claude_ai_Notion__notion-fetch`, `mcp__plugin_linear_linear__get_issue`).
 */
export const DEFAULT_CONSUMED_TOOLS: readonly string[] = Object.freeze([
  'mcp__*linear*__get_issue',
  'mcp__*linear*__get_document',
  'mcp__*notion*__*fetch*',
]);

/** Where tickets and specs are usually written in a repository: prose files only, never test specs. */
export const DEFAULT_CONSUMED_PATHS: readonly string[] = Object.freeze([
  '**/tickets/**/*.{md,txt}',
  '**/specs/**/*.{md,txt}',
  '**/*.spec.md',
  '**/SPEC*.md',
  '**/docs/design/**/*.md',
]);

/**
 * A work item is clipped to this by default: a Warden holds about 20k tokens of knowledge (Foundry
 * #81) and the moment should not outweigh it.
 */
export const DEFAULT_CONSUMED_MAX_CHARS = 12_000;

/** A file larger than this is not read from disk for a work item; its observed output is used, or nothing. */
const MAX_FILE_BYTES = 1_000_000;

/** Fields a fetch tool names its item by, in the order they are tried. */
const ID_KEYS = ['id', 'issueId', 'issue_id', 'documentId', 'pageId', 'page_id', 'url'] as const;

/** A project's consumed trigger with its defaults applied; undefined while it is off. */
export interface ConsumedMatcher {
  readonly tools: readonly Bun.Glob[];
  readonly paths: readonly Bun.Glob[];
  readonly maxChars: number;
}

export function consumedMatcher(
  settings: ConsumedSettings | undefined,
): ConsumedMatcher | undefined {
  if (!settings?.enabled) return undefined;
  return {
    tools: (settings.tools ?? DEFAULT_CONSUMED_TOOLS).map(
      (glob) => new Bun.Glob(glob.toLowerCase()),
    ),
    paths: (settings.paths ?? DEFAULT_CONSUMED_PATHS).map((glob) => new Bun.Glob(glob)),
    maxChars: settings.maxChars ?? DEFAULT_CONSUMED_MAX_CHARS,
  };
}

/** A path as the matcher reads it: relative to the project when inside it, as given otherwise. */
function projectPath(path: string, root: string | undefined): string {
  if (!root) return path;
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  const rel = relative(root, absolute);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

function readBounded(path: string, root: string | undefined): string | undefined {
  try {
    const absolute = isAbsolute(path) || !root ? path : resolve(root, path);
    const stat = statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
    return readFileSync(absolute, 'utf8');
  } catch {
    return undefined;
  }
}

function clip(text: string, max: number): { text: string; clipped?: number } {
  return text.length <= max ? { text } : { text: text.slice(0, max), clipped: text.length - max };
}

/** A work item with the key it is asked once by in a thread. */
export interface WorkItem extends WorkItemMoment {
  /** A file: its path and whole content (chunked reads of it are one item; an edited file is a new one). A fetch: its tool and id. */
  readonly key: string;
}

/**
 * The work item one observed call took in, or undefined when the call is not one: a failed call, a
 * read whose path no glob matches, a tool no glob names, or an item with no text.
 */
export function workItemOf(
  observation: ToolObservation,
  matcher: ConsumedMatcher,
  root: string | undefined,
): WorkItem | undefined {
  if (observation.ok === false) return undefined;
  const { capability, paths } = classifyTool({
    toolName: observation.tool,
    toolInput: observation.input ?? {},
  });
  if (capability === 'file:read' && observation.tool === 'Read') {
    const path = paths[0];
    if (!path) return undefined;
    const name = projectPath(path, root);
    if (!matcher.paths.some((glob) => glob.match(name))) return undefined;
    // The file itself first: an observation's output may be a bounded summary of what was read.
    const text = readBounded(path, root) ?? observation.output;
    if (!text?.trim()) return undefined;
    const itemId = `${observation.tool}:${name}`;
    return {
      itemId,
      key: `${itemId}:${computeHash(text)}`,
      name,
      tool: observation.tool,
      ...clip(text, matcher.maxChars),
    };
  }
  const tool = observation.tool.toLowerCase();
  if (!matcher.tools.some((glob) => glob.match(tool))) return undefined;
  const text = observation.output;
  if (!text?.trim()) return undefined;
  const input = observation.input ?? {};
  const id = ID_KEYS.map((key) => input[key]).find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  const name = id ?? observation.tool;
  const itemId = `${observation.tool}:${name}`;
  return {
    itemId,
    // A fetch with no id field the matcher knows is keyed by what it returned, so later fetches differ.
    key: id ? itemId : `${itemId}:${computeHash(text)}`,
    name,
    tool: observation.tool,
    ...clip(text, matcher.maxChars),
  };
}
