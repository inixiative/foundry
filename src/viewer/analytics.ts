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
import type {
  TokenTracker,
  UsageEntry,
  UsageSummary,
  UsageBreakdown,
} from "../agents/token-tracker";

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
}

export interface TimeSeriesPoint {
  readonly bucket: string; // ISO timestamp of bucket start
  readonly input: number;
  readonly output: number;
  readonly cost: number;
  readonly calls: number;
}

export interface ThreadCostSummary {
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

export interface CallRecord {
  readonly timestamp: number;
  readonly provider: string;
  readonly model: string;
  readonly agentId?: string;
  readonly threadId?: string;
  readonly spanId?: string;
  readonly input: number;
  readonly output: number;
  readonly cost: number;
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
  private _callCounter = 0;
  private _loaded = false;

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
      id: `call_${++this._callCounter}_${Date.now().toString(36)}`,
      timestamp: entry.timestamp,
      provider: entry.provider,
      model: entry.model,
      agentId: entry.agentId,
      threadId: entry.threadId,
      spanId: entry.spanId,
      input: entry.tokens.input,
      output: entry.tokens.output,
      cost: entry.cost,
      durationMs: extra?.durationMs,
      cached: entry.cached,
    };
    this._calls.push(call);
    // Async persist — fire and forget
    this._persistCall(call);
    return call;
  }

  /** Wire up a TokenTracker so all records auto-persist here. */
  connectTracker(tracker: TokenTracker): void {
    // We monkey-patch by wrapping record. The tracker doesn't have an event
    // system yet, so we intercept at the API level.
    const originalRecord = tracker.record.bind(tracker);
    tracker.record = (entry) => {
      const result = originalRecord(entry);
      this.recordCall(result);
      return result;
    };
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /** Full analytics snapshot for the UI. */
  snapshot(tracker: TokenTracker): AnalyticsSnapshot {
    const session = tracker.summary();
    const calls = this._calls;

    return {
      session,
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
    this._loaded = true;

    const indexPath = `${this._dir}/calls.jsonl`;
    if (!existsSync(indexPath)) return;

    try {
      const content = await Bun.file(indexPath).text();
      const lines = content.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const call = JSON.parse(line) as PersistedCall;
          this._calls.push(call);
          this._callCounter++;
        } catch (err) {
          import("../logger").then(({ log }) => log.warn("[Analytics] skipping malformed JSONL line:", (err as Error).message));
        }
      }
    } catch (err) {
      import("../logger").then(({ log }) => log.warn("[Analytics] failed to load persisted data, starting fresh:", (err as Error).message));
    }
  }

  private async _persistCall(call: PersistedCall): Promise<void> {
    try {
      const path = `${this._dir}/calls.jsonl`;
      const line = JSON.stringify(call) + "\n";
      await Bun.write(path, (existsSync(path) ? await Bun.file(path).text() : "") + line);
    } catch (err) {
      import("../logger").then(({ log }) => log.warn("[Analytics] persistence failure (data lives in memory):", (err as Error).message));
    }
  }

  // -----------------------------------------------------------------------
  // Aggregation helpers
  // -----------------------------------------------------------------------

  private _buildTimeSeries(calls: CallRecord[], period: RollupPeriod): TimeSeriesPoint[] {
    const buckets = new Map<string, { input: number; output: number; cost: number; calls: number }>();

    for (const call of calls) {
      const key = this._bucketKey(call.timestamp, period);
      const existing = buckets.get(key);
      if (existing) {
        existing.input += call.input;
        existing.output += call.output;
        existing.cost += call.cost;
        existing.calls += 1;
      } else {
        buckets.set(key, {
          input: call.input,
          output: call.output,
          cost: call.cost,
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
    const map = new Map<string, {
      input: number; output: number; cost: number;
      calls: number; lastActive: number;
    }>();

    for (const call of calls) {
      const tid = call.threadId ?? "(no thread)";
      const existing = map.get(tid);
      if (existing) {
        existing.input += call.input;
        existing.output += call.output;
        existing.cost += call.cost;
        existing.calls += 1;
        existing.lastActive = Math.max(existing.lastActive, call.timestamp);
      } else {
        map.set(tid, {
          input: call.input,
          output: call.output,
          cost: call.cost,
          calls: 1,
          lastActive: call.timestamp,
        });
      }
    }

    return [...map.entries()]
      .map(([threadId, v]) => ({
        threadId,
        input: v.input,
        output: v.output,
        totalTokens: v.input + v.output,
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
      totalCost += call.cost;
      const existing = map.get(key);
      if (existing) {
        existing.cost += call.cost;
        existing.tokens += call.input + call.output;
        existing.calls += 1;
      } else {
        map.set(key, {
          cost: call.cost,
          tokens: call.input + call.output,
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

function p2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
