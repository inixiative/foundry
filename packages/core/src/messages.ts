import type { AssembledContext } from "./context-stack";
import type { LLMMessage } from "./types";

/**
 * Convert an AssembledContext (from stack.assemble()) into LLMMessages
 * ready for any provider.
 */
export function assembledToMessages(
  assembled: AssembledContext,
  userPayload: string
): LLMMessage[] {
  const messages: LLMMessage[] = [];

  if (assembled.blocks.length > 0) {
    const systemParts: string[] = [];

    for (const block of assembled.blocks) {
      if (block.role === "system") {
        systemParts.push(block.text);
      } else if (block.role === "layer") {
        systemParts.push(`[${block.id}]: ${block.text}`);
      } else if (block.role === "content") {
        systemParts.push(block.text);
      }
    }

    messages.push({ role: "system", content: systemParts.join("\n\n") });
  }

  messages.push({ role: "user", content: userPayload });

  return messages;
}

/**
 * Split LLMMessages into provider-friendly parts.
 */
export function splitSystemMessage(messages: LLMMessage[]): {
  system: string | undefined;
  turns: LLMMessage[];
} {
  const systemParts: string[] = [];
  const turns: LLMMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
    } else {
      turns.push(msg);
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    turns,
  };
}
