// Foundry's native protocol surfaces, recorded from the real CLIs and services on the
// developer's machine. `bun run test` replays them; `bun run test:live` runs every scenario
// live, re-records it, then replays the fresh cassette in-process and requires the same
// conclusion. Each replay also compares against the conclusion live reached when recorded.
import { afterAll, afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexPrimedSessions } from '@inixiative/agent-session';
import {
  ActionQueue,
  ContextLayer,
  ContextStack,
  SignalBus,
  type StandingPart,
  standingPart,
  Thread,
} from '@inixiative/foundry-core';
import { DomainLibrarian } from '../src/agents/domain-librarian';
import { NAMING_INSTRUCTIONS, ThreadNamer } from '../src/agents/thread-namer';
import { classifyCorrection, lintStatement } from '../src/feedback/sharpen';
import {
  CLAUDE_HARNESS_INSTRUCTIONS_OFF,
  CODEX_HARNESS_INSTRUCTIONS_OFF,
  composeRoleView,
} from '../src/prompts/instruction-stack';
import { buildNativeTextProvider, subscriptionStatus } from '../src/providers/native-text-provider';
import { createPrimedDecisionHost, primedRequest } from '../src/providers/primed-decisions';
import {
  ClaudeCodeSessionAdapter,
  CodexSessionAdapter,
  InMemoryExternalSessionStore,
} from '../src/providers/session-adapter';
import { SessionBackedProvider } from '../src/providers/session-backed';
import { SubscriptionAuthentication } from '../src/providers/subscription-authentication';
import { buildSubscriptionDecisions } from '../src/providers/subscription-decisions';
import { ThreadLaunchSettings } from '../src/providers/thread-launch';
import { createToolGate } from '../src/turns/tool-gate';
import {
  httpCassettes,
  ProcessCassettes,
  type ProcessTranscript,
  type VCR,
  vcrMode,
  webSocketCassettes,
} from '../src/vcr';
import {
  ANSWER,
  answerPrompt,
  claudeVcr,
  codexVcr,
  DECIDED,
  decisionMessages,
  FIXTURES_DIR,
  kingdomVcr,
  LIVE,
  recordedAppServerTransport,
  recordedClaudeTransport,
  recordedCodexStatus,
  sameAsLive,
  settleRecordings,
} from './helpers/vcr';

const codexHost = (host: ReturnType<typeof createPrimedDecisionHost>['host']) => {
  if (!(host instanceof CodexPrimedSessions)) throw Error('Expected the Codex primed host');
  return host;
};

const recording = vcrMode() === 'record';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(settleRecordings);

function root() {
  const directory = mkdtempSync(join(tmpdir(), 'vcr-scenario-'));
  roots.push(directory);
  return directory;
}
function source(runtime: 'claude' | 'codex', directory: string) {
  const profileDirectory = join(directory, 'profile');
  mkdirSync(profileDirectory, { mode: 0o700 });
  return {
    id: crypto.randomUUID(),
    integrationId: crypto.randomUUID(),
    runtime,
    mode: 'native-profile' as const,
    profileDirectory,
  };
}

/** Runs a scenario, checks it against live's recorded conclusion, and on a live run replays it immediately. */
async function scenario<T>(vcr: VCR, name: string, run: () => Promise<T>): Promise<T> {
  const now = JSON.parse(JSON.stringify(await run())) as T;
  expect(now).toEqual((await sameAsLive(vcr, name, now)).live);
  if (recording) {
    await settleRecordings();
    process.env.FOUNDRY_VCR = 'replay';
    try {
      expect(JSON.parse(JSON.stringify(await run()))).toEqual(now);
    } finally {
      process.env.FOUNDRY_VCR = 'record';
    }
  }
  return now;
}

const messages = decisionMessages();
const LIVE_TIMEOUT = 90_000;

test(
  'claude auth status: the login is a claude.ai subscription, and the account never reaches the cassette',
  async () => {
    const vcr = claudeVcr();
    expect(
      await scenario(vcr, 'auth-status', async () => {
        const status = recordedClaudeTransport({ status: ['subscribed'] }, vcr);
        const started = Date.now();
        const subscribed = await subscriptionStatus(status.statusSpawn('unused'));
        return { subscribed, withinStatusDeadline: Date.now() - started < 20_000 };
      }),
    ).toEqual({ subscribed: true, withinStatusDeadline: true });
  },
  LIVE_TIMEOUT,
);

test(
  'claude text decision: one stream-json turn, text only, observed model acknowledged, process released',
  async () => {
    const vcr = claudeVcr();
    const out = await scenario(vcr, 'decision', async () => {
      const transport = recordedClaudeTransport(
        { status: ['subscribed'], decision: ['answer'] },
        vcr,
      );
      const directory = root();
      const run = buildNativeTextProvider(
        {
          directory,
          source: source('claude', directory),
          runId: crypto.randomUUID(),
          model: LIVE.claudeModel,
          expectedObservedModel: LIVE.claudeObservedModel,
          maxCalls: 1,
          callTimeoutMs: 30_000,
        },
        transport,
      );
      const result = await run.provider.complete(messages);
      const call = run.snapshot().calls[0]!;
      return {
        content: result.content,
        model: result.model,
        tokens: !!result.tokens?.output,
        native: {
          outcome: result.native?.nativeOutcome,
          observedModel: result.native?.configuration?.observedModel,
          terminal: result.native?.terminal?.type,
        },
        call: {
          valid: call.valid,
          release: call.release,
          processExit: call.processExit,
          statusProcessExit: call.statusProcessExit,
        },
      };
    });
    expect(out.content).toMatch(DECIDED);
    expect(out).toMatchObject({
      native: { outcome: 'completed', observedModel: LIVE.claudeObservedModel },
      call: {
        valid: true,
        release: 'released',
        processExit: 'exited',
        statusProcessExit: 'exited',
      },
    });
  },
  LIVE_TIMEOUT,
);

