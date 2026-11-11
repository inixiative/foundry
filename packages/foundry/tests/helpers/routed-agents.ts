import type { AgentSettingsConfig } from '../../src/viewer/config';

/**
 * A routed-agents settings fixture: a classifier and a router on the decision profile ahead of the
 * Artificer. Production never seeds these (viewer/config.ts, defaultAgents); tests use it to cover
 * wrapped threads.
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
      prompt: '',
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
