// ---------------------------------------------------------------------------
// Analytics Store — persistent usage tracking with time-series rollups
// ---------------------------------------------------------------------------
//
// Every LLM call gets recorded. Data is persisted to disk and aggregated
// across multiple dimensions: provider, model, agent, layer role, thread,
// and time bucket (hourly, daily, weekly, monthly).
//
// The viewer server exposes this via /api/analytics/* endpoints.
// The UI renders it as the "Analytics" tab — a first-class primitive.
// ---------------------------------------------------------------------------

import { mkdirSync, existsSync } from "fs";
import { appendFile, readFile } from "node:fs/promises";
import type {
  TokenCounts,
  TokenTracker,
  UsageEntry,
  UsageSummary,
  UsageBreakdown,
} from "@inixiative/foundry-core";
import { BudgetExceededError, newId, sumTokenCounts, totalTokenCount } from "@inixiative/foundry-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnalyticsSnapshot {
  /** Current session totals */
  readonly session: UsageSummary;
  /** Time-series data for charts */
  readonly timeSeries: TimeSeriesPoint[];
  /** Per-thread cost breakdown */
  readonly threads: ThreadCostSummary[];
  /** Per-span call log (most recent) */
  readonly recentCalls: CallRecord[];
  /** Top models by spend */
  readonly topModels: RankedItem[];
  /** Top agents by spend */
  readonly topAgents: RankedItem[];
  /** Hourly/daily/weekly/monthly aggregates */
  readonly rollups: RollupSet;
  /** Historical known subtotals; missing observations are never zero usage. */
  readonly observations: { calls: number; knownInput: number; knownOutput: number; knownTokens: number; knownCacheRead?: number; knownCacheWrite?: number; knownCost: number; unavailableUsageCalls: number; unavailableCostCalls: number; persistence: "pending" | "settled" | "failed" };
}

export interface TimeSeriesPoint extends TokenCounts {
  readonly bucket: string; // ISO timestamp of bucket start
  readonly input: number;
  readonly output: number;
  readonly cost: number;
  readonly calls: number;
}

export interface ThreadCostSummary extends TokenCounts {
  readonly threadId: string;
  readonly description?: string;
  readonly input: number;
  readonly output: number;
  readonly totalTokens: number;
  readonly cost: number;
  readonly calls: number;
  readonly avgCostPerCall: number;
  readonly lastActive: number;
}

/** Cache counters and provider tags stay absent when unreported. */
export interface CallRecord extends Omit<TokenCounts, "input" | "output"> {
  readonly timestamp: number;
  readonly provider: string;
  readonly model: string;
  readonly agentId?: string;
  readonly threadId?: string;
  readonly spanId?: string;
  readonly input: number | null;
  readonly output: number | null;
  readonly cost: number | null;
  readonly durationMs?: number;
  readonly cached?: boolean;
}

export interface RankedItem {
  readonly key: string;
  readonly cost: number;
  readonly tokens: number;
  readonly calls: number;
  readonly percentage: number; // of total spend
}

export interface RollupSet {
  readonly hourly: TimeSeriesPoint[];
  readonly daily: TimeSeriesPoint[];
  readonly weekly: TimeSeriesPoint[];
  readonly monthly: TimeSeriesPoint[];
}

export type RollupPeriod = "hourly" | "daily" | "weekly" | "monthly";

// ---------------------------------------------------------------------------
// Persisted entry — extends UsageEntry with extra analytics fields
// ---------------------------------------------------------------------------

export interface PersistedCall extends CallRecord {
  readonly id: string;
}

// ---------------------------------------------------------------------------
// AnalyticsStore
// ---------------------------------------------------------------------------

export class AnalyticsStore {
  private readonly _dir: string;
  private readonly _calls: PersistedCall[] = [];
  private _loaded = false;
  private _loading?: Promise<void>;
  private _writes: Promise<void> = Promise.resolve();
  private _writeFailure: unknown;
  private _pending = 0;
  private _detach?: () => void;