test(
  'claude feedback classify: the shared correction contract on Haiku yields a sharp, lint-clean rule',
  async () => {
    const vcr = claudeVcr();
    const out = await scenario(vcr, 'feedback-classify', async () => {
      const transport = recordedClaudeTransport(
        { status: ['subscribed'], decision: ['feedback-classify'] },
        vcr,
      );
      const directory = root();
      const run = buildNativeTextProvider(
        {
          directory,
          source: source('claude', directory),
          runId: crypto.randomUUID(),
          model: LIVE.claudeModel,
          expectedObservedModel: LIVE.claudeObservedModel,
          maxCalls: 1,
          callTimeoutMs: 30_000,
        },
        transport,
      );
      const classified = await classifyCorrection(run.provider, {
        text: "No, don't open a PR for me to merge. I told you already: on the agentic repos you merge it yourself once the full check is green.",
        before:
          'The change is ready and the check is green. Shall I open a PR for you to review and merge?',
        priority: 0,
      });
      return {
        isCorrection: classified?.isCorrection,
        sharp: classified?.sharp,
        rules: classified?.statements.length ?? 0,
        lintClean: (classified?.statements ?? []).every((statement) => lintStatement(statement).ok),
        aboutMerging: (classified?.statements ?? []).some((statement) => /merg/i.test(statement)),
      };
    });
    expect(out).toEqual({
      isCorrection: true,
      sharp: true,
      rules: expect.any(Number),
      lintClean: true,
      aboutMerging: true,
    });
    expect(out.rules).toBeGreaterThan(0);
  },
  LIVE_TIMEOUT,
);

/** A warden's advice call: role instructions, then its domain cache (the stable, primable prefix) and the message. */
const cache =
  '## Domain cache (settings)\n- Settings UI lives under src/settings; toggles are features, not bugs.\n';
const primedMessages = [
  decisionMessages()[0]!,
  { role: 'user' as const, content: `${cache}\n## Message\n${decisionMessages()[1]!.content}` },
];

test(
  'codex primed decisions: one warm app-server on the ChatGPT login; a role primed once, then forked per cycle',
  async () => {
    const vcr = codexVcr();
    const out = await scenario(vcr, 'primed', async () => {
      const transport = recordedAppServerTransport(['role'], vcr);
      const directory = root(),
        receipts = join(directory, 'receipts');
      mkdirSync(receipts, { mode: 0o700 });
      const decisionSource = source('codex', directory);
      const primed = createPrimedDecisionHost({
        source: decisionSource,
        directory: receipts,
        model: LIVE.codexModel,
        effort: 'low',
        maxConcurrent: 2,
        callTimeoutMs: 30_000,
        spawn: transport.spawn,
      });
      const decisions = buildSubscriptionDecisions(
        {
          directory: receipts,
          source: decisionSource,
          model: LIVE.codexModel,
          maxCalls: 4,
          maxQueued: 2,
          maxConcurrent: 2,
          callTimeoutMs: 30_000,
        },
        primed.createRun,
      );
      const opts = { threadId: 'decision-role-settings', stablePrefix: cache };
      try {
        // Prime explicitly so the recording's stdin order is fixed (no background priming racing a decision).
        await codexHost(primed.host).prime(primedRequest(primedMessages, opts, opts.threadId).spec);
        const first = await decisions.provider.complete(primedMessages, opts);
        const second = await decisions.provider.complete(primedMessages, opts);
        const stdin = transport.launches[0]!.stdin.split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
        const turns = stdin
          .filter((m) => m.method === 'turn/start')
          .map((m) => String((m.params!.input as Array<{ text: string }>)[0]!.text));
        return {
          contents: [first.content, second.content].map((c) => DECIDED.test(c)),
          launches: transport.launches.length,
          persistedThreads: stdin.filter(
            (m) => m.method === 'thread/start' && m.params!.ephemeral === false,
          ).length,
          forks: stdin.filter((m) => m.method === 'thread/fork').length,
          primerCarriedContext: turns[0]!.startsWith(cache),
          cyclesSentOnlyTheMessage: turns
            .slice(1)
            .every((t) => !t.includes('Domain cache') && t.includes('## Message')),
          receipts: readFileSync(primed.receiptsPath, 'utf8')
            .trim()
            .split('\n')
            .map((line) => {
              const r = JSON.parse(line);
              return { valid: r.valid, settled: r.settled, prime: r.prime };
            }),
        };
      } finally {
        await decisions.shutdown();
        await primed.close();
      }
    });
    expect(out).toEqual({
      contents: [true, true],
      launches: 1,
      persistedThreads: 1,
      forks: 2,
      primerCarriedContext: true,
      cyclesSentOnlyTheMessage: true,
      receipts: [
        { valid: true, settled: true, prime: 'warm' },
        { valid: true, settled: true, prime: 'warm' },
      ],
    });
  },
  LIVE_TIMEOUT,
);

