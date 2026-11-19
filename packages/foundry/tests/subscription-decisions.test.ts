import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeEvidence, NativeOwner } from '@inixiative/foundry-core';
import { ContextStack, EventStream, type LLMProvider } from '@inixiative/foundry-core';
import { regionRoleId } from '../src/agents/region-roster';
import {
  buildAgents,
  buildLayers,
  type SourceResolver,
  ThreadFactory,
} from '../src/agents/thread-factory';
import { scopedProvider, ThreadRuntimeManager } from '../src/agents/thread-runtime';
import { oneCall } from '../src/agents/warden';
import { KnowledgePersistence } from '../src/persistence/knowledge-persistence';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import {
  decisionFailedCause,
  NOT_HELD_REFUSAL,
  refusedUnsent,
} from '../src/providers/decision-budget';
import { DECISION_PRIORITY } from '../src/providers/decision-priority';
import {
  buildNativeTextProvider,
  type NativeTextConfig,
} from '../src/providers/native-text-provider';
import {
  buildSubscriptionDecisions,
  type SubscriptionDecisionConfig,
} from '../src/providers/subscription-decisions';
import { starterConfig } from '../src/viewer/config';
import { subscriptionTransport } from './helpers/subscription-transport';
import {
  DECIDED,
  decisionMessages,
  LIVE,
  recordedClaudeTransport,
  sameAsLive,
  settleRecordings,
} from './helpers/vcr';

