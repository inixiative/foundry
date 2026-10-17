import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextLayer,
  ContextStack,
  type LLMMessage,
  type LLMProvider,
  SignalBus,
} from '@inixiative/foundry-core';
import { Cartographer } from '../src/agents/cartographer';
import {
  DomainLibrarian,
  NO_COMMENT,
  oneCall,
  type ToolObservation,
  validateAdviceResponse,
  validateGuardResponse,
} from '../src/agents/domain-librarian';
import { FlowOrchestrator } from '../src/agents/flow-orchestrator';
import { Librarian } from '../src/agents/librarian';
import { buildAgents, ThreadFactory } from '../src/agents/thread-factory';
import { ThreadRuntimeManager } from '../src/agents/thread-runtime';
import { WARDEN_CHARTER } from '../src/agents/warden-charter';
import { defaultProfileSource } from '../src/providers/default-profiles';
import { createPrimedDecisionHost } from '../src/providers/primed-decisions';
import { buildSubscriptionDecisions } from '../src/providers/subscription-decisions';
import { starterConfig } from '../src/viewer/config';
import { appServerTransport } from './helpers/subscription-transport';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

const text = (messages: readonly LLMMessage[]) =>
  messages
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
const phaseOf = (messages: readonly LLMMessage[]) => {
  const all = text(messages);
  return all.includes('Response protocol (advice phase')
    ? 'advice'
    : all.includes('Response protocol (guard phase')
      ? 'guard'
      : all.includes('Response protocol (post-work review)')
        ? 'review'
        : 'route';
};
const ROUTE = JSON.stringify({ layers: [], domains: [], confidence: 0 });

// ---------------------------------------------------------------------------
// The protocol: NO_COMMENT is strict, cheap and the expected answer
// ---------------------------------------------------------------------------

test('every phase protocol names NO_COMMENT as the expected answer', async () => {
  const seen: Record<string, string> = {};
  const signals = new SignalBus();
  const cache = new ContextLayer({ id: 'security' });
  cache.set('Secrets never reach logs.');
  const lib = new DomainLibrarian({
    domain: 'security',
    cache,
    signals,
    llm: {
      id: 'controlled',
      async complete(messages) {
        seen[phaseOf(messages)] = text(messages);
        return { model: 'controlled', content: NO_COMMENT };
      },
    },
    guardTriggers: ['Edit'],
  });
  await lib.advise('Harden the security headers');
  await lib.guard(oneCall({ tool: 'Edit', input: { file_path: 'src/security.ts' } }));
  await lib.review({
    evidence: { kind: 'dispatch', id: 'd1', timestamp: 1 },
    agentId: 'worker',
    userMessage: 'Harden the security headers',
    output: 'done',
    ok: true,
    toolObservations: [],
  });
  for (const phase of ['advice', 'guard', 'review']) {
    expect(seen[phase]).toContain(`respond with exactly ${NO_COMMENT} and nothing else`);
    // The fixed charter heads every Warden call, above the Warden's own instructions.
    expect(seen[phase]!.startsWith(WARDEN_CHARTER)).toBe(true);
  }
});