test(
  'claude primed decisions: Haiku 5.5 on the subscription login; a role primed once, then forked per cycle',
  async () => {
    const vcr = claudeVcr();
    const out = await scenario(vcr, 'primed', async () => {
      // Primer, first fork, and the spare that serves the second decision. The spare started after it
      // races shutdown and has no cassette; its start fails and nothing is lost.
      const transport = recordedClaudeTransport(
        { status: ['subscribed'], decision: ['primed-primer', 'primed-fork', 'primed-spare-1'] },
        vcr,
      );
      const directory = root(),
        receipts = join(directory, 'receipts');
      mkdirSync(receipts, { mode: 0o700 });
      const decisionSource = source('claude', directory);
      const primed = createPrimedDecisionHost({
        source: decisionSource,
        directory: receipts,
        model: LIVE.claudeObservedModel,
        effort: 'low',
        maxConcurrent: 2,
        callTimeoutMs: 30_000,
        spawn: transport.spawn,
        statusSpawn: () => transport.statusSpawn('unused'),
      });
      const decisions = buildSubscriptionDecisions(
        {
          directory: receipts,
          source: decisionSource,
          model: LIVE.claudeObservedModel,
          maxCalls: 4,
          maxQueued: 2,
          maxConcurrent: 2,
          callTimeoutMs: 30_000,
        },
        primed.createRun,
      );
      const opts = { threadId: 'T:aux:cartographer', stablePrefix: cache };
      try {
        const first = await decisions.provider.complete(primedMessages, opts);
        const second = await decisions.provider.complete(primedMessages, opts);
        const used = transport.launches.filter((launch) => launch.stdin);
        const inputs = used.map((launch) =>
          launch.stdin
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const content = JSON.parse(line).message.content as string | { text?: string }[];
              return typeof content === 'string'
                ? content
                : content.map((block) => block.text ?? '').join('');
            }),
        );
        return {
          contents: [first.content, second.content].map((c) => DECIDED.test(c)),
          observedModel: second.native?.configuration?.observedModel,
          launches: used.length,
          statusChecks: transport.statusChecks,
          primerCarriedContext: inputs[0]![0]!.startsWith(cache),
          forks: used.filter((launch) => launch.argv.includes('--fork-session')).length,
          textOnly: used.every(
            (launch) =>
              launch.argv.includes('--strict-mcp-config') &&
              launch.argv.slice(-2).join('|') === '--setting-sources|',
          ),
          cyclesSentOnlyTheMessage: inputs
            .slice(1)
            .flat()
            .every((t) => !t.includes('Domain cache') && t.includes('## Message')),
          receipts: readFileSync(primed.receiptsPath, 'utf8')
            .trim()
            .split('\n')
            .map((line) => {
              const r = JSON.parse(line);
              return { valid: r.valid, settled: r.settled, prime: r.prime };
            }),
        };
      } finally {
        await decisions.shutdown();
        await primed.close();
      }
    });
    expect(out).toEqual({
      contents: [true, true],
      observedModel: LIVE.claudeObservedModel,
      launches: 3,
      statusChecks: 1,
      primerCarriedContext: true,
      forks: 2,
      textOnly: true,
      cyclesSentOnlyTheMessage: true,
      receipts: [
        { valid: true, settled: true, prime: 'cold' },
        { valid: true, settled: true, prime: 'warm' },
      ],
    });
  },
  LIVE_TIMEOUT,
);

test(
  'claude pre-started Wardens: each holds its thread section and receives only the moment, all at once',
  async () => {
    const vcr = claudeVcr();
    const out = await scenario(vcr, 'prestarted', async () => {
      const transport = recordedClaudeTransport(
        { status: ['subscribed'], decision: ['prestarted-side-1'] },
        vcr,
      );
      const directory = root(),
        receipts = join(directory, 'receipts');
      mkdirSync(receipts, { mode: 0o700 });
      const decisionSource = source('claude', directory);
      const primed = createPrimedDecisionHost({
        source: decisionSource,
        directory: receipts,
        model: LIVE.claudeObservedModel,
        effort: 'low',
        maxConcurrent: 4,
        callTimeoutMs: 30_000,
        spawn: transport.spawn,
        statusSpawn: () => transport.statusSpawn('unused'),
      });
      const decisions = buildSubscriptionDecisions(
        {
          directory: receipts,
          source: decisionSource,
          model: LIVE.claudeObservedModel,
          maxCalls: 4,
          maxQueued: 4,
          maxConcurrent: 4,
          callTimeoutMs: 30_000,
        },
        primed.createRun,
      );
      decisions.provider.prestart = primed.prestart;
      const wardens = ['settings', 'naming'].map((domain) => {
        const cache = new ContextLayer({ id: `${domain}-knowledge` });
        cache.set(
          domain === 'settings'
            ? '- Settings UI lives under src/settings.'
            : '- Kastle is a dead word: say Kingdom.',
        );
        const instructions = new ContextLayer({ id: `${domain}-instructions` });
        instructions.set(`You are the ${domain} Warden. Advise only on ${domain}.`);
        return new DomainLibrarian({
          domain,
          cache,
          instructions,
          signals: new SignalBus(),
          llm: {
            ...decisions.provider,
            complete: (m, o) =>
              decisions.provider.complete(m, { ...o, threadId: `T:aux:domain:${domain}` }),
            prestart: (m, o) => primed.prestart(m, { ...o, threadId: `T:aux:domain:${domain}` }),
          },
          llmOpts: { maxTokens: 512, temperature: 0 },
        });
      });
      try {
        for (const w of wardens) w.prestart();
        // Both are pre-started and holding their moment call before anything is asked.
        for (let waited = 0; waited < 30_000; waited += 50) {
          const stdin = transport.launches[0]?.stdin ?? '';
          if ((stdin.match(/"mcp_response"/g) ?? []).length >= 2) break; // tools/list and initialize answered
          await Bun.sleep(50);
        }
        await Bun.sleep(3_000);
        const advice = await Promise.all(
          wardens.map((w) =>
            w.advise(
              'Rename the Kastle settings toggle',
              'Thread state: building the settings page.',
            ),
          ),
        );
        const stdin = transport.launches[0]!.stdin.split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        const moments = stdin.flatMap(
          (m: {
            response?: {
              response?: { mcp_response?: { result?: { content?: { text?: string }[] } } };
            };
          }) => {
            const text = m.response?.response?.mcp_response?.result?.content?.[0]?.text;
            return text ? [text] : [];
          },
        );
        return {
          advised: advice.map((a) => a.error === undefined),
          sideSessions: transport.launches.filter((l) => l.agents).length,
          // A moment is the turn: the thread state (it moves with every action) and the message.
          momentsWereOnlyTheTurn:
            moments.length === 2 &&
            moments.every(
              (m) =>
                m.startsWith('\n## Thread state\nThread state: building the settings page.') &&
                m.includes('## Message') &&
                !m.includes('Domain cache'),
            ),
        };
      } finally {
        await decisions.shutdown();
        await primed.close();
      }
    });
    expect(out).toEqual({
      advised: [true, true],
      sideSessions: 1,
      momentsWereOnlyTheTurn: true,
    });
  },
  LIVE_TIMEOUT,
);

