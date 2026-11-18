import type { AgentSettingsConfig } from '../../src/viewer/config';

/** One executor, the Artificer, on `workerProvider`: the agents a settings fixture runs threads with. */
export function artificerAgents(workerProvider: string): Record<string, AgentSettingsConfig> {
  return {
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