const roots: string[] = [];
afterEach(async () => {
  await Bun.sleep(10);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(settleRecordings);
const LIVE_TIMEOUT = 90_000;
/** The hand-injected Warden's id: a namespaced role id, as a region Warden's is. */
const WARDEN = regionRoleId('warden');
type Transport = Parameters<typeof buildNativeTextProvider>[1] & {
  launches: { argv: string[]; cwd: string; exited: boolean }[];
  writes: number;
};
function fixture<T extends Transport>(
  transport: T = subscriptionTransport() as unknown as T,
  timeout = 2000,
  live = false,
) {
  const directory = mkdtempSync(join(tmpdir(), 'subscription-decisions-'));
  roots.push(directory);
  const profileDirectory = join(directory, 'profile');
  mkdirSync(profileDirectory, { mode: 0o700 });
  const config: SubscriptionDecisionConfig = {
    directory,
    source: {
      id: Bun.randomUUIDv7(),
      integrationId: Bun.randomUUIDv7(),
      runtime: 'claude',
      mode: 'native-profile',
      profileDirectory,
    },
    model: live ? LIVE.claudeModel : 'test-model',
    expectedObservedModel: live ? LIVE.claudeObservedModel : 'test-model',
    maxCalls: 20,
    maxQueued: 5,
    callTimeoutMs: timeout,
  };
  const run = buildSubscriptionDecisions(config, (cfg) => buildNativeTextProvider(cfg, transport));
  return { ...run, config, transport };
}
/** Claude decisions recorded from the real CLI; one status probe per call. */
const recorded = (decisions: string[]) =>
  fixture(
    recordedClaudeTransport({ status: decisions.map(() => 'subscribed'), decision: decisions }),
    30_000,
    true,
  );
const messages = [{ role: 'user' as const, content: 'private-input' }];
const owner: NativeOwner = {
  threadId: 'T',
  generation: 'G',
  dispatchId: 'D',
  projectId: 'P',
  reviewJobId: 'R',
};
const until = async (check: () => boolean) => {
  for (let n = 0; !check(); n++) {
    if (n > 100) throw Error('Controlled condition missing');
    await Bun.sleep(5);
  }
};

test(
  'serial native decisions preserve scoped logical ownership and accept only settled isolated output',
  async () => {
    const f = recorded(['serial-1', 'serial-2']),
      observed: NativeEvidence[] = [];
    const phase = scopedProvider(f.provider, {
      threadId: 'T:aux:review:G:domain:docs',
      cwd: '/logical/project',
    });
    const first = phase.complete(decisionMessages(), {
      nativeObservation: {
        owner,
        register(e) {
          observed.push(e);
        },
        observe(e) {
          observed.push(e);
        },
      },
    });
    const second = f.provider.complete(decisionMessages(), { threadId: 'T:aux:route' });
    const [result, other] = await Promise.all([first, second]);
    expect(f.transport.launches).toHaveLength(2);
    expect(f.transport.launches.every((p) => p.exited)).toBe(true);
    expect(
      f.transport.launches.every(
        (p) => p.cwd !== '/logical/project' && p.argv.includes('--safe-mode'),
      ),
    ).toBe(true);
    expect(result.native?.owner?.providerSessionKey).toBe('T:aux:review:G:domain:docs');
    const evidence = result.native!;
    const inspection = await phase.completionLifecycle!.inspectOwnedAdmission!(
      evidence.owner!,
      evidence.admissionId!,
    );
    expect(inspection).toMatchObject({ capacity: 'settled', cleanup: 'released' });
    expect(inspection!.evidence.content).toMatch(DECIDED);
    expect(
      await f.provider.completionLifecycle!.inspectOwnedAdmission!(
        { ...evidence.owner!, projectId: 'foreign' },
        evidence.admissionId!,
      ),
    ).toBeUndefined();
    expect(
      await f.provider.completionLifecycle!.releaseOwnedAdmission!(
        { ...evidence.owner!, dispatchId: 'foreign' },
        evidence.admissionId!,
      ),
    ).toBe('unavailable');
    expect(observed[0].nativeOutcome).toBe('unknown');
    expect(observed[0].content).toBeUndefined();
    expect(observed.at(-1)?.nativeOutcome).toBe('completed');
    for (const child of readdirSync(f.config.directory).filter((p) => p !== 'profile')) {
      const report = readFileSync(join(f.config.directory, child, 'native-text.json'), 'utf8');
      expect(report).not.toContain('private-input');
      expect(report).not.toContain(result.content);
    }
    f.close();
    const outcome = {
      answers: [result.content, other.content],
      observed: observed.map((e) => e.nativeOutcome),
    };
    expect(outcome).toEqual((await sameAsLive(f.transport.vcr, 'serial', outcome)).live);
  },
  LIVE_TIMEOUT,
);

for (const bad of ['model', 'tool'] as const)
  test(`${bad} violation never exposes a promotable learning answer`, async () => {
    const f = fixture(
      subscriptionTransport(bad === 'model' ? { model: 'wrong-model' } : { tool: true }),
    );
    let registration: NativeEvidence | undefined;
    const observed: NativeEvidence[] = [];
    await expect(
      f.provider.complete(messages, {
        threadId: 'T:aux:review:G:domain:docs',
        nativeObservation: {
          owner,
          register(e) {
            registration = e;
          },
          observe(e) {
            observed.push(e);
          },
        },
      }),
    ).rejects.toThrow('failed');
    expect(observed).toHaveLength(0);
    const inspection = await f.provider.completionLifecycle!.inspectOwnedAdmission!(
      registration!.owner!,
      registration!.admissionId!,
    );
    expect(inspection?.evidence.content).toBeUndefined();
    expect(inspection?.evidence.nativeOutcome).toBe('unknown');
    expect(f.snapshot().closed).toBe(true);
  });

test('queued expiry and revocation prevent a second native launch', async () => {
  let finish!: (value: string) => void;
  const f = fixture(
    subscriptionTransport({
      response: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    }),
  );
  const first = f.provider.complete(messages);
  await until(() => f.transport.writes === 1);
  const queued = f.provider.complete(messages, { timeout: 100 }).catch((error) => error);
  const error = await queued;
  expect(error).toBeInstanceOf(Error);
  expect(f.provider.completionLifecycle!.admission!({ error })).toBe('not-admitted');
  expect(f.provider.completionLifecycle!.settlement({ error })).toBe('settled');
  const revoked = f.provider.complete(messages).catch((error) => error);
  f.close();
  finish('done');
  expect(await revoked).toBeInstanceOf(Error);
  await expect(first).rejects.toThrow('failed');
  expect(f.transport.launches).toHaveLength(1);
});

test(
  'prewrite rechecks the original logical preflight and old release cannot touch another call',
  async () => {
    const f = fixture(
      recordedClaudeTransport({ status: ['subscribed', 'subscribed'], decision: ['prewrite'] }),
      30_000,
      true,
    );
    const result = await f.provider.complete(decisionMessages());
    expect(result.content).toMatch(DECIDED);
    const original = result.native!;
    let checks = 0;
    await expect(
      f.provider.complete(decisionMessages(), {
        threadId: 'T:aux:review:G:domain:docs',
        nativeObservation: {
          owner,
          preflight() {
            if (++checks > 1) throw Error('revoked while preparing');
          },
          register() {},
          observe() {},
        },
      }),
    ).rejects.toThrow('failed');
    expect(f.transport.writes).toBe(1);
    expect(
      await f.provider.completionLifecycle!.releaseOwnedAdmission!(
        original.owner!,
        original.admissionId!,
      ),
    ).toBe('released');
    f.close();
  },
  LIVE_TIMEOUT,
);

test('tool and model overrides fail before any subprocess', async () => {
  const f = fixture();
  for (const options of [{ tools: true }, { model: 'other' }, { maxTurns: 2 }])
    await expect(f.provider.complete(messages, options)).rejects.toThrow('refused');
  expect(f.transport.launches).toHaveLength(0);
  expect(f.snapshot().attempts).toBe(0);
  f.close();
});

test('actual factory advice, guard and learning use the subscription lifecycle and retain private thread knowledge', async () => {
  const f = fixture(
    subscriptionTransport({
      // Each Warden phase answers in its own strict protocol; the other roles share one routing answer.
      response: (input) =>
        input.includes('## Response protocol (post-work review)')
          ? JSON.stringify({ knowledge: 'Accepted private thread knowledge', facts: [] })
          : input.includes('## Response protocol (advice phase')
            ? JSON.stringify({ layers: ['docs'], snippets: [], confidence: 1 })
            : input.includes('## Response protocol (guard phase')
              ? 'NO_COMMENT'
              : JSON.stringify({
                  category: 'feature',
                  destination: 'worker',
                  contextSlice: ['docs'],
                  layers: ['docs'],
                  domains: ['docs'],
                  confidence: 1,
                }),
    }),
  );
  const c = starterConfig('central', 'worker-model');
  c.agents = {
    worker: {
      id: 'worker',
      kind: 'executor',
      provider: 'central',
      model: 'worker-model',
      prompt: '',
      enabled: true,
    },
    [WARDEN]: {
      id: WARDEN,
      kind: 'warden',
      flowRole: 'warden',
      domain: 'docs',
      provider: f.provider.id,
      model: 'test-model',
      tools: false,
      prompt: 'Assess the supplied documentation',
      domainKnowledge: ['docs-source'],
      enabled: true,
      guardTriggers: ['Write'],
    },
  };
  c.layers = {
    docs: {
      id: 'docs',
      domain: 'docs',
      prompt: 'Domain rules',
      segment: 'domain-knowledge',
      writers: [WARDEN],
      sourceIds: ['docs-source'],
      enabled: true,
      staleness: 0,
    },
  };
  c.sources = {
    'docs-source': {
      id: 'docs-source',
      label: 'Docs',
      type: 'inline',
      uri: 'Keep unrelated files intact',
      enabled: true,
    },
  };
  c.projects = {
    P: { id: 'P', path: f.config.directory },
    Q: { id: 'Q', path: f.config.directory },
  };
  const sourceResolver: SourceResolver = (id, cfg) => ({
    id,
    load: async () => cfg.sources[id].uri,
  });
  const central: LLMProvider = {
    id: 'central',
    async complete() {
      return { content: 'Completed controlled work', model: 'worker-model' };
    },
  };
  const providers = new Map([
    [central.id, central],
    [f.provider.id, f.provider],
  ]);
  const stack = new ContextStack(buildLayers(c, { sourceResolver }));
  const events = new EventStream(),
    journal = new LocalSessionStore(join(f.config.directory, 'journal.sqlite'));
  const manager = new ThreadRuntimeManager({
    config: c,
    llm: f.provider,
    providers,
    eventStream: events,
    log() {},
    warn() {},
    learning: { timeoutMs: 1000, hardTimeoutMs: 3000 },
  });
  new KnowledgePersistence(manager, journal, events, []);
  const deps = { provider: central, providers };
  const factory = new ThreadFactory({
    stack,
    agents: buildAgents(c, stack, deps),
    runtime: manager,
    configuration: { config: c, layers: { sourceResolver }, agents: deps },
  });
  try {
    const thread = factory.create('A', { projectId: 'P' }),
      runtime = manager.get('A')!;
    await thread.dispatch('worker', 'Update documentation', undefined, { messageId: 'A1' });
    await runtime.learningSettled();
    const lib = runtime.wardens.get('docs')!;
    expect(lib.threadKnowledge.content).toBe('Accepted private thread knowledge');
    expect(journal.knowledge('A')!.domains.docs.content).toBe(lib.threadKnowledge.content);
    expect(runtime.learningState.domains.docs.capacity).toBe('settled');
    expect(
      (await lib.guard(oneCall({ tool: 'Write', input: { file: 'docs.md' }, output: 'updated' })))
        .outcome.status,
    ).toBe('answered');
    factory.create('B', { projectId: 'Q' });
    expect(manager.get('B')!.wardens.get('docs')!.threadKnowledge.content).toBe('');
    expect(f.transport.launches.length).toBeGreaterThanOrEqual(3);
    expect(
      f.transport.launches.every((p) => p.exited && p.argv.includes('--strict-mcp-config')),
    ).toBe(true);
  } finally {
    manager.disposeAll();
    journal.close();
    f.close();
  }
});

test('a stalled preflight expires before status or native spawn', async () => {
  const f = fixture();
  const error = await f.provider
    .complete(messages, {
      timeout: 100,
      nativeObservation: {
        owner,
        preflight: () => new Promise(() => {}),
        register() {},
        observe() {},
      },
    })
    .catch((error) => error);
  expect(error).toBeInstanceOf(Error);
  // Refused before any run: the call reads as not sent, not as a failed decision.
  expect(refusedUnsent(error)).toEqual({
    cause: 'not-admitted',
    reason: 'Subscription preflight deadline',
  });
  expect(f.provider.completionLifecycle!.admission!({ error })).toBe('not-admitted');
  expect(f.provider.completionLifecycle!.settlement({ error })).toBe('settled');
  expect(f.transport.launches).toHaveLength(0);
  expect(f.snapshot().attempts).toBe(0);
  f.close();
});

test('closing during preflight refuses the call as not sent', async () => {
  const f = fixture();
  let release!: () => void;
  const preflighting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const pending = f.provider
    .complete(messages, {
      nativeObservation: {
        owner,
        preflight: () => {
          entered = true;
          return preflighting;
        },
        register() {},
        observe() {},
      },
    })
    .catch((error) => error);
  await until(() => entered);
  f.close();
  release();
  const error = await pending;
  expect(refusedUnsent(error)).toEqual({
    cause: 'not-admitted',
    reason: 'Subscription decision expired or revoked',
  });
  expect(f.transport.launches).toHaveLength(0);
  expect(f.snapshot().attempts).toBe(0);
});

test('total attempt bounds reject without paid fallback or extra launches', async () => {
  let finish!: (answer: string) => void;
  const transport = subscriptionTransport({
    response: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const original = fixture(transport);
  original.close();
  const f = buildSubscriptionDecisions({ ...original.config, maxQueued: 1, maxCalls: 1 }, (cfg) =>
    buildNativeTextProvider(cfg, transport),
  );
  const first = f.provider.complete(messages);
  await until(() => transport.writes === 1);
  const full = await f.provider.complete(messages).catch((error) => error);
  expect(refusedUnsent(full)?.cause).toBe('not-admitted');
  expect(full.message).toContain('closed or full');
  finish('done');
  await first;
  await expect(f.provider.complete(messages)).rejects.toThrow('closed or full');
  expect(transport.launches).toHaveLength(1);
  f.close();
});

test(
  'a stalled final observer cannot retain scheduler capacity',
  async () => {
    const f = recorded(['observer-1', 'observer-2']);
    await f.provider.complete(decisionMessages(), {
      nativeObservation: { owner, register() {}, observe: () => new Promise(() => {}) },
    });
    await f.provider.complete(decisionMessages());
    expect(f.transport.launches).toHaveLength(2);
    expect(f.snapshot()).toMatchObject({ active: false, queued: 0 });
    f.close();
  },
  LIVE_TIMEOUT,
);

test('queue bound rejects excess waiting calls before native admission', async () => {
  let finish!: (answer: string) => void;
  const transport = subscriptionTransport({
    response: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const original = fixture(transport);
  original.close();
  const f = buildSubscriptionDecisions({ ...original.config, maxQueued: 1 }, (cfg) =>
    buildNativeTextProvider(cfg, transport),
  );
  const first = f.provider.complete(messages);
  await until(() => transport.writes === 1);
  const queued = f.provider.complete(messages).catch((error) => error);
  const overflow = await f.provider.complete(messages).catch((error) => error);
  expect(refusedUnsent(overflow)).toEqual({
    cause: 'not-admitted',
    reason: 'Subscription decision queue full',
  });
  expect(f.snapshot().queued).toBe(1);
  f.close();
  finish('done');
  // Waiting when admission closed: refused unsent, not failed.
  expect(refusedUnsent(await queued)?.cause).toBe('not-admitted');
  await expect(first).rejects.toThrow('failed');
  expect(transport.launches).toHaveLength(1);
});

test('unproved native process exit closes admission and retains unknown ownership', async () => {
  const original = fixture(subscriptionTransport({ response: () => new Promise(() => {}) }), 250);
  original.close();
  let terminate!: () => void;
  const transport = {
    ...original.transport,
    spawn: (...args: Parameters<typeof original.transport.spawn>) => {
      const child = original.transport.spawn(...args);
      terminate = child.kill;
      return { ...child, kill() {} };
    },
  };
  const f = buildSubscriptionDecisions(original.config, (cfg) =>
    buildNativeTextProvider(cfg, transport),
  );
  let registered: NativeEvidence | undefined;
  try {
    const error = await f.provider
      .complete(messages, {
        nativeObservation: {
          owner,
          register(e) {
            registered = e;
          },
          observe() {},
        },
      })
      .catch((error) => error);
    expect(f.provider.completionLifecycle!.settlement({ error })).toBe('unknown');
    expect(f.snapshot().closed).toBe(true);
    const inspection = await f.provider.completionLifecycle!.inspectOwnedAdmission!(
      registered!.owner!,
      registered!.admissionId!,
    );
    expect(inspection).toMatchObject({ capacity: 'unknown', cleanup: 'unknown' });
    expect(inspection?.evidence.content).toBeUndefined();
    await expect(f.provider.complete(messages)).rejects.toThrow('closed or full');
    expect(original.transport.launches).toHaveLength(1);
  } finally {
    terminate?.();
    f.close();
  }
}, 5000);

test('a dispatched decision out of time fails as a timeout, not a provider error', async () => {
  const f = fixture(subscriptionTransport({ response: () => new Promise(() => {}) }), 250);
  try {
    const error = await f.provider.complete(messages).catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(refusedUnsent(error)).toBeUndefined();
    expect(decisionFailedCause(error)).toBe('timeout');
    expect(f.transport.launches).toHaveLength(1);
  } finally {
    f.close();
  }
}, 5000);

test('decisions served in a project host take no shared decision slot', async () => {
  const gates: Array<() => void> = [];
  const runs: string[] = [];
  const createRun = (_config: NativeTextConfig) => {
    const calls: Array<Record<string, unknown>> = [];
    let closed = false;
    return {
      provider: {
        id: 'fake',
        async complete(
          _messages: unknown,
          opts: {
            nativeObservation?: {
              owner: { providerSessionKey?: string };
              register(e: NativeEvidence): Promise<void>;
              observe(e: NativeEvidence): Promise<void>;
            };
          } = {},
        ) {
          const key = opts.nativeObservation!.owner.providerSessionKey!;
          runs.push(key);
          const admission: NativeEvidence = {
            schema: 1,
            owner: opts.nativeObservation!.owner as NativeEvidence['owner'],
            admissionId: Bun.randomUUIDv7(),
            nativeOutcome: 'unknown',
            localOutcome: 'pending',
            dispatch: 'not-dispatched',
          };
          await opts.nativeObservation!.register(admission);
          await new Promise<void>((resolve) => gates.push(resolve));
          const native = {
            ...admission,
            nativeOutcome: 'completed' as const,
            localOutcome: 'resolved' as const,
            dispatch: 'attempted' as const,
          };
          calls.push({ valid: true, release: 'released', transport: 'primed', settled: true });
          return { content: 'ok', model: 'm', native };
        },
      },
      snapshot: () => ({ closed, calls: calls as never }),
      close: () => {
        closed = true;
      },
    };
  };
  const decisions = buildSubscriptionDecisions(
    {
      source: {
        id: 's',
        runtime: 'claude',
        mode: 'native-profile',
        profileDirectory: '/x',
      } as never,
      directory: '/tmp',
      model: 'm',
      maxCalls: 100,
      maxQueued: 100,
      callTimeoutMs: 20_000,
      maxConcurrent: 1,
      unbounded: (key) => key.includes(':aux:domain:'),
    },
    createRun as never,
  );
  const ask = (key: string) =>
    decisions.provider.complete([{ role: 'user', content: 'x' }], { threadId: key });
  const warden1 = ask('t1:aux:domain:a');
  const warden2 = ask('t1:aux:domain:b');
  const router1 = ask('t1:aux:router');
  const router2 = ask('t1:aux:router2');
  await until(() => runs.length === 3);
  // Both Wardens and one router run at once; the second router waits for the one shared slot.
  expect(runs.sort()).toEqual(['t1:aux:domain:a', 't1:aux:domain:b', 't1:aux:router']);
  for (const release of gates.splice(0)) release();
  await Promise.all([warden1, warden2, router1]);
  await until(() => runs.length === 4);
  for (const release of gates.splice(0)) release();
  await router2;
  decisions.close();
});

test('a Warden its project host holds no warm spare for is a capacity refusal: skipped, admission stays open', async () => {
  const createRun = (_config: NativeTextConfig) => {
    const calls: Array<Record<string, unknown>> = [];
    return {
      provider: {
        id: 'fake',
        async complete() {
          calls.push({ transport: 'primed', settled: true, failure: 'not-held', valid: false });
          throw Error('Project Warden host starting');
        },
      },
      snapshot: () => ({ closed: false, calls: calls as never }),
      close: () => {},
    };
  };
  const decisions = buildSubscriptionDecisions(
    {
      source: {
        id: 's',
        runtime: 'claude',
        mode: 'native-profile',
        profileDirectory: '/x',
      } as never,
      directory: '/tmp',
      model: 'm',
      maxCalls: 100,
      maxQueued: 100,
      callTimeoutMs: 20_000,
      maxConcurrent: 1,
      unbounded: (key) => key.includes(':aux:domain:'),
    },
    createRun as never,
  );
  const ask = () =>
    decisions.provider.complete([{ role: 'user', content: 'x' }], { threadId: 't1:aux:domain:a' });
  const error = await ask().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as { notSentCause?: string }).notSentCause).toBe('not-held');
  expect((error as Error).message).toBe(NOT_HELD_REFUSAL);
  // The refusal left nothing owned: admission stays open, so the next call is admitted (and refused
  // for capacity again), not shut out as closed.
  const again = await ask().catch((e: unknown) => e);
  expect((again as { notSentCause?: string }).notSentCause).toBe('not-held');
  decisions.close();
});

test('a Warden whose host does not serve is refused before it is queued, at guard priority too: a full slot never makes it wait', async () => {
  const runs: string[] = [];
  const gates: Array<() => void> = [];
  const createRun = (_config: NativeTextConfig) => ({
    provider: {
      id: 'fake',
      async complete(
        _messages: unknown,
        opts: { nativeObservation?: { owner: { providerSessionKey?: string } } } = {},
      ) {
        runs.push(opts.nativeObservation!.owner.providerSessionKey!);
        await new Promise<void>((resolve) => gates.push(resolve));
        throw Error('released');
      },
    },
    snapshot: () => ({ closed: false, calls: [] as never }),
    close: () => {},
  });
  const decisions = buildSubscriptionDecisions(
    {
      source: {
        id: 's',
        runtime: 'claude',
        mode: 'native-profile',
        profileDirectory: '/x',
      } as never,
      directory: '/tmp',
      model: 'm',
      maxCalls: 100,
      maxQueued: 100,
      callTimeoutMs: 20_000,
      maxConcurrent: 1,
      // The lane holding later stages is down; first stages serve.
      unserved: (key) => key.includes(':stage:'),
    },
    createRun as never,
  );
  // The one shared slot is taken.
  const busy = decisions.provider
    .complete([{ role: 'user', content: 'x' }], { threadId: 't1:aux:router' })
    .catch(() => undefined);
  await until(() => runs.length === 1);
  const at = Date.now();
  const error = await decisions.provider
    .complete([{ role: 'user', content: 'x' }], {
      threadId: 't1:aux:domain:a:stage:1',
      priority: DECISION_PRIORITY.guard,
    })
    .catch((e: unknown) => e);
  expect(Date.now() - at).toBeLessThan(1_000);
  expect(refusedUnsent(error)).toEqual({ cause: 'not-held', reason: NOT_HELD_REFUSAL });
  expect(runs).toEqual(['t1:aux:router']);
  for (const release of gates.splice(0)) release();
  await busy;
  decisions.close();
});
