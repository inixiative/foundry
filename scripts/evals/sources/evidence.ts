/**
 * @atlas
 * @kind client
 * @partOf feature:evals
 */
/** Who wrote a comment: the person's own Claude Code and Codex sessions as evidence. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionEvidence } from '../../../packages/core/src';

function* jsonlFiles(roots: readonly string[]): Generator<string> {
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root, { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const entry of entries) if (entry.endsWith('.jsonl')) yield join(root, entry);
  }
}

/** Tool calls through which an agent writes to Linear (the MCP tools or the API). */
export const LINEAR_POSTING =
  /save_issue|save_comment|create_issue|create_comment|api\.linear\.app|mcp__[\w-]*linear/i;

/** Commands and files through which an agent posts review text to GitHub. */
export const GITHUB_POSTING =
  /gh (?:pr (?:comment|review)|api)|--body|body-file|addPullRequestReview|\/comments|\/reviews|"name":"Write"[^\n]*(?:comment|review|reply|body)/i;

/**
 * Find the session that wrote each comment: its snippet inside a tool call that posts to GitHub (an
 * agent posted it to the service `posting` names), inside another tool call (an agent drafted it, e.g. a body file), or inside a
 * message the person typed (they dictated it). Text an agent only read back (tool results) is not
 * evidence.
 */
export async function sessionEvidence(
  items: readonly { id: string; body: string }[],
  roots: readonly string[],
  snippetOf: (text: string) => string | undefined,
  posting: RegExp = GITHUB_POSTING,
): Promise<Map<string, SessionEvidence>> {
  const snippets = new Map<string, string[]>();
  for (const item of items) {
    const snippet = snippetOf(item.body);
    if (snippet) snippets.set(snippet, [...(snippets.get(snippet) ?? []), item.id]);
  }
  const evidence = new Map<string, SessionEvidence>();
  if (!snippets.size) return evidence;
  for (const file of jsonlFiles(roots)) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const toolCall =
        /"type":"tool_use"|"type":"function_call"|"type":"custom_tool_call"/.test(line) &&
        !/"type":"tool_result"|function_call_output/.test(line);
      const typed =
        !toolCall &&
        /"type":"user"|"role":"user"/.test(line) &&
        !/"tool_result"|"toolUseResult"|function_call_output|"isMeta":true/.test(line);
      if (!toolCall && !typed) continue;
      const kind = typed ? 'typed' : posting.test(line) ? 'posted' : 'drafted';
      for (const [snippet, ids] of snippets) {
        if (!line.includes(snippet)) continue;
        for (const id of ids) evidence.set(id, { ...evidence.get(id), [kind]: true });
      }
    }
  }
  return evidence;
}