test(
  'claude composed Warden: the composition view is its subagent definition; each call is a fresh subagent given only the turn',
  async () => {
    const vcr = claudeVcr();
    const out = await scenario(vcr, 'composed', async () => {
      // A fixed path, so the composed text (which names its files) is the same on every replay.
      const base = join(tmpdir(), 'foundry-vcr-composition');
      rmSync(base, { recursive: true, force: true });
      // Not named "home": a cassette must never carry a path that looks like a home directory.
      const home = join(base, 'account'),
        org = join(base, 'org'),
        repo = join(org, 'repo');
      const put = (path: string, text: string) => {
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, text);
      };
      mkdirSync(join(repo, '.git'), { recursive: true });
      put(join(home, '.claude', 'CLAUDE.md'), 'Answer briefly.');
      put(join(org, 'CLAUDE.md'), '# Org\n\nSettings toggles are features, not bugs.');
      const roleFile = join(repo, '.foundry', 'roles', 'settings-warden', 'domainKnowledge.md');
      put(roleFile, '- Settings UI lives under src/settings.');
      const compose = () =>
        composeRoleView({
          cwd: repo,
          harness: 'claude',
          home,
          claudeConfigDir: join(home, '.claude'),
          codexHome: join(home, '.codex'),
          managedPath: join(base, 'managed', 'CLAUDE.md'),
          role: 'settings-warden',
          picks: { domainKnowledge: { general: ['org'] } },
        });
      const transport = recordedClaudeTransport(
        {
          status: ['subscribed'],
          // The thread's side session, then the one holding the changed composition.
          decision: ['composed-side-1', 'composed-side-2'],
        },
        vcr,
      );
      const directory = root(),
        receipts = join(directory, 'receipts');
      mkdirSync(receipts, { mode: 0o700 });
      const decisionSource = source('claude', directory);
      const primed = createPrimedDecisionHost({
        source: decisionSource,
        directory: receipts,
        model: LIVE.claudeObservedModel,
        effort: 'low',
        maxConcurrent: 2,
        callTimeoutMs: 30_000,
        spawn: transport.spawn,
        statusSpawn: () => transport.statusSpawn('unused'),
        // Fan-outs only: pre-started Wardens are recorded in their own scenario.
        prestart: false,
      });
      const decisions = buildSubscriptionDecisions(
        {
          directory: receipts,
          source: decisionSource,
          model: LIVE.claudeObservedModel,
          maxCalls: 6,
          maxQueued: 2,
          maxConcurrent: 2,
          callTimeoutMs: 30_000,
        },
        primed.createRun,
      );
      const instructions = new ContextLayer({ id: 'role:settings-warden:instructions' });
      const knowledge = new ContextLayer({ id: 'role:settings-warden:domainKnowledge' });
      const load = async () => {
        const view = await compose();
        instructions.set(
          `You are the settings Warden. Advise only on the settings area.\n\n${view.slots.instructions.text}`,
        );
        knowledge.set(view.slots.domainKnowledge.text);
      };
      const warden = new DomainLibrarian({
        domain: 'settings',
        cache: knowledge,
        instructions,
        role: 'settings-warden',
        signals: new SignalBus(),
        llm: decisions.provider,
        llmOpts: { threadId: 'T:aux:domain:settings', maxTokens: 512, temperature: 0 },
      });
      try {
        await load();
        const first = await warden.advise('Where do settings toggles live?');
        const second = await warden.advise('Is a disabled toggle a bug?');
        put(roleFile, '- Settings UI lives under src/settings; toggles persist per project.');
        await load();
        const third = await warden.advise('Do toggles persist?');
        const sides = transport.launches.filter((launch) => launch.agents);
        // What each subagent was given: the hook's rewritten Agent prompt, on the side session's stdin.
        const given = sides.flatMap((launch) =>
          launch.stdin
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .flatMap(
              (m: {
                response?: {
                  response?: { hookSpecificOutput?: { updatedInput?: { prompt?: string } } };
                };
              }) => {
                const prompt = m.response?.response?.hookSpecificOutput?.updatedInput?.prompt;
                return prompt ? [prompt] : [];
              },
            ),
        );
        return {
          advised: [first, second, third].map((advice) => advice.error === undefined),
          sideSessions: sides.length,
          definitionsCarriedComposition: sides.every(
            (launch) =>
              launch.agents!.includes('toggles are features') &&
              launch.agents!.includes('src/settings'),
          ),
          secondDefinitionChanged: sides[1]?.agents?.includes('persist per project') ?? false,
          subagentsGivenOnlyTheTurn:
            given.length === 3 &&
            given.every(
              (input) => !input.includes('toggles are features') && input.includes('## Message'),
            ),
          receipts: readFileSync(primed.receiptsPath, 'utf8')
            .trim()
            .split('\n')
            .map((line) => {
              const r = JSON.parse(line);
              return { valid: r.valid, settled: r.settled };
            }),
        };
      } finally {
        await decisions.shutdown();
        await primed.close();
        rmSync(base, { recursive: true, force: true });
      }
    });
    expect(out).toEqual({
      advised: [true, true, true],
      sideSessions: 2,
      definitionsCarriedComposition: true,
      secondDefinitionChanged: true,
      subagentsGivenOnlyTheTurn: true,
      receipts: [
        { valid: true, settled: true },
        { valid: true, settled: true },
        { valid: true, settled: true },
      ],
    });
  },
  LIVE_TIMEOUT,
);

