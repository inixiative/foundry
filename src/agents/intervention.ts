import type { Signal, SignalBus } from "./signal";
import type { Trace, Span } from "./trace";

/**
 * An intervention — a manual override from a human operator.
 *
 * When the system forks erroneously, routes to the wrong place,
 * or makes a bad classification, the operator can intervene.
 * The intervention:
 *   1. Records what happened (the trace/span that was wrong)
 *   2. Records what should have happened (the correction)
 *   3. Optionally replays with the correction
 *   4. Emits a "correction" signal so the system learns
 *
 * Over time, corrections accumulate and shape the context layers —
 * the system makes fewer mistakes on the same patterns.
 */
export interface Intervention {
  readonly id: string;
  readonly timestamp: number;

  /** What trace this intervention targets. */
  readonly traceId: string;

  /** Which span was wrong (the specific stage — route, classify, dispatch). */
  readonly spanId: string;

  /** What the system did. */
  readonly actual: unknown;

  /** What the operator says it should have done. */
  readonly correction: unknown;

  /** Free-form reason — becomes part of the correction signal's content. */
  readonly reason?: string;

  /** Who intervened. */
  readonly operator: string;
}

/**
 * Manages manual interventions.
 *
 * When an operator overrides a decision, the InterventionLog:
 * - Records the intervention
 * - Emits a correction signal on the signal bus
 * - Provides the intervention history for the UI
 *
 * The correction signal flows through the normal signal pipeline —
 * the Librarian classifies it, it gets routed to the right memory layer,
 * and future decisions are shaped by it.
 */
export class InterventionLog {
  private _interventions: Intervention[] = [];
  private _signals: SignalBus;
  private _maxHistory: number;

  constructor(signals: SignalBus, maxHistory: number = 1000) {
    this._signals = signals;
    this._maxHistory = maxHistory;
  }

  /**
   * Record an intervention and emit a correction signal.
   */
  async intervene(
    traceId: string,
    spanId: string,
    actual: unknown,
    correction: unknown,
    operator: string,
    reason?: string
  ): Promise<Intervention> {
    const intervention: Intervention = {
      id: `int_${Date.now().toString(36)}_${this._interventions.length}`,
      timestamp: Date.now(),
      traceId,
      spanId,
      actual,
      correction,
      reason,
      operator,
    };

    this._interventions.push(intervention);
    if (this._interventions.length > this._maxHistory) {
      this._interventions.shift();
    }

    // Emit as a correction signal so the system learns
    await this._signals.emit({
      id: `sig_${intervention.id}`,
      kind: "correction",
      source: `operator:${operator}`,
      content: {
        traceId,
        spanId,
        actual,
        correction,
        reason,
      },
      confidence: 1.0, // human corrections are high confidence
      timestamp: Date.now(),
    });

    return intervention;
  }

  /** Get all interventions, most recent first. */
  get history(): ReadonlyArray<Intervention> {
    return [...this._interventions].reverse();
  }

  /** Get interventions for a specific trace. */
  forTrace(traceId: string): Intervention[] {
    return this._interventions.filter((i) => i.traceId === traceId);
  }

  /** Get recent corrections as signal content (for feeding into context layers). */
  recentCorrections(limit: number = 20): Array<{
    actual: unknown;
    correction: unknown;
    reason?: string;
    timestamp: number;
  }> {
    return this._interventions.slice(-limit).map((i) => ({
      actual: i.actual,
      correction: i.correction,
      reason: i.reason,
      timestamp: i.timestamp,
    }));
  }
}
