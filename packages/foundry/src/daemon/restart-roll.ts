/**
 * @atlas
 * @kind service
 * @partOf feature:daemon
 */
/**
 * The spin-down: how the daemon restarts onto an update without cutting work (Aron, 2026-11-02:
 * "Pause: finish all open threads. Don't stop them. Everything else waits. Once the last one
 * finishes, restart, then reopen").
 *
 * When the supervisor offers a staged update, the daemon spins down: turns already running finish
 * normally; new messages are still accepted but wait in the queue ("waiting for Foundry to
 * restart"); nothing new starts. A turn waiting on a person (an approval) doesn't count as running.
 * When the last running turn finishes, every waiting turn is held in the journal
 * (`restart-hold`) and the daemon restarts; the next boot runs them in the order they arrived, and
 * threads resume their native sessions through their bindings. A timeout (default 60 minutes) is
 * only a backstop: past it the daemon restarts anyway and each cut turn is settled from its native
 * record (`turns/native-outcome-recovery.ts`). The owner can restart now or postpone the update.
 */

import type { ActionQueue } from '@inixiative/foundry-core';

export interface RunningTurnRef {
  threadId: string;
  turnId: string;
}

export interface UpdateOffer {
  /** The release the restart boots (a commit). */
  candidate: string;
  /** Exit so launchd relaunches onto the candidate; provided by the supervisor. */
  restart: () => void;
  /** Backstop: restart anyway after this long. */
  timeoutMs?: number;
}

export type RollPhase = 'idle' | 'spinning-down' | 'postponed' | 'restarting';

export interface RollStatus {
  phase: RollPhase;
  candidate?: string;
  /** When the spin-down began. */
  since?: number;
  /** When the backstop restarts it anyway. */
  deadline?: number;
  /** Turns the restart waits for. */
  running: RunningTurnRef[];
  /** Other work the restart waits for (plan drafts being written after a turn). */
  finishing: number;
  /** Background processes agents started; a restart stops them. */
  background: Array<{ threadId: string; label: string }>;
  /** Accepted turns waiting for the restart (they run after it). */
  waiting: number;
}

export interface RestartRollDeps {
  /** Turns running now, not counting those waiting on a person. */
  running(): RunningTurnRef[];
  /** Accepted turns not yet running. */
  waiting(): number;
  /** Work a turn left behind that the restart also waits for (a plan draft being written). */
  finishing?(): number;
  /** Background processes agents started, which a restart stops (shown, not waited for). */
  background?(): Array<{ threadId: string; label: string }>;
  /** Hold every waiting turn in the journal so the next boot runs it. */
  prepare(): void;
  log?: (message: string) => void;
  now?: () => number;
  defaultTimeoutMs?: number;
  pollMs?: number;
}

export const DEFAULT_SPIN_DOWN_TIMEOUT_MS = 60 * 60_000;

/**
 * Whether a running turn is blocked on a person: its own agent asked an approval or a question
 * (the tool gate and native questions ask as `artificer`). Other prompts on its thread (a held send,
 * a raised hand, a tuning prompt) don't block the turn, so it still counts as running.
 */
export function blockedOnPerson(
  queue: Pick<ActionQueue, 'forThread'> | undefined,
  turn: RunningTurnRef,
): boolean {
  return !!queue
    ?.forThread(turn.threadId)
    .some((prompt) => prompt.status === 'pending' && prompt.agentId === 'artificer');
}

export class RestartRoll {
  private phase: RollPhase = 'idle';
  private offer?: UpdateOffer;
  private since?: number;
  private deadline?: number;
  private timer?: ReturnType<typeof setInterval>;
  private opened: Array<() => void> = [];

  constructor(private readonly deps: RestartRollDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  status(): RollStatus {
    return {
      phase: this.phase,
      ...(this.offer ? { candidate: this.offer.candidate } : {}),
      ...(this.phase === 'spinning-down' ? { since: this.since, deadline: this.deadline } : {}),
      running: this.phase === 'spinning-down' ? this.deps.running() : [],
      finishing: this.phase === 'spinning-down' ? (this.deps.finishing?.() ?? 0) : 0,
      background: this.phase === 'idle' ? [] : (this.deps.background?.() ?? []),
      waiting: this.phase === 'idle' ? 0 : this.deps.waiting(),
    };
  }

  /** Whether a turn that would start now must wait for the restart. */
  holding(): boolean {
    return this.phase === 'spinning-down' || this.phase === 'restarting';
  }

  /** Resolves once turns may start again (the update was postponed); never, if the daemon restarts. */
  whenOpen(): Promise<void> {
    if (!this.holding()) return Promise.resolve();
    return new Promise((resolve) => this.opened.push(resolve));
  }

  /** The supervisor staged an update: spin down, unless this one was postponed. */
  offerUpdate(offer: UpdateOffer): void {
    if (this.phase === 'restarting') return;
    const same = this.offer?.candidate === offer.candidate;
    this.offer = offer;
    // A postponed update stays postponed; a newer one while spinning down keeps the same deadline,
    // so merges landing faster than the backstop never put it off for good.
    if (same && this.phase !== 'idle') return;
    if (this.phase === 'spinning-down') {
      return;
    }
    this.spinDown();
  }

  /** Owner: restart now. Running turns are cut and settled from their native records on boot. */
  restartNow(): boolean {
    if (!this.offer || this.phase === 'restarting') return false;
    this.restart('the owner restarted now');
    return true;
  }

  /** Owner: not now. Waiting turns start; the update stays staged until a newer one or "Update now". */
  postpone(): boolean {
    if (this.phase !== 'spinning-down') return false;
    this.phase = 'postponed';
    this.stopTimer();
    this.open();
    this.deps.log?.(`update ${this.offer?.candidate.slice(0, 8)} postponed`);
    return true;
  }

  /** Owner: apply a postponed update now (spin down again). */
  updateNow(): boolean {
    if (this.phase !== 'postponed' || !this.offer) return false;
    this.spinDown();
    return true;
  }

  /** A turn settled: the last one to finish triggers the restart. */
  check(): void {
    if (this.phase !== 'spinning-down') return;
    const running = this.deps.running().length + (this.deps.finishing?.() ?? 0);
    if (running === 0) this.restart('every running turn finished');
    else if (this.deadline !== undefined && this.now() >= this.deadline)
      this.restart(`${running} turn(s) still running at the spin-down timeout`);
  }

  private spinDown() {
    this.phase = 'spinning-down';
    this.since = this.now();
    this.deadline =
      this.since +
      (this.offer?.timeoutMs ?? this.deps.defaultTimeoutMs ?? DEFAULT_SPIN_DOWN_TIMEOUT_MS);
    this.deps.log?.(
      `spinning down for update ${this.offer?.candidate.slice(0, 8)}: waiting for ${this.deps.running().length} running turn(s)`,
    );
    this.stopTimer();
    this.timer = setInterval(() => this.check(), this.deps.pollMs ?? 5_000);
    this.timer.unref?.();
    this.check();
  }

  private restart(reason: string) {
    if (!this.offer) return;
    this.phase = 'restarting';
    this.stopTimer();
    try {
      this.deps.prepare();
    } catch (error) {
      this.deps.log?.(`holding waiting turns failed: ${String(error)}`);
    }
    this.deps.log?.(`restarting onto ${this.offer.candidate.slice(0, 8)}: ${reason}`);
    this.offer.restart();
  }

  private open() {
    for (const resolve of this.opened.splice(0)) resolve();
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