// Replay-only: a live run checks its fresh recordings in the replay pass that follows.
test.skipIf(recording)(
  'codex primed decisions load no instruction source: the private home holds the login only',
  () => {
    const sources = (['launch', 'role'] as const).flatMap((name) => {
      const frames = (
        JSON.parse(readFileSync(join(FIXTURES_DIR, 'codex', `primed.${name}.json`), 'utf8')) as {
          body: ProcessTranscript;
        }
      ).body.frames;
      return frames.flatMap((frame) => {
        const result = JSON.parse(frame.data)?.result;
        return result?.thread ? [result.instructionSources] : [];
      });
    });
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((list) => Array.isArray(list) && list.length === 0)).toBe(true);
  },
);

test(
  "codex thread naming: a thread's agent name is decided on its own primed decision session, off the turn",
  async () => {
    const vcr = codexVcr();
    const out = await scenario(vcr, 'naming', async () => {
      const transport = recordedAppServerTransport(['naming'], vcr);
      const directory = root(),
        receipts = join(directory, 'receipts');
      mkdirSync(receipts, { mode: 0o700 });
      const decisionSource = source('codex', directory);
      const primed = createPrimedDecisionHost({
        source: decisionSource,
        directory: receipts,
        model: LIVE.codexModel,
        effort: 'low',
        maxConcurrent: 2,
        callTimeoutMs: 30_000,
        spawn: transport.spawn,
      });
      const decisions = buildSubscriptionDecisions(
        {
          directory: receipts,
          source: decisionSource,
          model: LIVE.codexModel,
          maxCalls: 2,
          maxQueued: 2,
          maxConcurrent: 2,
          callTimeoutMs: 30_000,
        },
        primed.createRun,
      );
      const thread = new Thread('T', new ContextStack(), { description: '' });
      try {
        const role = [
          { role: 'system' as const, content: NAMING_INSTRUCTIONS },
          { role: 'user' as const, content: 'prime' },
        ];
        await codexHost(primed.host).prime(primedRequest(role, {}, 'T:aux:naming').spec);
        const decided = new Promise<void>((resolve) => {
          new ThreadNamer({
            provider: {
              id: decisions.provider.id,
              complete: (messages, opts) =>
                decisions.provider.complete(messages, opts).finally(() => setTimeout(resolve, 0)),
            },
            changed: () => {},
          }).turnCompleted(thread, {
            user: 'Add a dark mode toggle to the settings page',
            agent:
              'Added a dark mode switch to src/settings/appearance.tsx and wired it to the theme store.',
          });
        });
        await decided;
        const title = thread.meta.agentName?.text ?? '';
        return {
          title,
          short: title.length > 0 && title.split(/\s+/).length <= 8,
          aboutTheWork: /dark|theme|mode/i.test(title),
          launches: transport.launches.length,
          receipts: readFileSync(primed.receiptsPath, 'utf8')
            .trim()
            .split('\n')
            .map((line) => {
              const r = JSON.parse(line);
              return { valid: r.valid, settled: r.settled };
            }),
        };
      } finally {
        await decisions.shutdown();
        await primed.close();
      }
    });
    expect(out).toMatchObject({
      short: true,
      aboutTheWork: true,
      launches: 1,
      receipts: [{ valid: true, settled: true }],
    });
  },
  LIVE_TIMEOUT,
);

test(
  'claude worker session: two turns on one persistent stream-json process behind the subscription status gate',
  async () => {
    const vcr = claudeVcr();
    const out = await scenario(vcr, 'worker', async () => {
      const transport = recordedClaudeTransport({ status: ['subscribed'], decision: [] }, vcr);
      vcr.queue('worker', 'two-turns');
      const worker = new ProcessCassettes(vcr, 'worker');
      const directory = root(),
        cwd = join(directory, 'project');
      mkdirSync(cwd);
      const auth = new SubscriptionAuthentication(
        directory,
        source('claude', directory),
        transport.statusSpawn,
      );
      const adapter = new ClaudeCodeSessionAdapter({
        authentication: auth,
        store: new InMemoryExternalSessionStore(),
        defaults: { spawn: worker.spawn },
      });
      const provider = new SessionBackedProvider({
        id: 'worker',
        adapter,
        defaultModel: LIVE.claudeModel,
        defaultCwd: cwd,
      });
      try {
        const first = await provider.complete(
          [{ role: 'user', content: answerPrompt('first turn') }],
          { threadId: 'worker', cwd },
        );
        const second = await provider.complete(
          [{ role: 'user', content: answerPrompt('second turn') }],
          { threadId: 'worker', cwd },
        );
        return {
          turns: [first.content, second.content],
          launches: worker.launches.length,
          writes: worker.writes,
          statusChecks: transport.statusChecks,
          sameSession:
            !!first.native?.nativeSessionId &&
            first.native.nativeSessionId === second.native?.nativeSessionId,
        };
      } finally {
        await adapter.releaseAll();
      }
    });
    expect(out).toEqual({
      turns: [ANSWER, ANSWER],
      launches: 1,
      writes: 2,
      statusChecks: 1,
      sameSession: true,
    });
  },
  LIVE_TIMEOUT,
);

