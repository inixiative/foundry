// Foundry's native protocol surfaces, recorded from the real CLIs and services on the
// developer's machine. `bun run test` replays them; `bun run test:live` runs every scenario
// live, re-records it, then replays the fresh cassette in-process and requires the same
// conclusion. Each replay also compares against the conclusion live reached when recorded.
import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextStack, Thread } from '@inixiative/foundry-core';
import { NAMING_INSTRUCTIONS, ThreadNamer } from '../src/agents/thread-namer';
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
    connectionId: crypto.randomUUID(),
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
      const opts = { threadId: 'T:aux:domain:settings', stablePrefix: cache };
      try {
        // Prime explicitly so the recording's stdin order is fixed (no background priming racing a decision).
        await primed.host.prime(primedRequest(primedMessages, opts, opts.threadId).spec);
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
        await primed.host.prime(primedRequest(role, {}, 'T:aux:naming').spec);
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
        engine: 'app-server',
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
        engine: 'app-server',
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
