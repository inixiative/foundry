/**
 * @atlas
 * @kind entrypoint
 * @partOf feature:conversations
 * @uses integration:kingdom, feature:viewer, feature:threads, feature:wardens
 */
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  ActionQueue,
  ContextLayer,
  ContextStack,
  EventStream,
  Harness,
  InterventionLog,
  type LLMMessage,
  type LLMProvider,
  newId,
  ToolRegistry,
} from '@inixiative/foundry-core';
import { buildAgents, ThreadFactory } from '../agents/thread-factory';
import { ThreadRuntimeManager } from '../agents/thread-runtime';
import { pairKingdomIntegration } from '../providers/kingdom-pairing';
import { CONVERSATION_TOOL_DESCRIPTION, ConversationTool } from '../tools/conversation';
import { ConfigStore } from '../viewer/config';
import { createViewer } from '../viewer/server';
import {
  type HeadlessHostEvent,
  type HeadlessThreadState,
  headlessHostCommandSchema,
  headlessHostEnv,
  headlessHostOptionsSchema,
} from './headless-host-protocol';
import { lateConversationWrapper } from './types';

/**
 * Foundry's conversation host without a native agent: what `start.ts` composes (paired with Kingdom
 * by Foundry's own pairing, the viewer with its Installation sockets and conversation wrapper, the
 * turn path, a factory-built main thread with its runtime and Wardens, `send_to_member` on the tool
 * registry the native MCP bridge dispatches to), with every model call answered by the parent
 * process over IPC (`headless-host-protocol.ts`). It runs in its own process, as Foundry does beside
 * Kingdom, so a consumer drives the real host without importing its module graph.
 */

const emit = (event: HeadlessHostEvent) => {
  process.send?.(event);
};

const textOf = (message: LLMMessage) =>
  typeof message.content === 'string' ? message.content : JSON.stringify(message.content);

const answers = new Map<
  string,
  (answer: { content: string; sends: { member: string; text: string }[] }) => void
>();

const ask = (role: 'agent' | 'warden', threadId: string | null, text: string) => {
  const callId = newId('call');
  const answered = new Promise<{ content: string; sends: { member: string; text: string }[] }>(
    (resolve) => answers.set(callId, resolve),
  );
  emit({ type: 'model', callId, role, threadId, text });
  return answered;
};