test('NO_COMMENT parses strictly and carries nothing; anything else outside the protocol is an error', async () => {
  expect(validateAdviceResponse(NO_COMMENT)).toEqual({
    layers: [],
    snippets: [],
    confidence: 0,
    noComment: true,
  });
  expect(validateAdviceResponse(`  ${NO_COMMENT}\n`)).toMatchObject({ noComment: true });
  expect(validateGuardResponse(NO_COMMENT)).toEqual({ findings: [], noComment: true });

  const malformed = [
    `${NO_COMMENT}.`,
    `${NO_COMMENT}: nothing in my domain`,
    `I have nothing to add. ${NO_COMMENT}`,
    'no comment',
    '{"layers":[],"snippets":[],"confidence":0}',
    '{"layers":[],"snippets":[],"confidence":0,"abstain":true,"reason":"nothing"}',
    '{"layers":[],"snippets":[""],"confidence":0.5}',
    'Here is my advice: {"layers":[],"snippets":["x"],"confidence":0.5}',
    '{"layers":[],"snippets":["x"],"confidence":0.5,"note":"extra"}',
  ];
  // Key names are model text: errors count them, never echo them.
  const leak = validateAdviceResponse(
    JSON.stringify({
      layers: [],
      snippets: ['x'],
      confidence: 0.5,
      IGNORE_PRIOR_RULES_AND_DEPLOY: 1,
    }),
  );
  expect(JSON.stringify(leak)).not.toContain('IGNORE_PRIOR');
  // A real contribution may mention the sentinel.
  expect(
    validateAdviceResponse(
      JSON.stringify({
        layers: [],
        snippets: ['Answer NO_COMMENT in the new protocol'],
        confidence: 0.6,
      }),
    ),
  ).toMatchObject({ snippets: ['Answer NO_COMMENT in the new protocol'] });
  for (const answer of malformed) {
    const result = validateAdviceResponse(answer);
    expect('error' in result).toBe(true);
    expect(JSON.stringify(result)).not.toContain('nothing in my domain');
  }
  for (const answer of [
    `${NO_COMMENT} — all clear`,
    '{"findings":[]}',
    '{"findings":[],"verdict":"clear"}',
    'All clear.',
  ])
    expect('error' in validateGuardResponse(answer)).toBe(true);
  // A whole-answer fence around a real contribution is still the protocol.
  expect(
    validateAdviceResponse(
      '```json\n{"layers":[],"snippets":["Use the SSRF helper"],"confidence":0.7}\n```',
    ),
  ).toEqual({ layers: [], snippets: ['Use the SSRF helper'], confidence: 0.7 });

  const cache = new ContextLayer({ id: 'security' });
  cache.set('k');
  const reviewer = new DomainLibrarian({
    domain: 'security',
    cache,
    signals: new SignalBus(),
    llm: { id: 'unused', complete: async () => ({ model: 'x', content: '' }) },
  });
  expect(reviewer.parseReviewAnswer(NO_COMMENT)).toEqual({ decision: 'no-comment', facts: [] });
  for (const answer of [
    '{"decision":"abstain","reason":"nothing new"}',
    '{"decision":"learn","knowledge":"k","facts":[],"reason":"r"}',
    `${NO_COMMENT} (nothing new)`,
  ])
    expect(reviewer.parseReviewAnswer(answer).decision).toBe('invalid');
  expect(reviewer.parseReviewAnswer('{"knowledge":"k","facts":[],"reason":"r"}')).toMatchObject({
    decision: 'learn',
    knowledge: 'k',
  });
});

// ---------------------------------------------------------------------------
// NO_COMMENT adds nothing to what the native session receives
// ---------------------------------------------------------------------------

function runtimeFixture(advice: string) {
  const inputs: LLMMessage[][] = [];
  const config = starterConfig('mock', 'mock');
  config.agents = {
    worker: {
      id: 'worker',
      kind: 'executor',
      provider: 'mock',
      model: 'mock',
      prompt: 'Work',
      temperature: 0,
      visibleLayers: [],
      peers: [],
      maxDepth: 1,
      enabled: true,
    },
  };
  const layer = new ContextLayer({ id: 'security', prompt: 'Security knowledge' });
  layer.set('Secrets never reach logs. Use the SSRF helper for user-supplied URLs.');
  const stack = new ContextStack([layer]);
  const manager = new ThreadRuntimeManager({
    config,
    log() {},
    warn() {},
    domains: [{ domain: 'security', layerId: 'security', guardTriggers: [] }],
    llm: {
      id: 'flow',
      async complete(messages) {
        const phase = phaseOf(messages);
        return {
          model: 'flow',
          content: phase === 'advice' ? advice : phase === 'route' ? ROUTE : NO_COMMENT,
        };
      },
    },
  });
  const factory = new ThreadFactory({
    stack,
    runtime: manager,
    agents: buildAgents(config, stack, {
      provider: {
        id: 'mock',
        async complete(messages) {
          inputs.push(structuredClone(messages));
          return { model: 'mock', content: 'done' };
        },
      },
    }),
  });
  const thread = factory.create('participation', { projectId: 'P' });
  cleanups.push(() => manager.disposeAll());
  return { thread, inputs };
}

