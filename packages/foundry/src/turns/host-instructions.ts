/**
 * @atlas
 * @kind transformer
 * @partOf feature:threads
 */
/**
 * Instruction wrappers a host adds around the user's words. T3 Code sends ACP agents its own
 * context in the user prompt (`t3:packages/provider-core/src/server/orchestrationInstructions.ts`):
 * `<t3_code_instructions>…</t3_code_instructions>\n\n<user_request>\n…\n</user_request>`, or the
 * same with `<t3_code_orchestration_instructions>`. The agent receives the prompt verbatim; what
 * learns from the message (classification, routing, Warden advice and review, capture, naming)
 * reads only the user's words, so a host's instructions never count as the user's.
 */
const HOST_INSTRUCTION_TAGS = ['t3_code_instructions', 't3_code_orchestration_instructions'];

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

const BLOCK = new RegExp(`^<(${HOST_INSTRUCTION_TAGS.join('|')})>([\\s\\S]*?)</\\1>\\s*`);
const REQUEST = /^<user_request>\n?([\s\S]*?)\n?<\/user_request>\s*$/;

/** The user's words and the host's wrappers, or null when the prompt carries no known wrapper. */
export function splitHostInstructions(prompt: string): SplitPrompt | null {
  let rest = prompt.trimStart();
  const instructions: HostInstruction[] = [];
  for (let match = BLOCK.exec(rest); match; match = BLOCK.exec(rest)) {
    instructions.push({ tag: match[1]!, text: match[2]!.trim() });
    rest = rest.slice(match[0].length);
  }
  if (!instructions.length) return null;
  const request = REQUEST.exec(rest);
  if (!request) return null;
  return { userText: request[1]!, instructions };
}