async function main() {
  const options = headlessHostOptionsSchema.parse(JSON.parse(process.env[headlessHostEnv] ?? '{}'));
  // why: HOME holds the machine's Archive token, device identity and logins; a test host must not touch them.
  const home = relative(dirname(resolve(options.configDir)), process.env.HOME ?? '/');
  if (home.startsWith('..') || isAbsolute(home))
    throw Error(
      'Give the headless host its own HOME beside its configDir: it runs as its own machine',
    );
  const store = new ConfigStore(options.configDir);
  if (!(await store.load()).kingdomIntegrations?.length)
    await pairKingdomIntegration(store, options.configDir, {
      url: options.url,
      name: options.name,
      onReview: ({ reviewCode }) => emit({ type: 'review', reviewCode }),
      socketOptions: { retryBaseMs: 50 },
    });
  await store.update((draft) => {
    draft.defaults.provider = 'claude-code';
    draft.defaults.model = 'claude-opus-5-5';
    draft.layers = {};
    draft.agents = {
      worker: {
        id: 'worker',
        kind: 'executor',
        provider: 'claude-code',
        model: 'claude-opus-5-5',
        prompt: 'Work for the owner.',
        temperature: 0,
        visibleLayers: [],
        peers: [],
        maxDepth: 1,
        enabled: true,
      },
    };
  });
  const config = await store.load();
  const [integration] = config.kingdomIntegrations ?? [];
  if (!integration) throw Error('Pairing saved no Kingdom integration');

  const knowledge = options.warden
    ? new ContextLayer({ id: options.warden.domain, segment: 'domain-knowledge' })
    : null;
  if (knowledge && options.warden) knowledge.set(options.warden.knowledge);
  const stack = new ContextStack(knowledge ? [knowledge] : []);
  const events = new EventStream();
  const queue = new ActionQueue();
  const tools = new ToolRegistry();
  let viewer: ReturnType<typeof createViewer> | undefined;
  tools.register(
    new ConversationTool(() => viewer?.conversations ?? null),
    CONVERSATION_TOOL_DESCRIPTION,
  );
  const sends = new Map<string, HeadlessThreadState['sends']>();
  const agent: LLMProvider = {
    id: 'headless-agent',
    async complete(messages, opts) {
      const threadId = opts?.threadId ?? null;
      const text = messages
        .filter((message) => message.role === 'user')
        .map(textOf)
        .join('\n');
      const answer = await ask('agent', threadId, text);
      for (const send of answer.sends) {
        if (!threadId) throw Error('send_to_member runs only inside a thread');
        const result = await tools.dispatch(
          'conversation_request',
          { url: 'send_to_member', method: 'POST', body: send },
          { scope: { threadId } },
        );
        sends.set(threadId, [...(sends.get(threadId) ?? []), { ...send, answer: result.summary }]);
      }
      return { model: 'headless', content: answer.content };
    },
  };
  const warden: LLMProvider = {
    id: 'headless-warden',
    async complete(messages, opts) {
      const answer = await ask('warden', opts?.threadId ?? null, messages.map(textOf).join('\n'));
      return { model: 'headless', content: answer.content };
    },
  };
  const runtime = new ThreadRuntimeManager({
    config,
    llm: warden,
    eventStream: events,
    domains: options.warden
      ? [{ domain: options.warden.domain, layerId: options.warden.domain, guardTriggers: [] }]
      : [],
    learning: { enabled: false },
    conversations: lateConversationWrapper(() => viewer?.conversations ?? undefined),
    log() {},
    warn() {},
  });
  const factory = new ThreadFactory({
    stack,
    runtime,
    nativeTools: tools,
    agents: buildAgents(config, stack, { provider: agent, tools }),
  });
  const harness = new Harness(factory.create('main', { description: 'Main conversation thread' }));
  harness.setDefaultExecutor('worker');
  viewer = createViewer({
    harness,
    eventStream: events,
    interventions: new InterventionLog(),
    configDir: options.configDir,
    configStore: store,
    kingdomIntegrations: config.kingdomIntegrations,
    actionQueue: queue,
    threadFactory: factory,
  });
  const host = viewer;
  const { conversations, localStore } = host;
  if (!conversations || !localStore) throw Error('The viewer built no conversation wrapper');
  const unavailable = await host.kingdom.start();
  if (unavailable.length) throw Error(`Kingdom did not authorize this Foundry: ${unavailable}`);

  const heldIds = () =>
    queue.pending().flatMap((prompt) => {
      const held = prompt.meta?.conversationHeld as { heldId?: unknown } | undefined;
      return typeof held?.heldId === 'string' ? [held.heldId] : [];
    });
  const state = (threadId: string): HeadlessThreadState => {
    const phases = localStore.phaseHistory(threadId, { limit: 5000 });
    return {
      summary: conversations.summary(threadId) ?? null,
      members: conversations.members(threadId).map((member) => ({
        id: member.member.id,
        displayName: member.displayName,
        listed: member.listed,
      })),
      posts: phases
        .filter((row) => row.phase === 'member-post')
        .map((row) => ({
          signetId: String(row.record.signetId),
          text: String(row.record.text),
          delivery: String(row.record.delivery),
        })),
      consumedAdvice: phases.filter(
        (row) => row.phase === 'advice' && row.record.trigger === 'consumed',
      ).length,
      archivedPosts: localStore
        .archiveRecords(threadId)
        .phases.filter((phase) => phase.phase === 'member-post').length,
      heldIds: heldIds(),
      sends: sends.get(threadId) ?? [],
    };
  };
  const stop = () => {
    host.kingdom.stop();
    conversations.dispose();
    runtime.disposeAll();
    localStore.close();
  };

  process.on('message', async (message) => {
    const command = headlessHostCommandSchema.parse(message);
    if (command.type === 'model') {
      answers.get(command.callId)?.({ content: command.content, sends: command.sends });
      answers.delete(command.callId);
      return;
    }
    if (command.type === 'stop') {
      stop();
      process.exit(0);
    }
    if (command.type === 'inspect')
      return emit({
        type: 'reply',
        requestId: command.requestId,
        status: 200,
        body: state(command.threadId),
      });
    const response = await host.app.request(command.path, {
      method: command.method,
      headers: { 'content-type': 'application/json' },
      ...(command.body === undefined ? {} : { body: JSON.stringify(command.body) }),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    emit({ type: 'reply', requestId: command.requestId, status: response.status, body });
  });
  emit({ type: 'ready', integrationId: integration.integrationId });
}

if (import.meta.main)
  main().catch((error: unknown) => {
    emit({ type: 'failed', error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
