/**
 * @atlas
 * @kind transformer
 * @partOf feature:threads
 */
/**
 * Instruction wrappers a host adds around the user's words. T3 Code sends ACP agents its own
 * context in the user prompt (`t3:packages/provider-core/src/server/orchestrationInstructions.ts`,
 * `runtimeInstructions.ts`, `packages/provider-acp/src/server/adapter.ts`):
 * - leading `<t3_code_instructions>…</t3_code_instructions>` or
 *   `<t3_code_orchestration_instructions>…</t3_code_orchestration_instructions>` around
 *   `<user_request>\n…\n</user_request>`, and
 * - trailing `<runtime_info>…</runtime_info>`, `<pull_request_linking>…</pull_request_linking>`,
 *   and `<workspace_folders>…</workspace_folders>` blocks (on the first turn after `</user_request>`,
 *   and on later turns when runtime context changes or after compaction).
 * The agent receives the prompt verbatim; what learns from the message (classification, routing,
 * Warden advice and review, capture, naming) reads only the user's words, so a host's instructions
 * never count as the user's.
 */
const LEADING_HOST_TAGS = ['t3_code_instructions', 't3_code_orchestration_instructions'] as const;
const TRAILING_HOST_TAGS = ['runtime_info', 'pull_request_linking', 'workspace_folders'] as const;

export interface HostInstruction {
  readonly tag: string;
  readonly text: string;
}

export interface SplitPrompt {
  /** The user's own words. */
  readonly userText: string;
  /** The host's instruction blocks, in order. */
  readonly instructions: readonly HostInstruction[];
}

const LEADING_BLOCK = new RegExp(`^<(${LEADING_HOST_TAGS.join('|')})>([\\s\\S]*?)</\\1>\\s*`);
const REQUEST = /^<user_request>(?:\r?\n)?([\s\S]*?)(?:\r?\n)?<\/user_request>\s*$/;
const BLANK_LINE_END = /\r?\n\r?\n$/;

function peelTrailingBlocks(input: string): { rest: string; trailing: HostInstruction[] } {
  let rest = input.trimEnd();
  const trailing: HostInstruction[] = [];
  for (;;) {
    let matched = false;
    for (const tag of TRAILING_HOST_TAGS) {
      const closeTag = `</${tag}>`;
      if (!rest.endsWith(closeTag)) continue;
      const openTag = `<${tag}>`;
      const openIdx = rest.lastIndexOf(openTag);
      if (openIdx === -1) continue;
      const prefix = rest.slice(0, openIdx);
      // Standalone block: starts the prompt (unindented) or follows a blank line (T3 joins blocks
      // with `\n\n`), so inline prose and single-newline examples stay intact.
      if (openIdx > 0 && !BLANK_LINE_END.test(prefix)) continue;
      const bodyStart = openIdx + openTag.length;
      const bodyEnd = rest.length - closeTag.length;
      const body = rest.slice(bodyStart, bodyEnd);
      if (body.includes(openTag) || body.includes(closeTag)) continue;
      // Guard unclosed/nested opening tag in the prefix (e.g. `<runtime_info>a\n\n<runtime_info>b</runtime_info>`).
      const prevOpen = prefix.lastIndexOf(openTag);
      if (prevOpen !== -1 && prevOpen > prefix.lastIndexOf(closeTag)) continue;
      trailing.unshift({ tag, text: body.trim() });
      rest = prefix.trimEnd();
      matched = true;
      break;
    }
    if (!matched) break;
  }
  return { rest, trailing };
}

/** The user's words and the host's wrappers, or null when the prompt carries no known wrapper. */
export function splitHostInstructions(prompt: string): SplitPrompt | null {
  let rest = prompt;
  const leading: HostInstruction[] = [];
  const trimmedLead = prompt.trimStart();
  if (LEADING_BLOCK.test(trimmedLead)) {
    rest = trimmedLead;
    for (let match = LEADING_BLOCK.exec(rest); match; match = LEADING_BLOCK.exec(rest)) {
      leading.push({ tag: match[1]!, text: match[2]!.trim() });
      rest = rest.slice(match[0].length);
    }
  }
  const { rest: body, trailing } = peelTrailingBlocks(rest);
  if (!leading.length && !trailing.length) return null;
  if (leading.length) {
    const request = REQUEST.exec(body);
    if (!request) return null;
    return { userText: request[1]!, instructions: [...leading, ...trailing] };
  }
  return { userText: body, instructions: trailing };
}
