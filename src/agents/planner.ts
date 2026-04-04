import { computeHash } from "./context-layer";
import { BaseAgent, type AgentConfig, type ExecutionResult } from "./base-agent";
import type { LayerFilter } from "./context-stack";

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

export interface PlanStep {
  id: string;
  description: string;
  /** Which agent should handle this step. */
  agentId?: string;
  /** Step IDs that must complete first. */
  dependencies?: string[];
  /** Estimated token cost for this step. */
  estimatedTokens?: number;
  /** Layer IDs needed for this step. */
  contextNeeded?: string[];
  status: "pending" | "active" | "done" | "skipped" | "failed";
}

export interface Plan {
  id: string;
  goal: string;
  steps: PlanStep[];
  estimatedTotalTokens: number;
  complexity: "low" | "medium" | "high";
  reasoning: string;
  createdAt: number;
}

export interface PlanExecutionResult {
  plan: Plan;
  results: Map<string, ExecutionResult<unknown>>;
  totalTokens: { input: number; output: number };
  totalCost: number;
  completedSteps: number;
  failedSteps: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Planner config
// ---------------------------------------------------------------------------

export type PlanHandler = (
  context: string,
  payload: unknown
) => Promise<Plan>;

export interface PlannerConfig extends AgentConfig {
  /** Max steps in a plan. Defaults to 10. */
  maxSteps?: number;
  /** Whether to include token estimates. Defaults to true. */
  estimateTokens?: boolean;
  /** Available agents this planner knows about. */
  availableAgents?: Array<{ id: string; description: string; kind: string }>;
  /** Handler that produces a Plan from context + payload. */
  handler: PlanHandler;
  /**
   * Agent registry for plan execution.
   * Maps agent ID to a BaseAgent that can be dispatched.
   */
  agentRegistry?: Map<string, BaseAgent>;
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

/**
 * A specialized agent that generates execution plans before work begins.
 *
 * This is Foundry's native "plan mode" — when the system detects complexity,
 * it auto-routes to a Planner before dispatching to executors.
 *
 * The Planner:
 * 1. Assembles context like any agent
 * 2. Builds a planning prompt with available agents and context layers
 * 3. Uses a handler to produce a structured Plan
 * 4. Can execute the plan step by step via executePlan()
 */
export class Planner extends BaseAgent<unknown, Plan> {
  private _handler: PlanHandler;
  private _maxSteps: number;
  private _estimateTokens: boolean;
  private _availableAgents: Array<{ id: string; description: string; kind: string }>;
  private _agentRegistry: Map<string, BaseAgent>;

  constructor(config: PlannerConfig) {
    super(config);
    this._handler = config.handler;
    this._maxSteps = config.maxSteps ?? 10;
    this._estimateTokens = config.estimateTokens ?? true;
    this._availableAgents = config.availableAgents ?? [];
    this._agentRegistry = config.agentRegistry ?? new Map();
  }

  async run(
    payload: unknown,
    filterOverride?: LayerFilter
  ): Promise<ExecutionResult<Plan>> {
    const context = this.getContextWith(filterOverride);
    const contextHash = computeHash(context);

    // Build enriched context that includes planning metadata
    const planningContext = this._buildPlanningContext(context);

    const plan = await this._handler(planningContext, payload);

    // Enforce maxSteps
    if (plan.steps.length > this._maxSteps) {
      plan.steps.length = this._maxSteps;
    }

    // Strip token estimates if disabled
    if (!this._estimateTokens) {
      for (const step of plan.steps) {
        step.estimatedTokens = undefined;
      }
      plan.estimatedTotalTokens = 0;
    }

    return { output: plan, contextHash };
  }

  /**
   * Execute a plan step by step, dispatching to agents in dependency order.
   *
   * Walks steps in topological order so dependencies complete before
   * dependents start. Dispatches each step to its specified agent from
   * the registry. Handles failures gracefully — marks step failed and
   * skips dependents.
   */
  async executePlan(plan: Plan): Promise<PlanExecutionResult> {
    const startTime = performance.now();
    const results = new Map<string, ExecutionResult<unknown>>();
    let totalInput = 0;
    let totalOutput = 0;
    let completedSteps = 0;
    let failedSteps = 0;

    const ordered = topologicalSort(plan.steps);
    const failedIds = new Set<string>();

    for (const step of ordered) {
      // Skip if any dependency failed
      const hasFailed = step.dependencies?.some((dep) => failedIds.has(dep));
      if (hasFailed) {
        step.status = "skipped";
        continue;
      }

      const agent = step.agentId
        ? this._agentRegistry.get(step.agentId)
        : undefined;

      if (!agent) {
        step.status = "failed";
        failedSteps++;
        failedIds.add(step.id);
        continue;
      }

      step.status = "active";

      try {
        // Build a layer filter from contextNeeded if specified
        const needed = step.contextNeeded;
        const filter: LayerFilter | undefined = needed
          ? (layer) => needed.includes(layer.id)
          : undefined;

        const result = await agent.run(step.description, filter);
        results.set(step.id, result);

        if (result.tokens) {
          totalInput += result.tokens.input;
          totalOutput += result.tokens.output;
        }

        step.status = "done";
        completedSteps++;
      } catch {
        step.status = "failed";
        failedSteps++;
        failedIds.add(step.id);
      }
    }

    const durationMs = Math.round(performance.now() - startTime);

    return {
      plan,
      results,
      totalTokens: { input: totalInput, output: totalOutput },
      totalCost: 0, // Cost calculation left to TokenTracker
      completedSteps,
      failedSteps,
      durationMs,
    };
  }

  // -- Internal --

  /**
   * Enrich context with planning metadata: available agents and layer info.
   */
  private _buildPlanningContext(baseContext: string): string {
    const parts: string[] = [baseContext];

    if (this._availableAgents.length > 0) {
      parts.push("");
      parts.push("## Available Agents");
      for (const a of this._availableAgents) {
        parts.push(`- **${a.id}** (${a.kind}): ${a.description}`);
      }
    }

    if (this._estimateTokens) {
      parts.push("");
      parts.push(
        "## Planning Instructions"
      );
      parts.push(
        "Include token estimates for each step. Keep the total plan under " +
          this._maxSteps +
          " steps."
      );
    }

    return parts.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Topological sort — walks steps in dependency order
// ---------------------------------------------------------------------------

function topologicalSort(steps: PlanStep[]): PlanStep[] {
  const stepMap = new Map<string, PlanStep>();
  for (const step of steps) {
    stepMap.set(step.id, step);
  }

  const visited = new Set<string>();
  const ordered: PlanStep[] = [];

  function visit(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);

    const step = stepMap.get(id);
    if (!step) return;

    // Visit dependencies first
    if (step.dependencies) {
      for (const dep of step.dependencies) {
        visit(dep);
      }
    }

    ordered.push(step);
  }

  for (const step of steps) {
    visit(step.id);
  }

  return ordered;
}
