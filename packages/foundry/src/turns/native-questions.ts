/**
 * @atlas
 * @kind middleware
 * @partOf feature:toolGate
 */
import type {
  MuseUserInputAnswer,
  MuseUserInputHandler,
  MuseUserInputQuestion,
} from '@inixiative/agent-session';
import type { ActionOption, ActionQueue } from '@inixiative/foundry-core';
import { ASK_TIMEOUT_MS } from './tool-gate';

/** Muse caps each answer's free text and note at 500 characters. */
const ANSWER_MAX = 500;

/**
 * A question the thread's native session asks its person (Muse's `userInput/request`), put to them on
 * Foundry's own prompt queue: the same `ActionQueue` the tool gate asks approvals on, so it shows as
 * "the agent asks" on the thread and the board, and the viewer answers it (an ACP host is sent only
 * approvals today, so a question asked under one waits for the viewer or its timeout). Each question
 * is asked in turn: one with a single choice as a `choice` prompt, any other as an `input` prompt.
 * Nothing answered (a rejection, the ask timing out, Muse withdrawing it) declines the whole request,
 * and agent-session cancels it with a reason, so the turn never hangs.
 */
export function nativeQuestions(
  queue: ActionQueue | undefined,
  threadId: string,
  askTimeoutMs = ASK_TIMEOUT_MS,
): MuseUserInputHandler | undefined {
  if (!queue) return undefined;
  return async (request) => {
    const answers: MuseUserInputAnswer[] = [];
    for (const question of request.questions) {
      const answer = await ask(queue, threadId, request, question, askTimeoutMs);
      if (!answer) return undefined;
      answers.push(answer);
    }
    return answers;
  };
}

async function ask(
  queue: ActionQueue,
  threadId: string,
  request: Parameters<MuseUserInputHandler>[0],
  question: MuseUserInputQuestion,
  timeoutMs: number,
): Promise<MuseUserInputAnswer | undefined> {
  const single = question.selection.mode === 'single' && question.options.length > 0;
  const options: ActionOption[] = question.options.map((option, index) => ({
    id: `option-${index}`,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
  }));
  const choices = question.options.map((option) => option.label);
  const bounds = question.selection;
  const message = [
    question.header && question.header !== question.question ? question.header : undefined,
    question.question,
    !single && choices.length
      ? `Choose ${bounds.minSelections ?? 0}–${bounds.maxSelections ?? choices.length} of: ${choices.join(', ')} (comma-separated), or answer in your own words.`
      : undefined,
  ]
    .filter(Boolean)
    .join('\n');
  const resolution = await queue.prompt({
    kind: single ? 'choice' : 'input',
    message,
    agentId: 'artificer',
    threadId,
    ...(single ? { options } : {}),
    timeoutMs,
    signal: request.signal,
    meta: {
      question: true,
      questionId: question.id,
      userInputId: request.userInputId,
      ...(request.toolName ? { toolName: request.toolName } : {}),
      ...(request.turnId ? { nativeTurnId: request.turnId } : {}),
    },
  });
  const note = resolution.note ? { note: resolution.note.slice(0, ANSWER_MAX) } : {};
  if (single) {
    const chosen = options.find((option) => option.id === resolution.action);
    return chosen ? { questionId: question.id, selectedLabel: chosen.label, ...note } : undefined;
  }
  const text = resolution.input?.trim();
  // The viewer's Reject sends `reject`; a timeout or a withdrawal resolves `rejected`.
  if (resolution.action === 'reject' || resolution.action === 'rejected' || !text) return undefined;
  // Every comma-separated part names an offered option: the selection; anything else is free text.
  const parts = text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const picked = parts.map((part) =>
    choices.find((choice) => choice.toLowerCase() === part.toLowerCase()),
  );
  if (choices.length && picked.length && picked.every((choice) => choice !== undefined))
    return { questionId: question.id, selectedLabels: picked as string[], ...note };
  return { questionId: question.id, freeText: text.slice(0, ANSWER_MAX), ...note };
}
