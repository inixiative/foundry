import { describe, test, expect } from "bun:test";
import { ContextLayer, type ContextSource } from "../src/agents/context-layer";
import { ContextStack } from "../src/agents/context-stack";
import { Executor } from "../src/agents/executor";
import { Planner, type Plan, type PlanHandler } from "../src/agents/planner";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function source(id: string, content: string): ContextSource {
  return { id, load: async () => content };
}

function makeStack(...layers: [string, number, string][]): ContextStack {
  return new ContextStack(
    layers.map(([id, trust, content]) => {
      const l = new ContextLayer({ id, trust, sources: [source(id, content)] });
      l.set(content);
      return l;
    })
  );
}

function makePlan(overrides?: Partial<Plan>): Plan {
  return {
    id: "plan_1",
    goal: "Test goal",
    steps: [
      { id: "s1", description: "Step 1", agentId: "exec1", status: "pending" as const },
      {
        id: "s2",
        description: "Step 2",
        agentId: "exec2",
        dependencies: ["s1"],
        status: "pending" as const,
      },
    ],
    estimatedTotalTokens: 1000,
    complexity: "medium",
    reasoning: "Two-step plan",
    createdAt: Date.now(),
    ...overrides,
  };
}

const defaultHandler: PlanHandler = async (_context, payload) => {
  return makePlan({ goal: String(payload) });
};

// ---------------------------------------------------------------------------
// Plan generation
// ---------------------------------------------------------------------------

describe("Planner", () => {
  test("run() produces a Plan with steps, goal, complexity", async () => {
    const stack = makeStack(["docs", 10, "Project documentation"]);
    const planner = new Planner({
      id: "planner",
      stack,
      handler: defaultHandler,
    });

    const result = await planner.run("Build a feature");
    const plan = result.output;

    expect(plan.id).toBe("plan_1");
    expect(plan.goal).toBe("Build a feature");
    expect(plan.steps.length).toBe(2);
    expect(plan.complexity).toBe("medium");
    expect(plan.reasoning).toBeTruthy();
    expect(plan.createdAt).toBeGreaterThan(0);
    expect(result.contextHash).toBeTruthy();
  });

  test("plan with available agents — agent descriptions included in context", async () => {
    let capturedContext = "";
    const handler: PlanHandler = async (context, payload) => {
      capturedContext = context;
      return makePlan({ goal: String(payload) });
    };

    const stack = makeStack(["docs", 10, "Docs"]);
    const planner = new Planner({
      id: "planner",
      stack,
      handler,
      availableAgents: [
        { id: "coder", description: "Writes code", kind: "executor" },
        { id: "reviewer", description: "Reviews code", kind: "executor" },
      ],
    });

    await planner.run("Plan something");

    expect(capturedContext).toContain("Available Agents");
    expect(capturedContext).toContain("coder");
    expect(capturedContext).toContain("Writes code");
    expect(capturedContext).toContain("reviewer");
    expect(capturedContext).toContain("Reviews code");
  });

  test("maxSteps enforcement — plans exceeding maxSteps are truncated", async () => {
    const manyStepsHandler: PlanHandler = async (_context, payload) => {
      return makePlan({
        goal: String(payload),
        steps: Array.from({ length: 20 }, (_, i) => ({
          id: `s${i}`,
          description: `Step ${i}`,
          agentId: "exec1",
          status: "pending" as const,
        })),
      });
    };

    const stack = makeStack(["docs", 10, "Docs"]);
    const planner = new Planner({
      id: "planner",
      stack,
      handler: manyStepsHandler,
      maxSteps: 5,
    });

    const result = await planner.run("Big plan");
    expect(result.output.steps.length).toBe(5);
  });

  test("estimateTokens flag — when false, steps don't have token estimates", async () => {
    const handler: PlanHandler = async (_context, payload) => {
      return makePlan({
        goal: String(payload),
        steps: [
          {
            id: "s1",
            description: "Step 1",
            agentId: "exec1",
            estimatedTokens: 500,
            status: "pending",
          },
          {
            id: "s2",
            description: "Step 2",
            agentId: "exec2",
            estimatedTokens: 300,
            status: "pending",
          },
        ],
        estimatedTotalTokens: 800,
      });
    };

    const stack = makeStack(["docs", 10, "Docs"]);
    const planner = new Planner({
      id: "planner",
      stack,
      handler,
      estimateTokens: false,
    });

    const result = await planner.run("Plan without estimates");
    for (const step of result.output.steps) {
      expect(step.estimatedTokens).toBeUndefined();
    }
    expect(result.output.estimatedTotalTokens).toBe(0);
  });

  test("estimateTokens defaults to true — context includes planning instructions", async () => {
    let capturedContext = "";
    const handler: PlanHandler = async (context, payload) => {
      capturedContext = context;
      return makePlan({ goal: String(payload) });
    };

    const stack = makeStack(["docs", 10, "Docs"]);
    const planner = new Planner({
      id: "planner",
      stack,
      handler,
    });

    await planner.run("Plan");
    expect(capturedContext).toContain("Planning Instructions");
    expect(capturedContext).toContain("token estimates");
  });
});