test(
  "claude worker gate: a structural deny holds under full access, through the CLI's own permission channel",
  async () => {
    const vcr = claudeVcr();
    const out = await scenario(vcr, 'worker-gate', async () => {
      const transport = recordedClaudeTransport({ status: ['subscribed'], decision: [] }, vcr);
      vcr.queue('worker', 'gate');
      const worker = new ProcessCassettes(vcr, 'worker');
      const directory = root(),
        cwd = join(directory, 'project');
      mkdirSync(cwd);
      const auth = new SubscriptionAuthentication(
        directory,
        source('claude', directory),
        transport.statusSpawn,
      );
      const adapter = new ClaudeCodeSessionAdapter({
        authentication: auth,
        store: new InMemoryExternalSessionStore(),
        defaults: { spawn: worker.spawn },
      });
      const launch = new ThreadLaunchSettings();
      launch.update('gated', { permissionMode: 'bypassPermissions' });
      const rows: Array<{ phase: string; record: Record<string, unknown> }> = [];
      const gate = createToolGate({
        threadId: 'gated',
        rules: () => ({ capabilities: { 'exec:shell': 'deny' } }),
        mode: () => 'bypassPermissions',
        queue: new ActionQueue(),
        turnId: () => 'turn',
        journal: (_id, phase, _turnId, record) => rows.push({ phase, record }),
      });
      const provider = new SessionBackedProvider({
        id: 'worker',
        adapter,
        defaultModel: LIVE.claudeModel,
        defaultCwd: cwd,
        launch,
        toolGate: () => ({ gate, hasRules: () => true }),
      });
      try {
        const result = await provider.complete(
          [
            {
              role: 'user',
              content:
                'Use the Bash tool to run exactly `echo gate-probe > probe.txt`. If the tool is denied, do not retry it any other way; reply with exactly DENIED.',
            },
          ],
          { threadId: 'gated', cwd },
        );
        const outcomes = rows.filter((row) => row.phase === 'gate-outcome');
        return {
          denied: outcomes.some(
            (row) => row.record.decision === 'deny' && row.record.by === 'structure',
          ),
          bashRequested: rows.some(
            (row) => row.phase === 'gate-request' && row.record.toolName === 'Bash',
          ),
          fileWritten: existsSync(join(cwd, 'probe.txt')),
          answered: result.content.includes('DENIED'),
        };
      } finally {
        await adapter.releaseAll();
      }
    });
    expect(out).toEqual({ denied: true, bashRequested: true, fileWritten: false, answered: true });
  },
  LIVE_TIMEOUT,
);

/** A project instruction file only the harness's own loading could reveal to the session. */
const CODEWORD = 'tangerine-lighthouse-42';
const codewordPrompt = () =>
  'Do not use any tools. If your instructions or context state a project codeword, reply with exactly that codeword. Otherwise reply with exactly NONE.';

test(
  'instruction files: Claude Code loads a project CLAUDE.md itself, and the Foundry off switch stops it',
  async () => {
    const vcr = claudeVcr();
    const out = await scenario(vcr, 'instructions-off', async () => {
      vcr.queue('worker', 'instructions-native');
      vcr.queue('worker', 'instructions-off');
      const worker = new ProcessCassettes(vcr, 'worker');
      const cwd = join(root(), 'project');
      mkdirSync(cwd);
      writeFileSync(join(cwd, 'CLAUDE.md'), `The project codeword is ${CODEWORD}.\n`);
      const ask = async (env?: Record<string, string>) => {
        const adapter = new ClaudeCodeSessionAdapter({
          store: new InMemoryExternalSessionStore(),
          defaults: { spawn: worker.spawn, ...(env ? { env } : {}) },
        });
        const provider = new SessionBackedProvider({
          id: 'worker',
          adapter,
          defaultModel: LIVE.claudeModel,
          defaultCwd: cwd,
        });
        try {
          const result = await provider.complete([{ role: 'user', content: codewordPrompt() }], {
            threadId: 'main',
            cwd,
          });
          return result.content.trim();
        } finally {
          await adapter.releaseAll();
        }
      };
      return {
        native: await ask(),
        off: await ask({ ...CLAUDE_HARNESS_INSTRUCTIONS_OFF }),
        launches: worker.launches.length,
      };
    });
    expect(out).toEqual({ native: CODEWORD, off: 'NONE', launches: 2 });
  },
  LIVE_TIMEOUT,
);

test(
  'warm cache: Claude starts with the standing context as its system prompt, then receives only a changed layer',
  async () => {
    const vcr = claudeVcr();
    const out = await scenario(vcr, 'warm-cache', async () => {
      vcr.queue('worker', 'warm-cache');
      const worker = new ProcessCassettes(vcr, 'worker');
      const cwd = join(root(), 'project');
      mkdirSync(cwd);
      const adapter = new ClaudeCodeSessionAdapter({
        store: new InMemoryExternalSessionStore(),
        defaults: { spawn: worker.spawn, env: { ...CLAUDE_HARNESS_INSTRUCTIONS_OFF } },
      });
      const provider = new SessionBackedProvider({
        id: 'worker',
        adapter,
        defaultModel: LIVE.claudeModel,
        defaultCwd: cwd,
      });
      const standing = standingPart('instructions', `The standing codeword is ${CODEWORD}.`);
      const learning = (word: string) =>
        standingPart('learning', `The learned codeword is ${word}.`);
      const ask = (question: string, part: StandingPart, held: Record<string, string>) =>
        provider.complete(
          [
            { role: 'system', content: 'unused by a session provider given a delivery' },
            {
              role: 'user',
              content: `Do not use any tools. Reply with exactly the ${question} codeword and nothing else.`,
            },
          ],
          {
            threadId: 'main',
            cwd,
            delivery: { standing: [standing, part], turn: 'Per-turn routing note.', held },
          },
        );
      try {
        const first = await ask('standing', learning('NONE'), {});
        const held = Object.fromEntries(
          first.delivery!.base.map((part) => [part.id, part.hash] as const),
        );
        const second = await ask('learned', learning('violet-anchor-7'), held);
        held.learning = learning('violet-anchor-7').hash;
        const third = await ask('standing', learning('violet-anchor-7'), held);
        return {
          answers: [first, second, third].map((r) => r.content.trim()),
          sessions: [first, second, third].map((r) => r.delivery!.session),
          sent: [first, second, third].map((r) => r.delivery!.sent.map((part) => part.id)),
          systemPrompt: worker.launches[0]!.systemPrompt !== undefined,
          standingResent: worker.launches[0]!.stdin.includes('The standing codeword'),
          thirdReadsCache: (third.tokens?.cacheRead ?? 0) > 0,
          launches: worker.launches.length,
        };
      } finally {
        await adapter.releaseAll();
      }
    });
    expect(out).toEqual({
      answers: [CODEWORD, 'violet-anchor-7', CODEWORD],
      sessions: ['started', 'held', 'held'],
      sent: [[], ['learning'], []],
      systemPrompt: true,
      standingResent: false,
      thirdReadsCache: true,
      launches: 1,
    });
  },
  LIVE_TIMEOUT,
);

