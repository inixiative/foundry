/**
 * @atlas
 * @kind service
 * @partOf feature:daemon
 */
/**
 * The spin-down: how the daemon restarts onto an update without cutting work, and without one long
 * turn holding every thread for an hour (Aron, 2026-11-14: "more aggressively seek to pause running
 * agents for a restart of foundry to not do long blocking. pause + resume").
 *
 * When the supervisor offers a staged update, the daemon spins down: new messages are still
 * accepted but wait in the queue ("waiting for Foundry to restart"); nothing new starts. Turns
 * already running get a short grace (`pauseAfterMs`, default a minute) to finish on their own; a
 * turn waiting on its person (its agent's approval or question) is paused at once. Past the grace,
 * each turn still running is paused: stopped through its runtime with its native session kept, and
 * Foundry queues a continuation on its thread (`TurnService.pauseForRestart`). When the last turn
 * has stopped, every waiting turn is held in the journal (`restart-hold`) and the daemon restarts;
 * the next boot runs the continuations first, then the rest in the order they arrived, each thread
 * resuming its native session through its binding. A turn whose stop isn't acknowledged gets
 * `PAUSE_SETTLE_MS` before the restart goes ahead; the timeout (default 60 minutes) stays the last
 * backstop, and a cut turn is settled from its native record (`turns/native-outcome-recovery.ts`).
 * The owner can pause now, restart now (cutting what runs) or postpone the update.
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
  /** How long running turns may finish on their own before they are paused. */
  pauseAfterMs?: number;
}

export type RollPhase = 'idle' | 'spinning-down' | 'postponed' | 'restarting';

export interface RollStatus {
  phase: RollPhase;
  candidate?: string;
  /** When the spin-down began. */
  since?: number;
  /** When the backstop restarts it anyway. */
  deadline?: number;
  /** When turns still running are paused (past it, they are being paused). */
  pauseAt?: number;
  /** Turns the restart waits for. */
  running: RunningTurnRef[];
  /** Of those, the ones asked to pause: they stop, and resume after the restart. */
  pausing: RunningTurnRef[];
  /** Other work the restart waits for (plan drafts being written after a turn). */
  finishing: number;
  /** Background processes agents started; a restart stops them. */
  background: Array<{ threadId: string; label: string }>;
  /** Accepted turns waiting for the restart (they run after it). */
  waiting: number;
}

export type PauseAnswer = 'paused' | 'not-yet' | 'cannot';

export interface RestartRollDeps {
  /** Turns running now. */
  running(): RunningTurnRef[];
  /** A running turn blocked on its person (an approval or question): paused without the grace. */
  waitingOnPerson?(turn: RunningTurnRef): boolean;
  /**
   * Pause a running turn: stop it, its native session kept, and queue its continuation for after
   * the restart. `paused`: asked to stop, its continuation queued (or it was already ending).
   * `not-yet`: it hasn't reached its runtime; asked again on a later poll. `cannot`: its runtime
   * can't stop a turn; the restart waits for it to finish. Without it, the spin-down only waits.
   */
  pause?(turn: RunningTurnRef): Promise<PauseAnswer>;
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
  defaultPauseAfterMs?: number;
  pollMs?: number;
}