// ---------------------------------------------------------------------------
// executePlan
// ---------------------------------------------------------------------------

describe("executePlan", () => {
  test("walks steps in order, dispatches to agents, collects results", async () => {
    const stack = makeStack(["docs", 10, "Context"]);
    const executionOrder: string[] = [];

    const exec1 = new Executor({
      id: "exec1",
      stack,
      handler: async (_ctx, payload: string) => {
        executionOrder.push("exec1");
        return `Result from exec1: ${payload}`;
      },
    });

    const exec2 = new Executor({
      id: "exec2",
      stack,
      handler: async (_ctx, payload: string) => {
        executionOrder.push("exec2");
        return `Result from exec2: ${payload}`;
      },
    });

    const registry = new Map<string, any>();
    registry.set("exec1", exec1);
    registry.set("exec2", exec2);

    const planner = new Planner({
      id: "planner",
      stack,
      handler: defaultHandler,
      agentRegistry: registry,
    });

    const plan = makePlan();
    const result = await planner.executePlan(plan);

    expect(executionOrder).toEqual(["exec1", "exec2"]);
    expect(result.completedSteps).toBe(2);
    expect(result.failedSteps).toBe(0);
    expect(result.results.size).toBe(2);
    expect(result.results.get("s1")?.output).toContain("Result from exec1");
    expect(result.results.get("s2")?.output).toContain("Result from exec2");
  });

  test("step B depends on step A — executed in dependency order", async () => {
    const stack = makeStack(["docs", 10, "Context"]);
    const executionOrder: string[] = [];

    const exec1 = new Executor({
      id: "exec1",
      stack,
      handler: async () => {
        executionOrder.push("exec1");
        return "done1";
      },
    });

    const exec2 = new Executor({
      id: "exec2",
      stack,
      handler: async () => {
        executionOrder.push("exec2");
        return "done2";
      },
    });

    const registry = new Map<string, any>();
    registry.set("exec1", exec1);
    registry.set("exec2", exec2);

    const planner = new Planner({
      id: "planner",
      stack,
      handler: defaultHandler,
      agentRegistry: registry,
    });

    // s2 depends on s1 — s1 must execute first
    const plan = makePlan({
      steps: [
        { id: "s2", description: "Depends on s1", agentId: "exec2", dependencies: ["s1"], status: "pending" },
        { id: "s1", description: "First step", agentId: "exec1", status: "pending" },
      ],
    });

    const result = await planner.executePlan(plan);

    // Despite s2 appearing first in the array, s1 should execute first
    expect(executionOrder).toEqual(["exec1", "exec2"]);
    expect(result.completedSteps).toBe(2);
  });

  test("one step fails — dependents are skipped, others continue", async () => {
    const stack = makeStack(["docs", 10, "Context"]);

    const failingExec = new Executor({
      id: "failing",
      stack,
      handler: async () => {
        throw new Error("Step failed!");
      },
    });

    const successExec = new Executor({
      id: "success",
      stack,
      handler: async () => "success result",
    });

    const independentExec = new Executor({
      id: "independent",
      stack,
      handler: async () => "independent result",
    });

    const registry = new Map<string, any>();
    registry.set("failing", failingExec);
    registry.set("success", successExec);
    registry.set("independent", independentExec);

    const planner = new Planner({
      id: "planner",
      stack,
      handler: defaultHandler,
      agentRegistry: registry,
    });

    const plan = makePlan({
      steps: [
        { id: "s1", description: "Will fail", agentId: "failing", status: "pending" },
        { id: "s2", description: "Depends on s1", agentId: "success", dependencies: ["s1"], status: "pending" },
        { id: "s3", description: "Independent", agentId: "independent", status: "pending" },
      ],
    });

    const result = await planner.executePlan(plan);

    expect(result.failedSteps).toBe(1);
    // s2 depends on failed s1, so it's skipped (not counted as failed)
    expect(plan.steps.find((s) => s.id === "s2")?.status).toBe("skipped");
    expect(plan.steps.find((s) => s.id === "s1")?.status).toBe("failed");
    expect(plan.steps.find((s) => s.id === "s3")?.status).toBe("done");
    // s3 should still complete successfully
    expect(result.results.get("s3")?.output).toBe("independent result");
    expect(result.completedSteps).toBe(1);
  });

  test("step with missing agent is marked as failed", async () => {
    const stack = makeStack(["docs", 10, "Context"]);
    const registry = new Map<string, any>();
    // No agents registered

    const planner = new Planner({
      id: "planner",
      stack,
      handler: defaultHandler,
      agentRegistry: registry,
    });

    const plan = makePlan({
      steps: [
        { id: "s1", description: "No agent", agentId: "nonexistent", status: "pending" },
      ],
    });

    const result = await planner.executePlan(plan);
    expect(result.failedSteps).toBe(1);
    expect(plan.steps[0].status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// PlanExecutionResult structure
// ---------------------------------------------------------------------------

describe("PlanExecutionResult", () => {
  test("verify completedSteps, failedSteps, totalTokens, durationMs", async () => {
    const stack = makeStack(["docs", 10, "Context"]);

    const exec1 = new Executor({
      id: "exec1",
      stack,
      handler: async () => "result1",
    });

    const exec2 = new Executor({
      id: "exec2",
      stack,
      handler: async () => "result2",
    });

    const registry = new Map<string, any>();
    registry.set("exec1", exec1);
    registry.set("exec2", exec2);

    const planner = new Planner({
      id: "planner",
      stack,
      handler: defaultHandler,
      agentRegistry: registry,
    });

    const plan = makePlan();
    const result = await planner.executePlan(plan);

    expect(result.completedSteps).toBe(2);
    expect(result.failedSteps).toBe(0);
    expect(result.totalTokens).toHaveProperty("input");
    expect(result.totalTokens).toHaveProperty("output");
    expect(typeof result.totalTokens.input).toBe("number");
    expect(typeof result.totalTokens.output).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.durationMs).toBe("number");
    expect(result.plan).toBe(plan);
    expect(result.results).toBeInstanceOf(Map);
    expect(typeof result.totalCost).toBe("number");
  });

  test("durationMs reflects actual execution time", async () => {
    const stack = makeStack(["docs", 10, "Context"]);

    const slowExec = new Executor({
      id: "exec1",
      stack,
      handler: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return "slow result";
      },
    });

    const registry = new Map<string, any>();
    registry.set("exec1", slowExec);

    const planner = new Planner({
      id: "planner",
      stack,
      handler: defaultHandler,
      agentRegistry: registry,
    });

    const plan = makePlan({
      steps: [{ id: "s1", description: "Slow step", agentId: "exec1", status: "pending" }],
    });

    const result = await planner.executePlan(plan);
    expect(result.durationMs).toBeGreaterThanOrEqual(40);
  });

  test("results map contains ExecutionResult for each completed step", async () => {
    const stack = makeStack(["docs", 10, "Context"]);

    const exec1 = new Executor({
      id: "exec1",
      stack,
      handler: async (_ctx, payload: string) => `output: ${payload}`,
    });

    const registry = new Map<string, any>();
    registry.set("exec1", exec1);

    const planner = new Planner({
      id: "planner",
      stack,
      handler: defaultHandler,
      agentRegistry: registry,
    });

    const plan = makePlan({
      steps: [{ id: "s1", description: "Only step", agentId: "exec1", status: "pending" }],
    });

    const result = await planner.executePlan(plan);
    const stepResult = result.results.get("s1");
    expect(stepResult).toBeDefined();
    expect(stepResult!.output).toContain("output:");
    expect(stepResult!.contextHash).toBeTruthy();
  });
});