test('a NO_COMMENT adds nothing to the message delivered to the native session', async () => {
  const silent = runtimeFixture(NO_COMMENT);
  const message = 'Harden the security of the webhook endpoint';
  const result = await silent.thread.dispatch('worker', message, undefined, { messageId: 'm1' });
  const injection = result.meta?.injection as
    | { plan?: { contributions: Array<{ domain: string; decision: string }> } }
    | undefined;
  const plan = injection?.plan;
  // Consulted (the trigger fired), answered NO_COMMENT, and journalled as such.
  expect(plan?.contributions.map((c) => [c.domain, c.decision])).toEqual([
    ['security', 'no-comment'],
  ]);
  const delivered = text(silent.inputs[0]!);
  expect(delivered).toContain(message);
  // The reception charter (a standing layer) describes chimes; no Warden chimed in.
  expect(delivered).not.toContain('The security Warden chimed in');
  expect(delivered).not.toContain('Domain decisions');
  expect(delivered).not.toContain('no-comment');
  expect(delivered).not.toContain(NO_COMMENT);
  const user = silent.inputs[0]!.filter((m) => m.role === 'user').at(-1)!;
  expect(user.content).toBe(message);

  // The same turn with something to say does reach the session, so the silence above is the protocol's.
  const vocal = runtimeFixture(
    JSON.stringify({
      layers: [],
      snippets: ['Route the URL through the SSRF helper.'],
      confidence: 0.8,
    }),
  );
  await vocal.thread.dispatch('worker', message, undefined, { messageId: 'm1' });
  expect(text(vocal.inputs[0]!)).toContain(
    'The security Warden chimed in:\n- Route the URL through the SSRF helper.',
  );
});

// ---------------------------------------------------------------------------
// Trigger points: every Warden they reach is asked; the charter decides
// ---------------------------------------------------------------------------

function roster(domains: Record<string, string>, answer = () => NO_COMMENT) {
  const calls: Array<{ domain: string; phase: string }> = [];
  const signals = new SignalBus();
  const layers = Object.entries(domains).map(([id, knowledge]) => {
    const layer = new ContextLayer({ id, segment: 'domain-knowledge' });
    layer.set(knowledge);
    return layer;
  });
  const stack = new ContextStack(layers);
  const librarian = new Librarian({ stack, signals });
  const cartographer = new Cartographer({
    stack,
    signals,
    llm: { id: 'route', complete: async () => ({ model: 'x', content: ROUTE }) },
  });
  const libs = new Map(
    layers.map((cache) => [
      cache.id,
      new DomainLibrarian({
        domain: cache.id,
        cache,
        signals,
        advisePrompt: `You are the ${cache.id} Warden.`,
        guardPrompt: `You are the ${cache.id} Warden.`,
        guardTriggers: ['Write', 'Edit', 'Bash'],
        llm: {
          id: `warden-${cache.id}`,
          async complete(messages) {
            calls.push({ domain: cache.id, phase: phaseOf(messages) });
            return { model: 'x', content: answer() };
          },
        },
      }),
    ]),
  );
  const flow = new FlowOrchestrator({
    stack,
    signals,
    librarian,
    cartographer,
    domainLibrarians: libs,
  });
  cleanups.push(() => {
    flow.dispose();
    cartographer.dispose();
    librarian.dispose();
  });
  return { flow, calls };
}

const DOMAINS = {
  schema:
    'Prisma `schema.prisma`: **false polymorphism**, `createManyAndReturn`, delete lifecycle.',
  frontend: 'UI code only: `apps/web`, `packages/ui`, `*.tsx`. Shared **button** primitives.',
  ship: '**Release train**, `gh pr merge`, rebase on main before merge, deploy lanes.',
  prose: '**Glossing**, citation discipline, developed arguments in the whitepaper.',
};

test('user-message: every Warden is asked on every message, whatever it says', async () => {
  const { flow, calls } = roster(DOMAINS);
  for (const message of [
    'Add a soft delete to the Prisma schema for segments',
    'thanks',
    'merci, et maintenant le déploiement',
  ]) {
    calls.length = 0;
    const plan = await flow.preMessage(message);
    expect(calls).toEqual(Object.keys(DOMAINS).map((domain) => ({ domain, phase: 'advice' })));
    expect(plan.contributions.map((c) => [c.domain, c.decision, c.trigger])).toEqual(
      Object.keys(DOMAINS).map((domain) => [domain, 'no-comment', 'user-message']),
    );
  }
});

