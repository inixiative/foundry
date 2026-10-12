import type {
  McpServer,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import type {
  ClientMcpServer,
  FoundryClient,
  MessageSummary,
  ThreadLaunchView,
} from '@inixiative/foundry/client';
import { toolKind, toolLocations, toolTitle } from './tools';

/**
 * ACP modes are the hosts' own permission modes (Claude's ids, which Zed and Paseo render), passed
 * through to the native runtime. Foundry adds none of its own and none stricter than the host's.
 */
export const MODES: SessionModeState['availableModes'] = [
  { id: 'default', name: 'Default', description: 'Ask before what the runtime would ask about' },
  { id: 'acceptEdits', name: 'Accept edits', description: 'Edit files without asking' },
  { id: 'plan', name: 'Plan', description: 'Read and plan; no edits or commands' },
  { id: 'bypassPermissions', name: 'Full access', description: 'Never ask' },
];
/** A session a host opens runs in the host's default mode until it picks another. */
export const DEFAULT_MODE = 'default';

export function modeState(view: ThreadLaunchView): SessionModeState {
  return { currentModeId: view.permissionMode ?? 'bypassPermissions', availableModes: MODES };
}

export function configOptions(view: ThreadLaunchView): SessionConfigOption[] {
  const models = view.options.models.map((model) => ({ value: model.id, name: model.label }));
  if (!models.some((model) => model.value === view.model))
    models.unshift({ value: view.model, name: view.model });
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: view.model,
      options: models,
    },
    {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: view.effort ?? 'default',
      options: [
        { value: 'default', name: 'Default' },
        ...view.options.efforts.map((effort) => ({ value: effort, name: effort })),
      ],
    },
  ];
}

/** A host's MCP servers in Foundry's shape. SSE and MCP-over-ACP are not offered. */
export function clientMcpServers(servers: readonly McpServer[] = []): ClientMcpServer[] {
  return servers.flatMap((server): ClientMcpServer[] => {
    if (!('type' in server) || server.type === undefined)
      return [
        {
          name: server.name,
          command: server.command,
          args: [...server.args],
          env: server.env.map((v) => ({ name: v.name, value: v.value })),
        },
      ];
    if (server.type === 'http')
      return [
        {
          type: 'http',
          name: server.name,
          url: server.url,
          headers: server.headers.map((h) => ({ name: h.name, value: h.value })),
        },
      ];
    return [];
  });
}

/** Every journalled message of a thread, oldest first. */
async function allMessages(http: FoundryClient, threadId: string): Promise<MessageSummary[]> {
  const pages: MessageSummary[][] = [];
  let before: string | undefined;
  for (;;) {
    const page = await http.history(threadId, before);
    pages.unshift(page.messages);
    if (!page.hasMore || !page.nextCursor) break;
    before = page.nextCursor;
  }
  return pages.flat();
}

type Native = {
  kind?: string;
  callId?: string;
  itemId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  toolError?: boolean;
};

/** A thread's history as `session/update`s: each turn's user words, its tool calls, then its answer. */
export async function replayHistory(
  http: FoundryClient,
  threadId: string,
  cwd: string | undefined,
): Promise<SessionUpdate[]> {
  const updates: SessionUpdate[] = [];
  for (const message of await allMessages(http, threadId)) {
    if (message.actor === 'user') {
      updates.push({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: message.content },
      });
      continue;
    }
    if (message.detail.nativeHistory || message.detail.nativeTools) {
      const detail = (await http.turnDetail(threadId, message.turnId).catch(() => null)) as {
        nativeHistory?: Native[];
      } | null;
      const results = new Map<string, Native>();
      for (const event of detail?.nativeHistory ?? [])
        if (event.kind === 'tool_result' && event.callId) results.set(event.callId, event);
      for (const event of detail?.nativeHistory ?? []) {
        if (event.kind !== 'tool_use' || !event.callId) continue;
        const result = results.get(event.callId);
        const name = event.toolName ?? 'Tool';
        updates.push({
          sessionUpdate: 'tool_call',
          toolCallId: `${message.turnId}:${event.callId}`,
          title: toolTitle(name, event.toolInput),
          kind: toolKind(name),
          status: !result ? 'completed' : result.toolError ? 'failed' : 'completed',
          ...(event.toolInput ? { rawInput: event.toolInput } : {}),
          locations: toolLocations(event.toolInput, cwd),
          ...(typeof result?.toolOutput === 'string'
            ? {
                rawOutput: { output: result.toolOutput },
                content: [{ type: 'content', content: { type: 'text', text: result.toolOutput } }],
              }
            : {}),
        });
      }
    }
    if (message.content)
      updates.push({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: message.kind === 'error' ? `Turn failed: ${message.content}` : message.content,
        },
      });
  }
  return updates;
}
