/**
 * @atlas
 * @kind middleware
 * @partOf feature:threadTree, feature:wardens
 */
import type { ToolDecision, ToolGate, ToolRequest } from '@inixiative/agent-session';
import { type PromptBlock, withAfterMessageNotes } from '@inixiative/foundry-core';
import type { HandoffMoment } from '../agents/flow-orchestrator';

/**
 * Every turn that would get injection calls the Wardens, subagents included (Aron, 2026-11-02:
 * "Subagents, absolutely. Call the wardens. Any turn that would require injection."). A native
 * subagent's turn starts from the text its parent writes into one tool call: the Agent (or Task)
 * call that spawns it, or a SendMessage that hands it more work. So the chorus is asked at that call,
 * before it runs (the tool gate's `pre-use` stage, Claude only), the same way it is asked on a main
 * thread's message, and what it says rides into that text the way a main thread's chimes ride its
 * message. A SendMessage is a subagent's turn only when it names one of the thread's own subagents;
 * to another session or a teammate it is that thread's message, advised there. Codex and Muse have no pre-use stage: their subagents are briefed when they start, and the
 * brief rides the parent's next turn.
 */

/** The tool calls that hand a subagent its turn, and the input field holding the text it reads. */
export const HANDOFF_TOOLS: Readonly<Record<string, 'prompt' | 'message'>> = {
  Agent: 'prompt',
  Task: 'prompt',
  SendMessage: 'message',
};

/** A handoff the thread's executor is about to make, as its tool call carries it. */
export interface HandoffCall {
  readonly callId?: string;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  /** The thread's turn in flight, for the journal. */
  readonly turnId: string | null;
  /** Claude's subagent id when a subagent (not the main thread) makes the call. */
  readonly agentId?: string;
  /** Aborted when the runtime withdraws the call (an interrupt): the brief stops waiting for it. */
  readonly signal?: AbortSignal;
}

/** An agent address as Claude resolves SendMessage's `to`: NFKC, trimmed, lower case, spaces to `-`. */
export const subagentAddress = (address: string): string =>
  address.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '-');

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);

/** The handoff moment a call makes, or undefined when it hands no subagent any text. */
export function handoffMoment(
  call: Pick<HandoffCall, 'callId' | 'toolName' | 'toolInput'>,
): { moment: HandoffMoment; field: 'prompt' | 'message' } | undefined {
  const field = HANDOFF_TOOLS[call.toolName];
  const prompt = field ? text(call.toolInput[field]) : undefined;
  if (!field || !prompt) return undefined;
  const description = text(call.toolInput.description) ?? text(call.toolInput.summary);
  const agentType =
    text(call.toolInput.subagent_type) ??
    (field === 'message' ? text(call.toolInput.to) : undefined);
  return {
    field,
    moment: {
      // The child thread exists only once the subagent starts (task_started); the call names it.
      childThreadId: '',
      handoffId: `handoff-call:${call.callId ?? 'unknown'}`,
      ...(description ? { description } : {}),
      ...(agentType ? { agentType } : {}),
      prompt,
    },
  };
}

/** The text the subagent reads: its task, then the reception charter and the chimes, as a main thread's. */
export function briefedText(
  prompt: string,
  notes: readonly PromptBlock[],
  reception?: string,
): string {
  if (!notes.length) return prompt;
  return withAfterMessageNotes(prompt, [
    ...(reception ? [{ role: 'content' as const, id: 'chorus-reception', text: reception }] : []),
    ...notes,
  ]);
}

/**
 * How long a handoff waits for its brief before it runs without one. A brief that lands later rides
 * the parent's next turn instead, as a brief made when the subagent starts does.
 */
export const HANDOFF_BRIEF_DEADLINE_MS = 45_000;

/**
 * A thread's tool gate with the handoff brief after it: a `pre-use` handoff the gate allowed is
 * briefed, and its text rewritten when a Warden spoke. A deny, a permission ask, any other tool and
 * a brief that fails or comes back empty pass through unchanged.
 */
export function withHandoffBrief(
  gate: ToolGate,
  brief: (call: HandoffCall) => Promise<string | undefined> | undefined,
  options: { turnId: () => string | null; warn?: (line: string) => void },
): ToolGate {
  return async (request: ToolRequest): Promise<ToolDecision> => {
    const decision = await gate(request);
    if (decision.behavior !== 'allow' || request.stage !== 'pre-use') return decision;
    const field = HANDOFF_TOOLS[request.toolName];
    if (!field) return decision;
    const input = decision.updatedInput ?? request.toolInput;
    try {
      const briefed = await brief({
        ...(request.callId ? { callId: request.callId } : {}),
        toolName: request.toolName,
        toolInput: input,
        turnId: options.turnId(),
        ...(request.agentId ? { agentId: request.agentId } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (!briefed || briefed === input[field]) return decision;
      return { behavior: 'allow', updatedInput: { ...input, [field]: briefed } };
    } catch (error) {
      options.warn?.(`handoff brief failed, the call runs unbriefed: ${(error as Error)?.message}`);
      return decision;
    }
  };
}