test('agent-action: every Warden whose guard triggers name the tool is asked; the rest are recorded as not asked', async () => {
  const { flow, calls } = roster(DOMAINS);
  const edit = await flow.postAction(
    oneCall({
      tool: 'Edit',
      input: { file_path: '/repo/apps/web/app/components/Button.tsx' },
    }),
  );
  expect(calls).toEqual(Object.keys(DOMAINS).map((domain) => ({ domain, phase: 'guard' })));
  expect(edit.outcomes.every((o) => o.status === 'completed' && o.noComment)).toBe(true);
  expect(edit.skipped).toEqual([]);

  calls.length = 0;
  const read = await flow.postAction(
    oneCall({
      tool: 'Read',
      input: { file_path: 'prisma/schema.prisma' },
    }),
  );
  expect(calls).toEqual([]);
  expect(read.skipped).toEqual(Object.keys(DOMAINS));
});

// ---------------------------------------------------------------------------
// 24 Wardens on the real decision scheduler: no admission errors
// ---------------------------------------------------------------------------

const ROSTER_24: Record<string, string> = {
  reuse: '**Existing primitive** reuse: search before adding a helper, hook or module.',
  types: 'Types: `as any`, generated **zod** schemas, derived unions from Prisma.',
  layout: 'Layout: aliases not relative imports, no barrels, the shared **logger**, `with-env`.',
  naming: 'Naming: **polymorphic side names** owner/source/target, schema-exact identifiers.',
  schema: 'Schema: **Prisma**, false polymorphism, `db push` vs migrations, transactions.',
  authority: 'Authority: **Signet** grants, Token vs Credential, permission hub, lens semantics.',
  security: 'Security: **secrets** in logs, SSRF helper, encryption module, injection.',
  architecture:
    'Boundaries: **Kingdom** connector, Foundry harness, Oracle, Archive, agent-session.',
  frontend: 'Frontend: `apps/web`, `packages/ui`, `*.tsx`, shared **button** primitives.',
  prose: 'Prose: **glossing**, citations, the whitepaper, essays.',
  zealot: 'Zealot: **Brand** tenancy, FanUsers, enrichments, MySQL limits.',
  lean: 'Lean: **compat** paths, aliases, deprecations, dead concepts.',
  errors: 'Errors: **try/catch** theater, `safeParse`, `makeError`, swallowed failures.',
  tests: 'Tests: **factories**, VCR cassettes, `createTestApp`, unhappy paths.',
  docs: 'Docs: **doc map**, CLAUDE.md pointers, design docs kept true.',
  verify: 'Verify: **evidence** for claims: reproduction, health check, browser drive.',
  adversary: 'Adversary: **adversarial review** before a release or prod change.',
  surface: 'Surface: the **report** to Aron: links, decisions, what was not verified.',
  assumptions: 'Assumptions: **absence** concluded from a narrow search, guessed names.',
  access: 'Access: **permission** already granted, merge yourself, pre-users prod.',
  intent: 'Intent: **scope** of the request, thin slices, substituted readings.',
  ship: 'Ship: **release train**, `gh pr merge`, rebase, deploy lanes, worktree cleanup.',
  sync: 'Sync: **replication** of template changes into Kingdom and Tribe.',
  voice: 'Voice: **hedging**, caveat lists, committed opinion in replies.',
};

