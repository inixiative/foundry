import type { AgentSettingsConfig } from './viewer/config';

/**
 * The routed agents: a classifier and a router on the decision profile ahead of the Artificer. A
 * fresh install runs none of this (viewer/config.ts, defaultAgents). (The "development team" that
 * added hand-named decider Wardens per domain beside these went with the roster, 2026-10-17: a
 * project's Wardens are its region Wardens.)
 */
export function routedAgents(
  workerProvider: string,
  decision: { provider: string; model: string },
): Record<string, AgentSettingsConfig> {
  const decisionRole = {
    flowRole: 'context-routing',
    provider: decision.provider,
    model: decision.model,
    temperature: 0,
    tools: false,
    visibleLayers: [],
    ownedLayers: [],
    peers: [],
    maxDepth: 1,
    invocation: 'always' as const,
    enabled: true,
  };
  return {
    classifier: {
      ...decisionRole,
      id: 'classifier',
      kind: 'classifier',
      prompt:
        'Classify the incoming message into exactly one category.\nCategories: bug, feature, refactor, question, convention, general.\nRespond with JSON: {"category": "...", "subcategory": "...", "reasoning": "..."}',
    },
    router: {
      ...decisionRole,
      id: 'router',
      kind: 'router',
      prompt:
        'Route the classified message to the Artificer with the right context layers.\nChoose which layers are relevant to the task.\nRespond with JSON: {"destination": "artificer", "contextSlice": ["layer1"], "priority": 5, "reasoning": "..."}',
    },
    artificer: {
      id: 'artificer',
      kind: 'executor',
      flowRole: 'execution',
      prompt:
        "You are the Artificer — the engineering agent.\n\nYou receive tasks that have already been classified and routed to you with the right context layers. Your job is to execute: read code, write code, run tests, fix bugs, build features, answer questions.\n\nYour workflow:\n1. Understand the task from the routed context and user message\n2. Explore the codebase to build the mental model you need\n3. Implement incrementally — build, test, iterate\n4. Verify your changes don't break existing tests\n\nFollow project conventions. Write clean, tested code. Prefer editing existing files over creating new ones. Explain your reasoning when it's non-obvious.",
      provider: workerProvider,
      temperature: 0,
      tools: true,
      permissions: 'bypass' as const,
      visibleLayers: [],
      ownedLayers: [],
      peers: [],
      maxDepth: 5,
      invocation: 'on-demand' as const,
      enabled: true,
    },
  };
}
