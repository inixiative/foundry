/**
 * Workstream-overload detector — a Herald PatternDetector that fires when
 * a single thread has accreted multiple distinct workstreams.
 *
 * The failure mode (observed in real Claude Code sessions): a thread starts
 * as one ask ("agentic review of yesterday's work") but absorbs additional
 * asks mid-flow (a Dashboard UI rewrite, four review fixes, factory + test
 * scaffolding, db-migration debugging). The thread loses focus, gets stuck
 * in one of the workstreams, and never returns to the original ask.
 *
 * Herald is the right home for this — it already understands threads as
 * coordinable units, it has the action vocabulary (pause/redirect/inform)
 * and we extend it with `"split"`. Wardens advise on domain context per
 * message; deciding "this thread should be N threads" is Herald's beat.
 *
 * Detection: heuristic baseline. Counts distinct surfaces touched by recent
 * dispatches and signals. Cheap, deterministic, no LLM. We expose
 * `WORKSTREAM_DETECTOR_PROMPT` for a future LLM-classifier upgrade once
 * the heuristic's false-positive rate is calibrated against real sessions.
 *
 * Action: when `autoSplit` is enabled on the Herald, the recommendation's
 * action is `"split"` (Herald implementation forks sub-threads). When
 * disabled — the default — the action is `"inform"`: Herald surfaces the
 * pattern to the operator without taking action. We want false-positive
 * data before we let it fork threads autonomously.
 */

import type {
  HeraldPattern,
  PatternDetector,
  ThreadSnapshot,
} from "./herald";

// ---------------------------------------------------------------------------
// Tunables — exposed so tests can construct a deterministic detector
// ---------------------------------------------------------------------------

/** Default minimum number of distinct dispatched agents to fire. */
export const DEFAULT_DISTINCT_AGENT_THRESHOLD = 4;

/** Default minimum number of distinct context hashes seen in recent dispatches. */
export const DEFAULT_CONTEXT_HASH_DIVERGENCE = 3;

/** Default minimum number of distinct signal sources to count toward overload. */
export const DEFAULT_DISTINCT_SIGNAL_SOURCES = 4;

/** Default lookback window — only dispatches/signals within this window count. */
export const DEFAULT_WINDOW_MS = 5 * 60_000; // 5 minutes

export interface WorkstreamOverloadOptions {
  /** Minimum distinct dispatched agents to fire. */
  distinctAgentThreshold?: number;
  /** Minimum distinct context hashes in recent dispatches. */
  contextHashDivergence?: number;
  /** Minimum distinct signal sources. */
  distinctSignalSources?: number;
  /** Lookback window in ms. */
  windowMs?: number;
}

export interface WorkstreamOverloadEvidence {
  distinctAgents: string[];
  distinctContextHashes: string[];
  distinctSignalSources: string[];
  windowMs: number;
  /** Which heuristic(s) tripped — useful for tuning thresholds against real data. */
  triggers: Array<"agents" | "context" | "signals">;
}

// ---------------------------------------------------------------------------
// LLM prompt (reserved for the eventual classifier upgrade — not used yet)
// ---------------------------------------------------------------------------

/**
 * Prompt for an LLM-based workstream classifier. Not currently invoked —
 * the detector below is heuristic. Keep this in sync with the heuristic's
 * notion of "workstream" so a future async detector can swap in cleanly.
 */
export const WORKSTREAM_DETECTOR_PROMPT = [
  "You are the workstream detector. Read the user's most recent message and the recent thread activity, and identify how many DISTINCT workstreams the thread is currently juggling.",
  "",
  "A workstream is a unit of work with its own goal, surface area, and acceptance criteria. Two asks are the SAME workstream if completing one inherently requires completing the other (e.g. \"fix the bug and add a test for it\" — the test is part of the fix). They are DIFFERENT workstreams if they touch unrelated surfaces, verbs, or modules and could meaningfully be handed to different operators (e.g. \"run a code review\" + \"redesign the dashboard tiles\" + \"fix a Prisma migration error\").",
  "",
  "Procedure:",
  "1. List every concrete ask in the user message (and any unresolved follow-ups from recent thread activity).",
  "2. Group asks that share a goal/surface into one workstream; split asks that don't.",
  "3. If only one workstream emerges, set multipleDetected=false and give the workstream a label.",
  "4. If two or more emerge, set multipleDetected=true, pick the one the user opened with as primary, and recommend whether to focus / sequence / split.",
  "",
  "Rules:",
  "- Be precision-biased. Prefer flagging fewer workstreams when uncertain. A false split is more disruptive than a missed split.",
  "- Workstream IDs should be short kebab-case slugs (e.g. \"agentic-review\", \"dashboard-tiles\").",
  "- recommendation is one sentence aimed at the operator (e.g. \"Tackle the dashboard change first since it unblocks visual review of the new tiles, then resume the review.\").",
  "- Respond with JSON only, no prose, no code fences:",
  '  {"workstreams":[{"id":"...","label":"...","intent":"..."}],"primary":"...","multipleDetected":false,"recommendation":"...","confidence":0.0}',
].join("\n");

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