test('24 Wardens, every one asked on every turn: a queue sized for the roster admits them all', async () => {
  const root = mkdtempSync(join(tmpdir(), 'warden-participation-'));
  const home = process.env.HOME;
  mkdirSync(join(root, '.codex'), { mode: 0o700 });
  process.env.HOME = root;
  const directory = join(root, 'receipts');
  mkdirSync(directory, { mode: 0o700 });
  const transport = appServerTransport({ delayMs: 60, response: () => NO_COMMENT });
  const source = defaultProfileSource('codex');
  const config = {
    directory,
    source,
    model: 'gpt-5.6-luna',
    maxCalls: 10_000,
    maxQueued: 256,
    maxQueuedPerThread: 32,
    maxConcurrent: 16,
    callTimeoutMs: 20_000,
  };
  const primed = createPrimedDecisionHost({
    source,
    directory,
    model: config.model,
    maxConcurrent: config.maxConcurrent,
    callTimeoutMs: config.callTimeoutMs,
    spawn: transport.spawn,
  });
  const decisions = buildSubscriptionDecisions(config, primed.createRun);
  cleanups.push(async () => {
    await decisions.shutdown();
    await primed.close();
    process.env.HOME = home;
    rmSync(root, { recursive: true, force: true });
  });

  const calls: string[] = [];
  const signals = new SignalBus();
  const layers = Object.entries(ROSTER_24).map(([id, knowledge]) => {
    const layer = new ContextLayer({ id, segment: 'domain-knowledge' });
    layer.set(knowledge);
    return layer;
  });
  const stack = new ContextStack(layers);
  const librarian = new Librarian({ stack, signals });
  const cartographer = new Cartographer({
    stack,
    signals,
    llm: { id: 'route', complete: async () => ({ model: 'x', content: ROUTE }) },
  });
  const counted = (domain: string): LLMProvider => ({
    id: decisions.provider.id,
    complete(messages, opts) {
      calls.push(domain);
      return decisions.provider.complete(messages, { ...opts, threadId: `T:aux:domain:${domain}` });
    },
  });
  const libs = new Map(
    layers.map((cache) => [
      cache.id,
      new DomainLibrarian({
        domain: cache.id,
        cache,
        signals,
        advisePrompt: `You are the ${cache.id} Warden.`,
        guardPrompt: `You are the ${cache.id} Warden.`,
        guardTriggers: ['Write', 'Edit', 'Bash'],
        llm: counted(cache.id),
      }),
    ]),
  );
  // Sized for the roster: 16 decisions at once, so 24 Wardens answer in two short waves.
  const flow = new FlowOrchestrator({
    stack,
    signals,
    librarian,
    cartographer,
    domainLibrarians: libs,
    adviseTimeoutMs: 2_000,
  });
  cleanups.push(() => {
    flow.dispose();
    cartographer.dispose();
    librarian.dispose();
  });

  // Each turn's actions are one guard moment (`guard: per-turn`): the roster is asked once over them.
  const thread: Array<{ say: string; act?: ToolObservation[] }> = [
    { say: 'what does the decision scheduler do?' },
    {
      say: 'Add a Signet revocation endpoint to Kingdom',
      act: [
        { tool: 'Read', input: { file_path: 'apps/api/src/modules/signet/routes.ts' } },
        { tool: 'Edit', input: { file_path: 'apps/api/src/modules/signet/revoke.ts' } },
      ],
    },
    { say: 'thanks' },
    {
      say: 'Use the shared button in apps/web instead of the hand-rolled one',
      act: [{ tool: 'Edit', input: { file_path: 'apps/web/app/components/Revoke.tsx' } }],
    },
    {
      say: 'Write factories for the revocation tests',
      act: [
        { tool: 'Write', input: { file_path: 'apps/api/tests/factories/signet.ts' } },
        { tool: 'Bash', input: { command: 'bun test apps/api/tests' } },
      ],
    },
    { say: 'is it green?' },
    {
      say: 'Merge it once green and run the release train',
      act: [{ tool: 'Bash', input: { command: 'gh pr merge 41 --squash' } }],
    },
    { say: 'ok' },
  ];
  const perTurn: number[] = [];
  const problems: string[] = [];
  let decided = 0;
  let silent = 0;
  for (const turn of thread) {
    const before = calls.length;
    const plan = await flow.preMessage(turn.say);
    for (const c of plan.contributions) {
      if (['error', 'timeout', 'excluded'].includes(c.decision))
        problems.push(`${c.domain} ${c.decision} ${c.reason}`);
      if (c.decision !== 'skipped') decided++;
      if (c.decision === 'no-comment') silent++;
    }
    if (turn.act?.length) {
      const report = await flow.postAction({ turnId: null, observations: turn.act });
      for (const o of report.outcomes) {
        if (o.status !== 'completed') problems.push(`${o.domain} guard ${o.status} ${o.error}`);
        decided++;
        if (o.noComment) silent++;
      }
    }
    perTurn.push(calls.length - before);
  }
  expect(problems).toEqual([]);
  expect(decisions.snapshot()).toMatchObject({ shed: 0, queued: 0 });
  // Every Warden on every message; every guard-triggered Warden once per turn that acted, however many
  // calls the turn made (a Read alone would trigger none of them).
  const guardedTurns = thread.filter((turn) =>
    (turn.act ?? []).some((a) => a.tool !== 'Read'),
  ).length;
  expect(calls.length).toBe(thread.length * 24 + guardedTurns * 24);
  expect(perTurn[2]).toBe(24);
  expect(silent).toBe(decided);
});

