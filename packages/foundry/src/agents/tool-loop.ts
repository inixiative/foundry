// ---------------------------------------------------------------------------
// Tool-use loop — agents call tools, get results, iterate
// ---------------------------------------------------------------------------
//
// This is the core execution loop that makes agents actually DO things.
// Without it, agents are one-shot text generators. With it, they can:
//   1. Read files (via shell tool)
//   2. Search memory (via memory tool)
//   3. Run code (via script tool)
//   4. Make API calls (via api tool)
//   5. Iterate based on results
//
// The loop:
//   1. Send completion request with tool definitions
//   2. If LLM returns tool calls → execute via ToolRegistry.dispatch()
//   3. Append tool results to conversation
//   4. Repeat until LLM returns text (no more tool calls) or max iterations
//
// For ClaudeCodeProvider: the CLI handles its own tool loop internally.
// This loop is for API-based providers (Anthropic, OpenAI, Gemini).
// ---------------------------------------------------------------------------

import type {
  LLMProvider,
  LLMMessage,
  CompletionOpts,
  CompletionResult,
  ToolCallResult,
} from "@inixiative/foundry-core";
import { ToolRegistry } from "@inixiative/foundry-core";

export interface ToolLoopOpts extends CompletionOpts {
  /** Max tool-use iterations before forcing a text response. Default: 10. */
  maxIterations?: number;
  /** Callback fired after each tool execution. */
  onToolCall?: (toolName: string, input: Record<string, unknown>, result: string) => void;
}

/**
 * Execute a completion with tool-use loop.
 *
 * Sends the request with tool definitions from the registry. When the LLM
 * returns tool calls, executes them via registry.dispatch() and feeds results
 * back. Repeats until the LLM returns text or maxIterations is reached.
 *
 * Returns the final CompletionResult (with text content, not tool calls).
 */
export async function toolUseLoop(
  provider: LLMProvider,
  messages: LLMMessage[],
  tools: ToolRegistry,
  opts?: ToolLoopOpts,
): Promise<CompletionResult> {
  const maxIterations = opts?.maxIterations ?? 10;
  const toolDefinitions = tools.toToolDefinitions();

  // If no tools registered, just do a normal completion
  if (toolDefinitions.length === 0) {
    return provider.complete(messages, opts);
  }

  // Build conversation as a mutable array for the loop
  const conversation: LLMMessage[] = [...messages];
  let totalTokens = { input: 0, output: 0 };

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const result = await provider.complete(conversation, {
      ...opts,
      tools: true,
      toolDefinitions,
    });

    // Accumulate tokens
    if (result.tokens) {
      totalTokens.input += result.tokens.input;
      totalTokens.output += result.tokens.output;
    }

    // No tool calls → we're done, return the text response
    if (!result.toolCalls || result.toolCalls.length === 0) {
      return {
        ...result,
        tokens: totalTokens.input > 0 ? totalTokens : result.tokens,
      };
    }

    // Append the assistant's tool-call message
    // (The provider should include this in its response handling,
    //  but we track it here for the conversation history)
    conversation.push({
      role: "assistant",
      content: result.content || `[Tool calls: ${result.toolCalls.map((tc) => tc.name).join(", ")}]`,
    });

    // Execute each tool call and collect results
    const toolResults: ToolCallResult[] = [];

    for (const call of result.toolCalls) {
      const toolResult = await tools.dispatch(call.name, call.input);

      const resultContent = toolResult.ok
        ? toolResult.data
          ? JSON.stringify(toolResult.data)
          : toolResult.summary
        : `Error: ${toolResult.error ?? toolResult.summary}`;

      toolResults.push({
        toolCallId: call.id,
        content: resultContent,
        isError: !toolResult.ok,
      });

      // Fire callback
      opts?.onToolCall?.(call.name, call.input, resultContent);
    }

    // Append tool results as a user message
    // (In a real provider integration, these would be tool_result messages.
    //  For our simplified LLMMessage interface, we format as structured text.)
    const resultText = toolResults.map((tr) => {
      const status = tr.isError ? "ERROR" : "OK";
      return `[Tool Result ${tr.toolCallId}] (${status})\n${tr.content}`;
    }).join("\n\n");

    conversation.push({
      role: "user",
      content: resultText,
    });
  }

  // Max iterations reached — do one final completion without tools
  const finalResult = await provider.complete(conversation, {
    ...opts,
    tools: false,
    toolDefinitions: undefined,
  });

  if (finalResult.tokens) {
    totalTokens.input += finalResult.tokens.input;
    totalTokens.output += finalResult.tokens.output;
  }

  return {
    ...finalResult,
    tokens: totalTokens.input > 0 ? totalTokens : finalResult.tokens,
  };
}