export const DEFAULT_SPIN_DOWN_TIMEOUT_MS = 60 * 60_000;
export const DEFAULT_PAUSE_AFTER_MS = 60_000;
/** Once every running turn was asked to pause, how long one that hasn't stopped may hold the restart. */
export const PAUSE_SETTLE_MS = 2 * 60_000;

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
  private pauseAt?: number;
  /** Turns asked to pause (by turn id); `inFlight` of them are still between stop and continuation. */
  private paused = new Map<string, RunningTurnRef>();
  private inFlight = 0;
  /** Turns whose runtime can't stop them: the restart waits for them to finish. */
  private runsOn = new Set<string>();
  /** Turns not yet at their runtime, and when they may be asked again. */
  private notYet = new Map<string, number>();
  /** The owner restarted now while a pause was between its stop and its continuation. */
  private restartWanted = false;
  /** When the last running turn was asked to pause. */
  private allPausedAt?: number;
  private timer?: ReturnType<typeof setInterval>;
  private opened: Array<() => void> = [];

  constructor(private readonly deps: RestartRollDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  status(): RollStatus {
    const spinning = this.phase === 'spinning-down';
    const running = spinning ? this.deps.running() : [];
    return {
      phase: this.phase,
      ...(this.offer ? { candidate: this.offer.candidate } : {}),
      ...(spinning
        ? {
            since: this.since,
            deadline: this.deadline,
            ...(this.deps.pause ? { pauseAt: this.pauseAt } : {}),
          }
        : {}),
      running,
      pausing: running.filter((turn) => this.paused.has(turn.turnId)),
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

  /** Owner: pause now. Running turns are paused without waiting out the grace; the restart follows. */
  pauseNow(): boolean {
    if (this.phase !== 'spinning-down' || !this.deps.pause) return false;
    this.pauseAt = this.now();
    this.check();
    return true;
  }

  /**
   * Owner: restart now. Running turns are cut and settled from their native records on boot; a
   * pause between its stop and its continuation finishes first (bounded by the runtime's stop).
   */
  restartNow(): boolean {
    if (!this.offer || this.phase === 'restarting') return false;
    if (this.inFlight > 0) this.restartWanted = true;
    else this.restart('the owner restarted now');
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

  /** A turn settled, a pause finished, or the poll ticked: pause what is due, restart once none runs. */
  check(): void {
    if (this.phase !== 'spinning-down') return;
    const running = this.deps.running();
    if (this.deps.pause) {
      const now = this.now();
      const due = this.pauseAt !== undefined && now >= this.pauseAt;
      for (const turn of running)
        if (
          !this.paused.has(turn.turnId) &&
          !this.runsOn.has(turn.turnId) &&
          now >= (this.notYet.get(turn.turnId) ?? 0) &&
          (due || this.deps.waitingOnPerson?.(turn))
        )
          this.pauseTurn(turn);
      if (running.length && running.every((turn) => this.paused.has(turn.turnId)))
        this.allPausedAt ??= this.now();
      else this.allPausedAt = undefined;
    }
    const busy = running.length + (this.deps.finishing?.() ?? 0) + this.inFlight;
    if (busy === 0) this.restart('every running turn finished or paused');
    else if (this.allPausedAt !== undefined && this.now() >= this.allPausedAt + PAUSE_SETTLE_MS)
      this.restart(
        `${running.length} paused turn(s) had not stopped ${PAUSE_SETTLE_MS / 1000}s on`,
      );
    else if (this.deadline !== undefined && this.now() >= this.deadline)
      this.restart(`${running.length} turn(s) still running at the spin-down timeout`);
  }

  private pauseTurn(turn: RunningTurnRef) {
    this.paused.set(turn.turnId, turn);
    this.inFlight++;
    this.deps.log?.(`pausing ${turn.turnId} on ${turn.threadId} for the restart`);
    void this.deps.pause!(turn)
      .catch((error): PauseAnswer => {
        this.deps.log?.(`pausing ${turn.turnId} failed: ${String(error)}`);
        return 'cannot';
      })
      .then((answer) => {
        if (answer === 'paused') return;
        this.paused.delete(turn.turnId);
        // Not at its runtime yet: asked again a poll later, never in the same tick.
        if (answer === 'not-yet')
          this.notYet.set(turn.turnId, this.now() + (this.deps.pollMs ?? 5_000));
        else {
          this.runsOn.add(turn.turnId);
          this.deps.log?.(`${turn.turnId} can't be paused; the restart waits for it to finish`);
        }
      })
      .finally(() => {
        this.inFlight--;
        if (this.restartWanted && this.inFlight === 0 && this.phase !== 'restarting')
          this.restart('the owner restarted now');
        else this.check();
      });
  }

  private spinDown() {
    this.phase = 'spinning-down';
    this.since = this.now();
    this.deadline =
      this.since +
      (this.offer?.timeoutMs ?? this.deps.defaultTimeoutMs ?? DEFAULT_SPIN_DOWN_TIMEOUT_MS);
    this.pauseAt =
      this.since +
      (this.offer?.pauseAfterMs ?? this.deps.defaultPauseAfterMs ?? DEFAULT_PAUSE_AFTER_MS);
    this.paused.clear();
    this.runsOn.clear();
    this.notYet.clear();
    this.restartWanted = false;
    this.allPausedAt = undefined;
    this.deps.log?.(
      `spinning down for update ${this.offer?.candidate.slice(0, 8)}: ${this.deps.running().length} running turn(s)${this.deps.pause ? ` pause in ${Math.round((this.pauseAt - this.since) / 1000)}s unless they finish` : ''}`,
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