  constructor(dir: string) {
    this._dir = dir;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // -----------------------------------------------------------------------
  // Recording
  // -----------------------------------------------------------------------

  /** Record a call from a UsageEntry (emitted by TokenTracker). */
  recordCall(entry: UsageEntry, extra?: { durationMs?: number }): PersistedCall {
    const call: PersistedCall = {
      id: newId("call"),
      timestamp: entry.timestamp,
      provider: entry.provider,
      model: entry.model,
      agentId: entry.agentId,
      threadId: entry.threadId,
      spanId: entry.spanId,
      ...entry.tokens,
      cost: entry.costKnown === false ? null : entry.cost,
      durationMs: extra?.durationMs,
      cached: entry.cached,
    };
    return this._record(call);
  }

  recordUnavailable(entry: Pick<CallRecord, "provider" | "model" | "agentId" | "threadId" | "spanId">): PersistedCall {
    return this._record({ ...entry, id: newId("call"), timestamp: Date.now(), input: null, output: null, cost: null });
  }

  private _record(call: PersistedCall): PersistedCall {
    this._calls.push(call); this._pending++;
    this._writes = this._writes.then(async () => {
      if (this._writeFailure) return;
      await appendFile(`${this._dir}/calls.jsonl`, JSON.stringify(call) + "\n", { mode: 0o600 });
    }).catch(error => { this._writeFailure = error; })
      .finally(() => { this._pending--; });
    return call;
  }

  /** Acknowledges every original append, or exposes its original failure. */
  async flush(): Promise<void> { await this._writes; if (this._writeFailure) throw this._writeFailure; }
  disconnectTracker(): void { this._detach?.(); this._detach = undefined; }

  /** Wire up a TokenTracker so all records auto-persist here. */
  connectTracker(tracker: TokenTracker): void {
    // We monkey-patch by wrapping record. The tracker doesn't have an event
    // system yet, so we intercept at the API level.
    this.disconnectTracker();
    const originalRecord = tracker.record;
    const record: TokenTracker["record"] = (entry) => {
      try {
        const result = originalRecord.call(tracker, entry);
        this.recordCall(result);
        return result;
      } catch (error) {
        // record() stores the spent usage before enforcing the budget.
        if (error instanceof BudgetExceededError) {
          const recorded = tracker.recent(1)[0];
          if (recorded) this.recordCall(recorded);
        }
        throw error;
      }
    };
    tracker.record = record;
    this._detach = () => { if (tracker.record === record) tracker.record = originalRecord; };
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /** Full analytics snapshot for the UI. */
  snapshot(tracker: TokenTracker): AnalyticsSnapshot {
    const session = tracker.summary();
    const calls = this._calls;
    const known = sumTokenCounts(calls.map(knownCounts));

    return {
      session,
      observations: {
        calls: calls.length,
        knownInput: calls.reduce((n, c) => n + (c.input ?? 0), 0),
        knownOutput: calls.reduce((n, c) => n + (c.output ?? 0), 0),
        knownTokens: totalTokenCount(known),
        knownCacheRead: known.cacheRead,
        knownCacheWrite: known.cacheWrite,
        knownCost: calls.reduce((n, c) => n + (c.cost ?? 0), 0),
        unavailableUsageCalls: calls.filter(c => c.input === null || c.output === null).length,
        unavailableCostCalls: calls.filter(c => c.cost === null).length,
        persistence: this._writeFailure ? "failed" : this._pending ? "pending" : "settled",
      },
      timeSeries: this._buildTimeSeries(calls, "hourly"),
      threads: this._buildThreadSummaries(calls),
      recentCalls: calls.slice(-100).reverse(),
      topModels: this._buildRanked(calls, "model"),
      topAgents: this._buildRanked(calls, "agentId"),
      rollups: {
        hourly: this._buildTimeSeries(calls, "hourly"),
        daily: this._buildTimeSeries(calls, "daily"),
        weekly: this._buildTimeSeries(calls, "weekly"),
        monthly: this._buildTimeSeries(calls, "monthly"),
      },
    };
  }

  /** Get calls filtered by dimension. */
  callsBy(field: "provider" | "model" | "agentId" | "threadId", value: string): CallRecord[] {
    return this._calls.filter((c) => c[field] === value);
  }

  /** Get time-series for a specific period. */
  timeSeries(period: RollupPeriod, since?: number): TimeSeriesPoint[] {
    const calls = since ? this._calls.filter((c) => c.timestamp >= since) : this._calls;
    return this._buildTimeSeries(calls, period);
  }

  /** Thread-level cost breakdown. */
  threadCosts(): ThreadCostSummary[] {
    return this._buildThreadSummaries(this._calls);
  }

  /** Total calls recorded. */
  get totalCalls(): number {
    return this._calls.length;
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /** Load historical calls from disk. */
  async load(): Promise<void> {
    if (this._loaded) return;
    if (!this._loading) this._loading = (async () => {
      let content: string;
      try { content = await readFile(`${this._dir}/calls.jsonl`, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { this._loaded = true; return; } throw error; }
      const loaded = content.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as PersistedCall);
      const existing = new Set(this._calls.map(c => c.id));
      this._calls.unshift(...loaded.filter(c => !existing.has(c.id)));
      this._loaded = true;
    })();
    return this._loading;
  }

  // -----------------------------------------------------------------------
  // Aggregation helpers
  // -----------------------------------------------------------------------

  private _buildTimeSeries(calls: CallRecord[], period: RollupPeriod): TimeSeriesPoint[] {
    const buckets = new Map<string, TokenCounts & { cost: number; calls: number }>();

    for (const call of calls) {
      const key = this._bucketKey(call.timestamp, period);
      const existing = buckets.get(key);
      if (existing) {
        Object.assign(existing, sumTokenCounts([existing, knownCounts(call)]));
        existing.cost += call.cost ?? 0;
        existing.calls += 1;
      } else {
        buckets.set(key, {
          ...sumTokenCounts([knownCounts(call)]),
          cost: call.cost ?? 0,
          calls: 1,
        });
      }
    }

    return [...buckets.entries()]
      .map(([bucket, v]) => ({ bucket, ...v }))
      .sort((a, b) => a.bucket.localeCompare(b.bucket));
  }

  private _bucketKey(timestamp: number, period: RollupPeriod): string {
    const d = new Date(timestamp);
    switch (period) {
      case "hourly":
        return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:00`;
      case "daily":
        return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
      case "weekly": {
        // ISO week: floor to Monday
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        const monday = new Date(d);
        monday.setDate(diff);
        return `${monday.getFullYear()}-W${p2(Math.ceil(diff / 7))}`;
      }
      case "monthly":
        return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
    }
  }

  private _buildThreadSummaries(calls: CallRecord[]): ThreadCostSummary[] {
    const map = new Map<string, TokenCounts & {
      cost: number;
      calls: number; lastActive: number;
    }>();

    for (const call of calls) {
      const tid = call.threadId ?? "(no thread)";
      const existing = map.get(tid);
      if (existing) {
        Object.assign(existing, sumTokenCounts([existing, knownCounts(call)]));
        existing.cost += call.cost ?? 0;
        existing.calls += 1;
        existing.lastActive = Math.max(existing.lastActive, call.timestamp);
      } else {
        map.set(tid, {
          ...sumTokenCounts([knownCounts(call)]),
          cost: call.cost ?? 0,
          calls: 1,
          lastActive: call.timestamp,
        });
      }
    }

    return [...map.entries()]
      .map(([threadId, v]) => ({
        threadId,
        ...sumTokenCounts([v]),
        totalTokens: totalTokenCount(v),
        cost: v.cost,
        calls: v.calls,
        avgCostPerCall: v.calls > 0 ? v.cost / v.calls : 0,
        lastActive: v.lastActive,
      }))
      .sort((a, b) => b.cost - a.cost);
  }

  private _buildRanked(calls: CallRecord[], field: "model" | "agentId"): RankedItem[] {
    const map = new Map<string, { cost: number; tokens: number; calls: number }>();
    let totalCost = 0;

    for (const call of calls) {
      const key = call[field];
      if (!key) continue;
      totalCost += call.cost ?? 0;
      const existing = map.get(key);
      if (existing) {
        existing.cost += call.cost ?? 0;
        existing.tokens += totalTokenCount(knownCounts(call));
        existing.calls += 1;
      } else {
        map.set(key, {
          cost: call.cost ?? 0,
          tokens: totalTokenCount(knownCounts(call)),
          calls: 1,
        });
      }
    }

    return [...map.entries()]
      .map(([key, v]) => ({
        key,
        cost: v.cost,
        tokens: v.tokens,
        calls: v.calls,
        percentage: totalCost > 0 ? v.cost / totalCost : 0,
      }))
      .sort((a, b) => b.cost - a.cost);
  }
}

/** Unavailable input/output contributes nothing to known subtotals. */
function knownCounts(call: CallRecord): TokenCounts {
  return { ...call, input: call.input ?? 0, output: call.output ?? 0 };
}

function p2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
