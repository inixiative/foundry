/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * One thread's status, from the fields the viewer already has. Pure: no DOM, no store.
 *
 * The most urgent category wins: red (the last turn failed) › orange (something waits on you) ›
 * green (working) › light yellow (queued) › light blue (done) › neutral (idle, paused) › charcoal
 * (archived). The board's lanes are these categories (`categoryOf`), so a thread is classified once.
 *
 * Inputs:
 *   thread.meta.status       idle | active | waiting | archived (+ legacy completed / done)
 *   thread.meta.setup        { status: 'starting' | 'ready' | 'degraded' }
 *   thread.lastTurn          { status: 'queued' | 'running' | 'completed' | 'failed' } (newest live turn)
 *   thread.conversation      { unread, paused, held, members }
 *   prompts                  pending ActionQueue prompts for this thread
 *   childrenWorking          true when a child thread (subagent) is working
 */
import { STATES } from './status-icons.js';

/** A thread whose stored status is one of these is closed (archived, completed or done). The one list. */
export const CLOSED_STATUSES = new Set(['archived', 'completed', 'done']);

/** Is the thread (or a stored status) closed? */
export const isClosedThread = (thread) =>
  CLOSED_STATUSES.has(thread?.meta?.status ?? thread?.status ?? '');

/** The orange state a pending prompt stands for. */
export function promptState(prompt) {
  const meta = prompt?.meta ?? {};
  if (meta.conversationFloorRequest) return 'request';
  if (meta.conversationHeld) return 'held';
  if (prompt?.kind === 'approval' || prompt?.kind === 'confirm') return 'approve';
  return 'question';
}

/**
 * @param {{ meta?: { status?: string, setup?: { status?: string } }, lastTurn?: { status?: string },
 *   conversation?: { unread?: number, paused?: unknown, held?: number } }} thread
 * @param {{ prompts?: Array<{ kind?: string, meta?: Record<string, unknown> }>, childrenWorking?: boolean }} [context]
 * @returns {keyof typeof STATES}
 */
/** Is this snooze (a thread's `meta.snooze`) still running? One whose time has passed is not. */
export const snoozeRunning = (snooze, now = Date.now()) =>
  !!snooze && Date.parse(snooze.until) > now;

export function threadState(thread, context = {}) {
  const meta = thread?.meta ?? {};
  const turn = thread?.lastTurn?.status;
  const conversation = thread?.conversation ?? {};
  const prompts = context.prompts ?? [];
  if (CLOSED_STATUSES.has(meta.status ?? '')) return 'archived';
  if (turn === 'failed') return 'error';
  if (prompts.length) return promptState(prompts[0]);
  if ((conversation.held ?? 0) > 0) return 'held';
  if ((conversation.unread ?? 0) > 0) return 'request';
  // A snooze quiets the calm states; a problem or a request for you still shows.
  if (snoozeRunning(thread?.meta?.snooze)) return 'snoozed';
  if (meta.setup?.status === 'starting') return 'starting';
  if (turn === 'running' || meta.status === 'active') return 'working';
  if (context.childrenWorking) return 'subagents';
  if (turn === 'queued') return 'queued';
  if (meta.status === 'waiting' || conversation.paused) return 'paused';
  // Done: its branch merged, or the agent marked a plan milestone; the owner's next message clears it.
  if (meta.done) return 'done';
  // Until "seen by Aron" exists, an idle thread whose last turn completed reads as done.
  if (turn === 'completed') return 'done';
  return 'idle';
}

/** What a done thread says: its done text ("Merged into main", a milestone), else the state's label. */
export const doneText = (thread) => thread?.meta?.done?.text ?? null;

/** The colour category of a state: red, orange, green, yellow, blue, neutral, charcoal. */
export const categoryOf = (state) => STATES[state]?.cat ?? 'idle';

/**
 * The thread a row nests under: only a subagent nests (it carries `meta.spawn`, set where the
 * executor spawned it). A thread a person started from another one ("start another thread",
 * fork) keeps `parentThreadId` for Plan's link but lists flat.
 */
export function subagentParentOf(meta) {
  return meta?.spawn && meta.parentThreadId ? meta.parentThreadId : null;
}