/**
 * Per-thread overload detector. Iterates each snapshot independently — this
 * is intra-thread topology, not cross-thread coordination, but Herald owns
 * thread coordination so it owns the "split this thread" recommendation.
 */
export class WorkstreamOverloadDetector implements PatternDetector {
  readonly id = "builtin:workstream_overload";
  readonly kind = "workstream_overload" as const;

  private _opts: Required<WorkstreamOverloadOptions>;

  constructor(opts: WorkstreamOverloadOptions = {}) {
    this._opts = {
      distinctAgentThreshold:
        opts.distinctAgentThreshold ?? DEFAULT_DISTINCT_AGENT_THRESHOLD,
      contextHashDivergence:
        opts.contextHashDivergence ?? DEFAULT_CONTEXT_HASH_DIVERGENCE,
      distinctSignalSources:
        opts.distinctSignalSources ?? DEFAULT_DISTINCT_SIGNAL_SOURCES,
      windowMs: opts.windowMs ?? DEFAULT_WINDOW_MS,
    };
  }

  detect(
    snapshots: ReadonlyArray<ThreadSnapshot>,
    _history: ReadonlyArray<HeraldPattern>,
  ): HeraldPattern[] {
    const patterns: HeraldPattern[] = [];
    const now = Date.now();
    const cutoff = now - this._opts.windowMs;

    for (const snap of snapshots) {
      const recentDispatches = snap.recentDispatches.filter(
        (d) => d.timestamp >= cutoff,
      );
      const recentSignals = snap.recentSignals.filter(
        (s) => s.timestamp >= cutoff,
      );

      const distinctAgents = unique(recentDispatches.map((d) => d.agentId));
      const distinctContextHashes = unique(
        recentDispatches.map((d) => d.contextHash).filter(Boolean),
      );
      const distinctSignalSources = unique(
        recentSignals
          .filter((s) => s.kind !== "herald") // ignore our own injections
          .map((s) => s.source),
      );

      const triggers: WorkstreamOverloadEvidence["triggers"] = [];
      if (distinctAgents.length >= this._opts.distinctAgentThreshold)
        triggers.push("agents");
      if (distinctContextHashes.length >= this._opts.contextHashDivergence)
        triggers.push("context");
      if (distinctSignalSources.length >= this._opts.distinctSignalSources)
        triggers.push("signals");

      // Need at least two corroborating triggers to fire — single-axis
      // signals are too noisy. Two-trigger floor is the precision-bias
      // knob; tune as we collect real-session data.
      if (triggers.length < 2) continue;

      const evidence: WorkstreamOverloadEvidence = {
        distinctAgents,
        distinctContextHashes,
        distinctSignalSources,
        windowMs: this._opts.windowMs,
        triggers,
      };

      patterns.push({
        id: `herald_workstream_${snap.threadId}_${now}`,
        kind: "workstream_overload",
        severity: "warning",
        threads: [snap.threadId],
        description: `Thread "${snap.threadId}" is juggling multiple workstreams (${distinctAgents.length} distinct agents, ${distinctContextHashes.length} distinct contexts, ${distinctSignalSources.length} distinct signal sources in last ${Math.round(this._opts.windowMs / 60_000)}m).`,
        recommendation:
          "Consider splitting this thread — focus on one workstream and fork the rest into sub-threads.",
        evidence,
        timestamp: now,
      });
    }

    return patterns;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
