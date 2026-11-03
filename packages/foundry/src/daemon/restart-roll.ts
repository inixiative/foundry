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
  /** Accepted turns waiting for the restart (they run after it). */
  waiting: number;
}

export interface RestartRollDeps {
  /** Turns running now, not counting those waiting on a person. */
  running(): RunningTurnRef[];
  /** Accepted turns not yet running. */
  waiting(): number;
  /** Hold every waiting turn in the journal so the next boot runs it. */
  prepare(): void;
  log?: (message: string) => void;
  now?: () => number;
  defaultTimeoutMs?: number;
  pollMs?: number;
}

export const DEFAULT_SPIN_DOWN_TIMEOUT_MS = 60 * 60_000;

export class RestartRoll {
  private phase: RollPhase = 'idle';
  private offer?: UpdateOffer;
  private since?: number;
  private deadline?: number;
  private timer?: ReturnType<typeof setInterval>;
  private opened: Array<() => void> = [];
  private readonly listeners = new Set<(status: RollStatus) => void>();

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
      waiting: this.phase === 'idle' ? 0 : this.deps.waiting(),
    };
  }

  onChange(listener: (status: RollStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
    if (same && this.phase !== 'idle') return;
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
    this.changed();
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
    const running = this.deps.running().length;
    if (running === 0) this.restart('every running turn finished');
    else if (this.deadline !== undefined && this.now() >= this.deadline)
      this.restart(`${running} turn(s) still running at the spin-down timeout`);
    else this.changed();
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
    this.changed();
    this.check();
  }

  private restart(reason: string) {
    if (!this.offer) return;
    this.phase = 'restarting';
    this.stopTimer();
    this.changed();
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

  private changed() {
    const status = this.status();
    for (const listener of this.listeners)
      try {
        listener(status);
      } catch {
        /* a listener's failure never stops the roll */
      }
  }
}
