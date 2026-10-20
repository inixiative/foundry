/**
 * @atlas
 * @kind entrypoint
 * @partOf feature:conversations
 * @uses integration:kingdom, feature:viewer, feature:threads, feature:wardens
 */
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  ActionQueue,
  ContextStack,
  EventStream,
  FileMemory,
  Harness,
  InterventionLog,
  type LLMMessage,
  type LLMProvider,
  newId,
  ToolRegistry,
} from '@inixiative/foundry-core';
import { ProjectRegistry } from '../agents/project';
import {
  buildAgents,
  buildLayers,
  createSourceResolver,
  ThreadFactory,
} from '../agents/thread-factory';
import { ThreadRuntimeManager } from '../agents/thread-runtime';
import { pairKingdomIntegration } from '../providers/kingdom-pairing';
import { CONVERSATION_TOOL_DESCRIPTION, ConversationTool } from '../tools/conversation';
import { ConfigStore, createProject } from '../viewer/config';
import { createViewer } from '../viewer/server';
import {
  type HeadlessHostCommand,
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
  if (!home || home.startsWith('..') || isAbsolute(home))
    throw Error(
      'Give the headless host its own HOME inside the directory holding its configDir: it runs as its own machine',
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
    if (options.project && !Object.values(draft.projects).some((p) => p.path === options.project)) {
      const project = createProject(options.project, { label: 'Headless project' });
      draft.projects = { ...draft.projects, [project.id]: project };
    }
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

  const memory = new FileMemory(`${options.configDir}/memory`);
  await memory.load();
  const sourceResolver = createSourceResolver({ memory });
  const stack = new ContextStack(buildLayers(config, { sourceResolver }));
  await stack.warmAll();
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
  // why: stands where start.ts's subscription decision host does: its id, and a prestart, so Warden caches warm at thread start.
  const warden: LLMProvider = {
    id: 'subscription-decisions',
    prestart() {},
    async complete(messages, opts) {
      const answer = await ask('warden', opts?.threadId ?? null, messages.map(textOf).join('\n'));
      return { model: 'headless', content: answer.content };
    },
  };
  const runtime = new ThreadRuntimeManager({
    config,
    llm: warden,
    providers: new Map([
      [agent.id, agent],
      [warden.id, warden],
    ]),
    eventStream: events,
    resolveSource: sourceResolver,
    learning: { enabled: false },
    conversations: lateConversationWrapper(() => viewer?.conversations ?? undefined),
    log() {},
    warn: (line) => console.warn(line),
  });
  const agents = { provider: agent, tools };
  const factory = new ThreadFactory({
    stack,
    runtime,
    nativeTools: tools,
    agents: buildAgents(config, stack, agents),
    configuration: { config, layers: { sourceResolver }, agents },
  });
  const projectRegistry = new ProjectRegistry();
  projectRegistry.loadFromConfigs(config.projects);
  const firstProject = projectRegistry.all.values().next().value;
  const main = factory.create('main', {
    description: 'Main conversation thread',
    ...(firstProject ? { projectId: firstProject.id } : {}),
  });
  firstProject?.addThread(main);
  const harness = new Harness(main);
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
    projectRegistry,
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

  const answer = async (command: HeadlessHostCommand) => {
    if (command.type === 'model') {
      answers.get(command.callId)?.({ content: command.content, sends: command.sends ?? [] });
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
  };
  // A command that fails is answered (500), so the parent never waits on a host that dropped it.
  process.on('message', (message) => {
    const command = headlessHostCommandSchema.safeParse(message);
    if (!command.success) return emit({ type: 'failed', error: command.error.message });
    answer(command.data).catch((error: unknown) => {
      const requestId = 'requestId' in command.data ? command.data.requestId : null;
      const text = error instanceof Error ? error.message : String(error);
      emit(
        requestId
          ? { type: 'reply', requestId, status: 500, body: { error: text } }
          : { type: 'failed', error: text },
      );
    });
  });
  emit({ type: 'ready', integrationId: integration.integrationId });
}

if (import.meta.main)
  main().catch((error: unknown) => {
    emit({ type: 'failed', error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