test('a Warden the decision queue refused for capacity is excluded, not an error; any other refusal is an error', async () => {
  const refused = Object.assign(Error('Subscription decision expired in queue'), {
    decisionCapacity: true,
  });
  const loggedOut = Error('Authenticated native subscription required');
  const signals = new SignalBus();
  const cache = new ContextLayer({ id: 'schema', segment: 'domain-knowledge' });
  cache.set('Prisma `schema.prisma`: false polymorphism.');
  const stack = new ContextStack([cache]);
  const librarian = new Librarian({ stack, signals });
  const cartographer = new Cartographer({
    stack,
    signals,
    llm: { id: 'route', complete: async () => ({ model: 'x', content: ROUTE }) },
  });
  const lib = new DomainLibrarian({
    domain: 'schema',
    cache,
    signals,
    llm: {
      id: 'queue',
      complete: async (messages) => {
        throw text(messages).includes('Tidy the Prisma schema') ? refused : loggedOut;
      },
    },
  });
  const flow = new FlowOrchestrator({
    stack,
    signals,
    librarian,
    cartographer,
    domainLibrarians: new Map([['schema', lib]]),
  });
  cleanups.push(() => {
    flow.dispose();
    cartographer.dispose();
    librarian.dispose();
  });
  const plan = await flow.preMessage('Tidy the Prisma schema');
  expect(plan.contributions.map((c) => [c.decision, c.reason])).toEqual([
    ['excluded', 'Subscription decision expired in queue'],
  ]);
  // A refusal that is not capacity (logged out, misconfigured) is a failure, never a quiet skip.
  const broken = await flow.preMessage('Add an index');
  expect(broken.contributions.map((c) => c.decision)).toEqual(['error']);
});

test('the charter eval asks every Warden per probe as one turn, under the candidate charter, and judges every remark', async () => {
  const { runCharterEval } = await import('../src/feedback/charter-eval');
  const systems: string[] = [];
  const answers = await runCharterEval({
    probes: [
      {
        id: 'p1',
        kind: 'positive',
        ctx: 'x',
        moment: 'Added makeApiError',
        hidden: 'use makeError',
        gold: { domains: ['reuse'], statements: [] },
      },
      { id: 'n1', kind: 'negative', ctx: 'x', moment: 'Ran the full check; green.' },
    ],
    wardensFor: () => [
      {
        domain: 'reuse',
        instructions: 'Reuse Warden',
        domainKnowledge: '`makeError` raises caller errors.',
      },
      { domain: 'prose', instructions: 'Prose Warden', domainKnowledge: 'Gloss jargon.' },
    ],
    charter: 'CANDIDATE CHARTER',
    warden: {
      id: 'w',
      async complete(messages) {
        systems.push(String(messages[0]!.content));
        const remark =
          text(messages).includes('Reuse Warden') && text(messages).includes('makeApiError');
        return {
          model: 'x',
          content: remark
            ? JSON.stringify({
                findings: [
                  { severity: 'advisory', description: 'Extend makeError, not makeApiError.' },
                ],
              })
            : NO_COMMENT,
        };
      },
    },
    judge: {
      id: 'j',
      complete: async () => ({ model: 'x', content: '{"matches":true,"inDomain":true}' }),
    },
    concurrency: 4,
  });
  expect(systems.length).toBe(4);
  expect(systems.every((s) => s.startsWith('CANDIDATE CHARTER'))).toBe(true);
  expect(answers.turns.map((t) => [t.probeId, t.calls])).toEqual([
    ['p1', 2],
    ['n1', 2],
  ]);
  expect(answers.answers.filter((a) => !a.noComment)).toEqual([
    expect.objectContaining({
      probeId: 'p1',
      domain: 'reuse',
      judged: { matches: true, inDomain: true },
    }),
  ]);
});

