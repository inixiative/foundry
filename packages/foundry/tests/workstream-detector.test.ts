import { describe, expect, test } from "bun:test";
import {
  WorkstreamOverloadDetector,
  WORKSTREAM_DETECTOR_PROMPT,
} from "../src/agents/workstream-detector";
import type { ThreadSnapshot } from "../src/agents/herald";

// ---------------------------------------------------------------------------
// Test helpers — fabricate snapshots directly. We don't need a full Herald or
// SessionManager here; the detector reads ThreadSnapshot[] and nothing else.
// ---------------------------------------------------------------------------

function snapshot(
  threadId: string,
  opts: {
    dispatches?: Array<{ agentId: string; contextHash?: string; offsetMs?: number }>;
    signals?: Array<{ kind: string; source: string; offsetMs?: number }>;
    nowMs?: number;
  } = {},
): ThreadSnapshot {
  const now = opts.nowMs ?? Date.now();
  return {
    threadId,
    timestamp: now,
    status: "active",
    description: "",
    tags: [],
    agents: [],
    layerIds: [],
    contextHash: "",
    recentDispatches: (opts.dispatches ?? []).map((d, i) => ({
      agentId: d.agentId,
      timestamp: now - (d.offsetMs ?? i * 1_000),
      contextHash: d.contextHash ?? `ctx-${i}`,
      durationMs: 100,
    })),
    recentSignals: (opts.signals ?? []).map((s, i) => ({
      kind: s.kind,
      source: s.source,
      content: {},
      timestamp: now - (s.offsetMs ?? i * 1_000),
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkstreamOverloadDetector", () => {
  test("does not fire on a focused single-workstream thread", () => {
    const det = new WorkstreamOverloadDetector();
    // Same agent, same context, same signal source — clearly one workstream.
    const snap = snapshot("t1", {
      dispatches: Array.from({ length: 8 }, () => ({
        agentId: "executor-fix",
        contextHash: "h1",
      })),
      signals: Array.from({ length: 6 }, () => ({
        kind: "tool_observation",
        source: "executor-fix",
      })),
    });
    const patterns = det.detect([snap], []);
    expect(patterns).toEqual([]);
  });

  test("fires on a thread juggling multiple workstreams", () => {
    const det = new WorkstreamOverloadDetector();
    const snap = snapshot("t1", {
      dispatches: [
        { agentId: "code-reviewer", contextHash: "review" },
        { agentId: "frontend-fixer", contextHash: "ui" },
        { agentId: "test-writer", contextHash: "tests" },
        { agentId: "db-migrator", contextHash: "db" },
        { agentId: "code-reviewer", contextHash: "review" }, // dup OK
      ],
      signals: [
        { kind: "tool_observation", source: "code-reviewer" },
        { kind: "tool_observation", source: "frontend-fixer" },
        { kind: "tool_observation", source: "test-writer" },
        { kind: "tool_observation", source: "db-migrator" },
        { kind: "correction", source: "convention-warden" },
      ],
    });
    const patterns = det.detect([snap], []);
    expect(patterns.length).toBe(1);
    expect(patterns[0].kind).toBe("workstream_overload");
    expect(patterns[0].threads).toEqual(["t1"]);
    expect(patterns[0].severity).toBe("warning");
  });

  test("evidence captures the trigger axes", () => {
    const det = new WorkstreamOverloadDetector();
    const snap = snapshot("t1", {
      dispatches: [
        { agentId: "a", contextHash: "h1" },
        { agentId: "b", contextHash: "h2" },
        { agentId: "c", contextHash: "h3" },
        { agentId: "d", contextHash: "h4" },
      ],
      signals: [
        { kind: "tool_observation", source: "s1" },
        { kind: "tool_observation", source: "s2" },
        { kind: "tool_observation", source: "s3" },
        { kind: "tool_observation", source: "s4" },
      ],
    });
    const [p] = det.detect([snap], []);
    const evidence = p.evidence as {
      distinctAgents: string[];
      distinctContextHashes: string[];
      distinctSignalSources: string[];
      triggers: string[];
    };
    expect(evidence.distinctAgents.length).toBe(4);
    expect(evidence.distinctContextHashes.length).toBe(4);
    expect(evidence.distinctSignalSources.length).toBe(4);
    expect(evidence.triggers).toContain("agents");
    expect(evidence.triggers).toContain("context");
    expect(evidence.triggers).toContain("signals");
  });

  test("requires two corroborating triggers — single-axis spikes don't fire", () => {
    const det = new WorkstreamOverloadDetector();
    // Many agents but all share the same context and signal source → only
    // one trigger axis tripped, should NOT fire (precision-bias floor).
    const snap = snapshot("t1", {
      dispatches: [
        { agentId: "a", contextHash: "shared" },
        { agentId: "b", contextHash: "shared" },
        { agentId: "c", contextHash: "shared" },
        { agentId: "d", contextHash: "shared" },
      ],
      signals: [
        { kind: "tool_observation", source: "shared-source" },
        { kind: "tool_observation", source: "shared-source" },
      ],
    });
    expect(det.detect([snap], [])).toEqual([]);
  });

  test("respects the lookback window — stale dispatches don't count", () => {
    const det = new WorkstreamOverloadDetector({ windowMs: 10_000 });
    const now = Date.now();
    // Dispatches outside the 10s window should be filtered out.
    const snap = snapshot("t1", {
      nowMs: now,
      dispatches: [
        { agentId: "a", contextHash: "h1", offsetMs: 100 },
        { agentId: "b", contextHash: "h2", offsetMs: 60_000 },
        { agentId: "c", contextHash: "h3", offsetMs: 60_000 },
        { agentId: "d", contextHash: "h4", offsetMs: 60_000 },
      ],
      signals: [
        { kind: "tool_observation", source: "s1", offsetMs: 100 },
        { kind: "tool_observation", source: "s2", offsetMs: 60_000 },
      ],
    });
    expect(det.detect([snap], [])).toEqual([]);
  });

  test("ignores Herald's own injected signals", () => {
    const det = new WorkstreamOverloadDetector();
    // Lots of signals but they're all herald-emitted — would otherwise
    // trip the signal-sources axis. Should still be filtered.
    const snap = snapshot("t1", {
      dispatches: [
        { agentId: "a", contextHash: "h1" },
        { agentId: "b", contextHash: "h2" },
      ],
      signals: [
        { kind: "herald", source: "herald-1" },
        { kind: "herald", source: "herald-2" },
        { kind: "herald", source: "herald-3" },
        { kind: "herald", source: "herald-4" },
      ],
    });
    expect(det.detect([snap], [])).toEqual([]);
  });

  test("custom thresholds override defaults", () => {
    const det = new WorkstreamOverloadDetector({
      distinctAgentThreshold: 2,
      contextHashDivergence: 2,
      distinctSignalSources: 2,
    });
    const snap = snapshot("t1", {
      dispatches: [
        { agentId: "a", contextHash: "h1" },
        { agentId: "b", contextHash: "h2" },
      ],
      signals: [
        { kind: "tool_observation", source: "s1" },
        { kind: "tool_observation", source: "s2" },
      ],
    });
    const patterns = det.detect([snap], []);
    expect(patterns.length).toBe(1);
  });

  test("evaluates each thread independently", () => {
    const det = new WorkstreamOverloadDetector();
    const focused = snapshot("t-focused", {
      dispatches: [{ agentId: "executor", contextHash: "h1" }],
      signals: [{ kind: "tool_observation", source: "executor" }],
    });
    const overloaded = snapshot("t-overloaded", {
      dispatches: [
        { agentId: "a", contextHash: "h1" },
        { agentId: "b", contextHash: "h2" },
        { agentId: "c", contextHash: "h3" },
        { agentId: "d", contextHash: "h4" },
      ],
      signals: [
        { kind: "tool_observation", source: "s1" },
        { kind: "tool_observation", source: "s2" },
        { kind: "tool_observation", source: "s3" },
        { kind: "tool_observation", source: "s4" },
      ],
    });
    const patterns = det.detect([focused, overloaded], []);
    expect(patterns.length).toBe(1);
    expect(patterns[0].threads).toEqual(["t-overloaded"]);
  });
});

describe("WORKSTREAM_DETECTOR_PROMPT", () => {
  // Drift detector — if any of these JSON keys disappear, the eventual
  // LLM-classifier upgrade will break silently. Cheap to keep in sync.
  test("declares the expected output schema", () => {
    for (const fragment of [
      "workstreams",
      "multipleDetected",
      "primary",
      "recommendation",
      "confidence",
    ]) {
      expect(WORKSTREAM_DETECTOR_PROMPT).toContain(fragment);
    }
  });

  test("is precision-biased", () => {
    expect(WORKSTREAM_DETECTOR_PROMPT.toLowerCase()).toContain("precision");
    expect(WORKSTREAM_DETECTOR_PROMPT).toMatch(/false split.*more disruptive/i);
  });
});
