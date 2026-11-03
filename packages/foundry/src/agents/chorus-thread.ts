/**
 * @atlas
 * @kind service
 * @partOf feature:wardens, feature:evals
 */
// A thread of a project built the way the daemon builds one (the factory, the per-thread runtime
// with its Cartographer, region Wardens and FlowOrchestrator), but nobody's: hidden, learning off,
// disposed when its caller is done. chorus-advise sends one message through it; the project Warden
// host composes its roster from it, so the host holds exactly what a thread of the project sends.

import { ContextStack, type LLMMessage, type LLMProvider, newId } from '@inixiative/foundry-core';
import type { Roster } from '../providers/in-session-wardens';
import { isStageSession, isWardenSession, primedRequest } from '../providers/primed-decisions';
import type { FoundryConfig } from '../viewer/config';
import { buildAgents, buildLayers, type SourceResolver, ThreadFactory } from './thread-factory';
import {
  type PhaseRecordInput,
  type ThreadRuntime,
  type ThreadRuntimeDeps,
  ThreadRuntimeManager,
} from './thread-runtime';

export interface ChorusThreadOptions {
  /** The effective configuration a live thread composes under (subscription-resolved, overrides applied). */
  readonly config: FoundryConfig;
  readonly projectId: string;
  /** Where the thread works: the instruction ladder composes from here. */
  readonly cwd: string;
  /** The decision provider the Cartographer and every Warden run on (the daemon's decision host). */
  readonly decisions: LLMProvider;
  /** The provider of every other agent (the executor and other non-decision roles), by provider id. */
  readonly agentProvider: (id: string) => LLMProvider;
  /** A classify stage's own host (`ThreadRuntimeDeps.stageHost`). */
  readonly stageHost?: ThreadRuntimeDeps['stageHost'];
  readonly resolveSource: SourceResolver;
  readonly atlasRoot?: string;
  /** Every phase record (route, advice) the runtime journals, as the daemon's journal receives it. */
  readonly journal?: (record: PhaseRecordInput) => void;
  /** The secret scratch pad's reminder for a message (`ThreadRuntimeDeps.secretNote`). */
  readonly secretNote?: ThreadRuntimeDeps['secretNote'];
  /** The thread's id; its Wardens' sessions are keyed by it (`<thread>:aux:domain:<d>`). */
  readonly threadId?: string;
  readonly log?: (line: string) => void;
  readonly warn?: (line: string) => void;
}

/** The hidden thread a caller works with: its runtime (ready, with Wardens) and its providers. */
export interface ChorusThread {
  readonly thread: ReturnType<ThreadFactory['create']>;
  readonly live: ThreadRuntime;
  /** The provider the thread's central agent runs on. */
  readonly central: LLMProvider;
}

/**
 * Builds a hidden thread of the project at `cwd`, waits for its runtime, runs `use`, and disposes
 * the thread whatever `use` does. A project whose chorus is off or empty is refused.
 */