test(
  'warm cache: a relaunch honors the ledger, keeps a byte-identical system prompt, and per-turn state never joins it',
  async () => {
    const vcr = claudeVcr();
    const out = await scenario(vcr, 'warm-relaunch', async () => {
      for (const n of [1, 2, 3]) vcr.queue('worker', `warm-relaunch-${n}`);
      const worker = new ProcessCassettes(vcr, 'worker');
      const cwd = join(root(), 'project');
      mkdirSync(cwd);
      const adapter = new ClaudeCodeSessionAdapter({
        store: new InMemoryExternalSessionStore(),
        defaults: { spawn: worker.spawn, env: { ...CLAUDE_HARNESS_INSTRUCTIONS_OFF } },
      });
      const launch = new ThreadLaunchSettings();
      const provider = new SessionBackedProvider({
        id: 'worker',
        adapter,
        defaultModel: LIVE.claudeModel,
        defaultCwd: cwd,
        launch,
      });
      const standing = standingPart('instructions', `The standing codeword is ${CODEWORD}.`);
      const learning = (word: string) =>
        standingPart('learning', `The learned codeword is ${word}.`);
      let held: Record<string, string> = {};
      let turn = 0;
      const ask = async (question: string, part: StandingPart) => {
        turn++;
        const result = await provider.complete(
          [
            {
              role: 'user',
              content: `Do not use any tools. Reply with exactly the ${question} codeword and nothing else.`,
            },
          ],
          {
            threadId: 'main',
            cwd,
            // The thread state changes every turn: it rides with the turn, never in the system prompt.
            delivery: { standing: [standing, part], turn: `Thread state: message ${turn}.`, held },
          },
        );
        const report = result.delivery!;
        const next = report.session === 'started' ? {} : { ...held };
        for (const p of [...(report.session === 'started' ? report.base : []), ...report.sent])
          next[p.id] = p.hash;
        held = next;
        return result;
      };
      const systemPrompt = (n: number) => worker.launches[n]!.systemPrompt;
      try {
        const first = await ask('standing', learning('NONE'));
        const second = await ask('learned', learning('violet-anchor-7'));
        launch.update('main', { permissionMode: 'acceptEdits' });
        const relaunched = await ask('learned', learning('violet-anchor-7'));
        launch.update('main', { permissionMode: 'default' });
        const again = await ask('standing', learning('violet-anchor-7'));
        return {
          answers: [first, second, relaunched, again].map((r) => r.content.trim()),
          sessions: [first, second, relaunched, again].map((r) => r.delivery!.session),
          sent: [first, second, relaunched, again].map((r) =>
            r.delivery!.sent.map((part) => part.id),
          ),
          launches: worker.launches.length,
          resumes: worker.launches.map((l) => l.argv.includes('--resume')),
          stateInSystemPrompt: [0, 1, 2].some((n) => systemPrompt(n)?.includes('Thread state')),
          relaunchPromptsIdentical: systemPrompt(1) === systemPrompt(2),
          relaunchReadsCache: (again.tokens?.cacheRead ?? 0) > 0,
        };
      } finally {
        await adapter.releaseAll();
      }
    });
    expect(out).toEqual({
      answers: [CODEWORD, 'violet-anchor-7', 'violet-anchor-7', CODEWORD],
      sessions: ['started', 'held', 'started', 'started'],
      // The review's repro re-sent every part on a relaunch; the ledger proves nothing is missing.
      sent: [[], ['learning'], [], []],
      launches: 3,
      resumes: [false, true, true],
      stateInSystemPrompt: false,
      relaunchPromptsIdentical: true,
      relaunchReadsCache: true,
    });
  },
  LIVE_TIMEOUT,
);

test(
  'instruction files: Codex app-server loads a project AGENTS.md itself, and the Foundry off switch stops it',
  async () => {
    const vcr = codexVcr();
    const out = await scenario(vcr, 'instructions-off', async () => {
      vcr.queue('app-server', 'instructions-native');
      vcr.queue('app-server', 'instructions-off');
      const server = new ProcessCassettes(vcr, 'app-server', { model: LIVE.codexModel });
      const cwd = join(root(), 'project');
      mkdirSync(cwd);
      writeFileSync(join(cwd, 'AGENTS.md'), `The project codeword is ${CODEWORD}.\n`);
      const ask = async (appServerConfig?: Readonly<Record<string, unknown>>) => {
        const adapter = new CodexSessionAdapter({
          store: new InMemoryExternalSessionStore(),
          ...(appServerConfig ? { appServerConfig } : {}),
          defaults: { spawn: server.spawn, effort: 'low' },
        });
        const provider = new SessionBackedProvider({
          id: 'app-server',
          adapter,
          defaultModel: LIVE.codexModel,
          defaultCwd: cwd,
        });
        try {
          const result = await provider.complete([{ role: 'user', content: codewordPrompt() }], {
            threadId: 'main',
            cwd,
          });
          return result.content.trim();
        } finally {
          await adapter.releaseAll();
        }
      };
      return {
        native: await ask(),
        off: await ask(CODEX_HARNESS_INSTRUCTIONS_OFF),
        launches: server.launches.length,
      };
    });
    expect(out).toEqual({ native: CODEWORD, off: 'NONE', launches: 2 });
  },
  LIVE_TIMEOUT,
);