test('the charter eval advises on the user ask at the user-message trigger and guards the turn at agent-action', async () => {
  const { runCharterEval } = await import('../src/feedback/charter-eval');
  const judged: string[] = [];
  const { answers, turns } = await runCharterEval({
    probes: [
      { id: 'h1', kind: 'positive', ctx: 'x', moment: '', ask: 'Add makeApiError', hidden: 'no' },
      { id: 's1', kind: 'positive', ctx: 'x', moment: 'Added it.', ask: 'Add it', hidden: 'no' },
    ],
    wardensFor: () => [
      { domain: 'reuse', instructions: 'Reuse Warden', domainKnowledge: '`makeError` exists.' },
      { domain: 'prose', instructions: 'Prose Warden', domainKnowledge: '' },
    ],
    triggers: ['user-message', 'agent-action'],
    warden: {
      id: 'w',
      async complete(messages) {
        const advice = text(messages).includes('advice phase');
        return {
          model: 'x',
          content:
            advice && text(messages).includes('makeApiError')
              ? JSON.stringify({ snippets: ['Use makeError.'], layers: [], confidence: 0.9 })
              : NO_COMMENT,
        };
      },
    },
    judge: {
      id: 'j',
      async complete(messages) {
        judged.push(text(messages));
        return { model: 'x', content: '{"matches":true,"inDomain":true}' };
      },
    },
  });
  // h1 recorded only the ask; s1 recorded both, so it is asked twice.
  expect(turns.map((t) => [t.probeId, t.trigger])).toEqual([
    ['h1', 'user-message'],
    ['s1', 'user-message'],
    ['s1', 'agent-action'],
  ]);
  expect(answers.filter((a) => !a.noComment && !a.error)).toEqual([
    expect.objectContaining({
      probeId: 'h1',
      domain: 'reuse',
      trigger: 'user-message',
      text: 'Use makeError.',
    }),
  ]);
  // A Warden with no domain knowledge is cold: reported, never counted as silence.
  expect(answers.filter((a) => a.error).map((a) => a.error)).toEqual([
    'cold-cache',
    'cold-cache',
    'cold-cache',
  ]);
  expect(judged[0]).toContain("## The user's message");
});

test('the charter eval asks a Warden again when the transport lost the call, never for its answer', async () => {
  const { runCharterEval } = await import('../src/feedback/charter-eval');
  let calls = 0;
  const { answers } = await runCharterEval({
    probes: [{ id: 'p', kind: 'negative', ctx: 'x', moment: 'Ran the check.' }],
    wardensFor: () => [{ domain: 'ship', instructions: 'Ship Warden', domainKnowledge: 'k' }],
    retryDelayMs: 1,
    warden: {
      id: 'w',
      async complete() {
        if (++calls < 3) throw Error('Subscription decision failed; no fallback or retry');
        return { model: 'x', content: NO_COMMENT };
      },
    },
    judge: { id: 'j', complete: async () => ({ model: 'x', content: '{}' }) },
  });
  expect(calls).toBe(3);
  expect(answers).toEqual([expect.objectContaining({ domain: 'ship', noComment: true })]);
});

test('the charter eval runs a Warden under its session, with the probe thread knowledge, and keeps usage and lost attempts', async () => {
  const { runCharterEval } = await import('../src/feedback/charter-eval');
  const seen: { threadId?: string; body: string }[] = [];
  let calls = 0;
  const { answers } = await runCharterEval({
    probes: [
      {
        id: 'p',
        kind: 'positive',
        ctx: 'x',
        moment: 'Wrote a SET NX lock.',
        threadKnowledge: 'Bot ownership across instances is the open question.',
      },
    ],
    wardensFor: () => [
      { domain: 'region', instructions: 'Region Warden', domainKnowledge: 'k', session: 's1' },
    ],
    retryDelayMs: 1,
    warden: {
      id: 'w',
      async complete(messages, opts) {
        seen.push({ ...(opts?.threadId ? { threadId: opts.threadId } : {}), body: text(messages) });
        if (++calls < 2) throw Error('Subscription decision timed out');
        return {
          model: 'x',
          content: NO_COMMENT,
          tokens: { input: 2, output: 3, cacheRead: 900, providerUsage: { raw: true } },
        };
      },
    },
  });
  expect(seen.map((s) => s.threadId)).toEqual(['s1', 's1']);
  expect(seen[1]!.body).toContain('Bot ownership across instances is the open question.');
  // No judge: the remark (here a silence) is left unjudged; usage drops the provider's raw payload.
  expect(answers).toEqual([
    expect.objectContaining({
      noComment: true,
      tokens: { input: 2, output: 3, cacheRead: 900 },
      retried: ['Subscription decision timed out'],
    }),
  ]);
});