export async function withChorusThread<T>(
  opts: ChorusThreadOptions,
  use: (hidden: ChorusThread) => Promise<T>,
): Promise<T> {
  const { config } = opts;
  const threadId = opts.threadId ?? newId('chorus-thread');
  // Every agent provider but the decision host is the caller's; the decision roles stay on the decision host.
  const providers = new Map<string, LLMProvider>([[opts.decisions.id, opts.decisions]]);
  for (const agent of Object.values(config.agents)) {
    const id = agent.provider || config.defaults.provider;
    if (!providers.has(id)) providers.set(id, opts.agentProvider(id));
  }
  if (!providers.has(config.defaults.provider))
    providers.set(config.defaults.provider, opts.agentProvider(config.defaults.provider));
  const central = providers.get(config.defaults.provider)!;

  const stack = new ContextStack(buildLayers(config, { sourceResolver: opts.resolveSource }));
  await stack.warmAll();
  const runtime = new ThreadRuntimeManager({
    config,
    llm: opts.decisions,
    providers,
    // A hidden thread: the post-work review (learning) would only spend calls nobody reads.
    learning: { enabled: false },
    resolveSource: opts.resolveSource,
    ...(opts.stageHost ? { stageHost: opts.stageHost } : {}),
    ...(opts.atlasRoot ? { atlasRoot: opts.atlasRoot } : {}),
    ...(opts.secretNote ? { secretNote: opts.secretNote } : {}),
    log: opts.log ?? (() => {}),
    warn: opts.warn ?? ((line) => console.warn(line)),
  });
  if (opts.journal) {
    const journal = opts.journal;
    runtime.setPhaseJournal((_runtime, record) => journal(record));
  }
  const agents = { provider: central, providers };
  const factory = new ThreadFactory({
    stack,
    runtime,
    agents: buildAgents(config, stack, agents),
    configuration: { config, layers: { sourceResolver: opts.resolveSource }, agents },
  });
  const thread = factory.create(threadId, {
    description: 'chorus-thread',
    projectId: opts.projectId,
    cwd: opts.cwd,
  });
  try {
    const live = runtime.get(thread.id);
    if (!live) throw Error('the thread has no runtime');
    if (!live.domainLibrarians.size)
      throw Error(`project ${opts.projectId} runs no Wardens: its chorus is off or empty`);
    await live.ready;
    return await use({ thread, live, central });
  } finally {
    runtime.disposeAll();
    thread.dispose();
  }
}

/** Warm every Warden of a hidden thread and ask each to pre-start (what a live thread does after a turn). */
export async function warmWardens(live: ThreadRuntime): Promise<void> {
  await Promise.all(
    [...live.domainLibrarians.values()].map(async (lib) => {
      await lib.warm();
      lib.prestart();
    }),
  );
}

/** One Warden of a project roster: its region and what its spare holds. */
export interface ProjectRosterEntry {
  readonly domain: string;
  readonly spec: Roster[number]['spec'];
}

/**
 * A project's Warden roster for its host (`decisionRuntime: claude-project`): each Warden composed as
 * a thread of the project composes it (charter, region instructions, region knowledge; at the
 * project's root), split at the stable prefix, so the held part carries no thread state. Built from a
 * hidden thread: its Wardens warm and pre-start against a provider that records what each would hold
 * and answers nothing. Only a Warden's own first stage on the decision host is held (later stages and
 * other models stay primed).
 */
export async function composeProjectRoster(
  opts: Omit<ChorusThreadOptions, 'cwd' | 'agentProvider' | 'journal'>,
): Promise<ProjectRosterEntry[]> {
  const root = opts.config.projects?.[opts.projectId]?.path;
  if (!root) throw Error(`project ${opts.projectId} has no path`);
  const refuse = (id: string): LLMProvider => ({
    id,
    complete: async () => {
      throw Error('composing a project roster makes no model call');
    },
  });
  const held = new Map<string, ProjectRosterEntry>();
  const recording: LLMProvider = {
    ...refuse(opts.decisions.id),
    prestart: (messages: LLMMessage[], callOpts) => {
      const key = callOpts.threadId;
      if (!key || !isWardenSession(key) || isStageSession(key)) return;
      const domain = /:aux:domain:(.+)$/.exec(key)?.[1];
      if (!domain) return;
      const { spec } = primedRequest(messages, callOpts, key);
      // Advice and guard compose one system for a region Warden: the first is the one held.
      if (!held.has(spec.hash ?? spec.key)) held.set(spec.hash ?? spec.key, { domain, spec });
    },
  };
  return withChorusThread(
    {
      ...opts,
      cwd: root,
      decisions: recording,
      agentProvider: refuse,
      threadId: opts.threadId ?? newId('project-roster'),
    },
    async ({ live }) => {
      await warmWardens(live);
      return [...held.values()];
    },
  );
}