test(
  'codex app-server: JSON-RPC initialize, thread/start and one turn/start on the ChatGPT login',
  async () => {
    const vcr = codexVcr();
    const out = await scenario(vcr, 'app-server', async () => {
      const server = new ProcessCassettes(vcr.queue('app-server', 'turn'), 'app-server', {
        model: LIVE.codexModel,
      });
      const directory = root(),
        cwd = join(directory, 'project');
      mkdirSync(cwd);
      const adapter = new CodexSessionAdapter({
        store: new InMemoryExternalSessionStore(),
        defaults: { spawn: server.spawn },
      });
      const provider = new SessionBackedProvider({
        id: 'app-server',
        adapter,
        defaultModel: LIVE.codexModel,
        defaultCwd: cwd,
      });
      try {
        const result = await provider.complete([{ role: 'user', content: answerPrompt() }], {
          threadId: 'main',
          cwd,
        });
        return {
          content: result.content,
          outcome: result.native?.nativeOutcome,
          rpc: result.native?.rpcOutcome,
          terminal: result.native?.terminal?.type,
          observedModel: result.native?.configuration?.observedModel,
          launches: server.launches.length,
        };
      } finally {
        await adapter.releaseAll();
      }
    });
    expect(out).toEqual({
      content: ANSWER,
      outcome: 'completed',
      rpc: 'resolved',
      terminal: 'turn/completed',
      observedModel: LIVE.codexModel,
      launches: 1,
    });
  },
  LIVE_TIMEOUT,
);

test(
  'codex main thread: the subscription worker drives a shell tool and keeps one session across two turns',
  async () => {
    const vcr = codexVcr();
    const out = await scenario(vcr, 'main-thread', async () => {
      const status = recordedCodexStatus(['chatgpt'], vcr);
      vcr.queue('worker', 'main-thread');
      const worker = new ProcessCassettes(vcr, 'worker', { model: LIVE.codexModel });
      const directory = root(),
        cwd = join(directory, 'project');
      mkdirSync(cwd);
      writeFileSync(join(cwd, 'marker.txt'), 'foundry-tool-ok\n');
      const auth = new SubscriptionAuthentication(
        directory,
        source('codex', directory),
        status.statusSpawn,
      );
      const adapter = new CodexSessionAdapter({
        authentication: auth,
        store: new InMemoryExternalSessionStore(),
        defaults: { spawn: worker.spawn },
      });
      const provider = new SessionBackedProvider({
        id: 'codex',
        adapter,
        defaultModel: LIVE.codexModel,
        defaultCwd: cwd,
      });
      try {
        const tool = await provider.complete(
          [
            {
              role: 'user',
              content:
                'Run the shell command `cat marker.txt` in the working directory and reply with exactly its output and nothing else.',
            },
          ],
          { threadId: 'main', cwd },
        );
        const second = await provider.complete(
          [{ role: 'user', content: answerPrompt('second turn') }],
          { threadId: 'main', cwd },
        );
        const home = worker.launches[0]?.env.CODEX_HOME;
        return {
          turns: [tool.content.trim(), second.content.trim()],
          launches: worker.launches.length,
          statusChecks: status.statusChecks,
          privateHome: !!home && home.startsWith(directory),
          paidKeys: Object.keys(worker.launches[0]?.env ?? {}).filter((key) => /API_KEY/.test(key)),
          sameSession:
            !!tool.native?.nativeSessionId &&
            tool.native.nativeSessionId === second.native?.nativeSessionId,
        };
      } finally {
        await adapter.releaseAll();
      }
    });
    expect(out).toEqual({
      turns: ['foundry-tool-ok', ANSWER],
      launches: 1,
      statusChecks: 1,
      privateHome: true,
      paidKeys: [],
      sameSession: true,
    });
  },
  LIVE_TIMEOUT,
);

const kingdomUp =
  !recording ||
  (await fetch(`${LIVE.kingdomUrl}/health`, { signal: AbortSignal.timeout(2_000) }).then(
    (r) => r.ok,
    () => false,
  ));
if (!kingdomUp)
  console.warn(
    `VCR: Kingdom is not reachable at ${LIVE.kingdomUrl}; its cassettes were not refreshed`,
  );

test.skipIf(!kingdomUp)(
  'kingdom websocket: connect, ping and an anonymous authenticate',
  async () => {
    const vcr = kingdomVcr();
    expect(
      await scenario(vcr, 'socket', async () => {
        const socket = webSocketCassettes(
          vcr.queue('socket', 'anonymous'),
          'socket',
        )(`${LIVE.kingdomUrl.replace(/^http/, 'ws')}/`);
        const seen: Record<string, unknown>[] = [];
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('Kingdom socket did not answer')), 10_000);
          socket.onmessage = (event) => {
            const message = JSON.parse(String(event.data)) as Record<string, unknown>;
            seen.push(message);
            if (message.type === 'connected') socket.send(JSON.stringify({ action: 'ping' }));
            if (message.type === 'pong')
              socket.send(JSON.stringify({ action: 'authenticate', headers: {} }));
            if (message.type === 'identity') {
              clearTimeout(timer);
              socket.close(1000);
              resolve();
            }
          };
        });
        return seen.map((message) => ({
          type: message.type,
          ...(message.type === 'identity' ? { userId: message.userId } : {}),
          ...(message.type === 'connected' ? { connectionId: typeof message.connectionId } : {}),
        }));
      }),
    ).toEqual([
      { type: 'connected', connectionId: 'string' },
      { type: 'pong' },
      { type: 'identity', userId: null },
    ]);
  },
  LIVE_TIMEOUT,
);
