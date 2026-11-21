// Foundry's native protocol surfaces, recorded from the real CLIs and services on the
// developer's machine. `bun run test` replays them; `bun run test:live` runs every scenario
// live, re-records it, then replays the fresh cassette in-process and requires the same
// conclusion. Each replay also compares against the conclusion live reached when recorded.
import { afterAll, afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionQueue, type StandingPart, standingPart } from '@inixiative/foundry-core';
import { classifyCorrection, lintStatement } from '../src/feedback/sharpen';
import {
  CLAUDE_HARNESS_INSTRUCTIONS_OFF,
  CODEX_HARNESS_INSTRUCTIONS_OFF,
} from '../src/prompts/instruction-stack';
import { defaultProfileSource } from '../src/providers/default-profiles';
import { boundLaunchEnvironment } from '../src/providers/native-text-environment';
import { buildNativeTextProvider, subscriptionStatus } from '../src/providers/native-text-provider';
import {
  ClaudeCodeSessionAdapter,
  CodexSessionAdapter,
  InMemoryExternalSessionStore,
  MuseSessionAdapter,
} from '../src/providers/session-adapter';
import { SessionBackedProvider } from '../src/providers/session-backed';
import { SubscriptionAuthentication } from '../src/providers/subscription-authentication';
import { ThreadLaunchSettings } from '../src/providers/thread-launch';
import { createToolGate } from '../src/turns/tool-gate';
import { ProcessCassettes, type VCR, vcrMode, webSocketCassettes } from '../src/vcr';
import {
  ANSWER,
  answerPrompt,
  claudeVcr,
  codexVcr,
  DECIDED,
  decisionMessages,
  kingdomVcr,
  LIVE,
  museVcr,
  recordedClaudeTransport,
  recordedCodexStatus,
  recordedMuseConnect,
  recordedMuseStatus,
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
    id: Bun.randomUUIDv7(),
    integrationId: Bun.randomUUIDv7(),
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
          runId: Bun.randomUUIDv7(),
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
          runId: Bun.randomUUIDv7(),
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
const KNOWN_ANSWERS = [CODEWORD, 'violet-anchor-7', 'NONE'];
const answerNamed = (text: string) =>
  KNOWN_ANSWERS.find((answer) => text.includes(answer)) ?? text.trim();
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
          return answerNamed(result.content);
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
          answers: [first, second, third].map((r) => answerNamed(r.content)),
          sessions: [first, second, third].map((r) => r.delivery!.session),
          sent: [first, second, third].map((r) => r.delivery!.sent.map((part) => part.id)),
          systemPrompt: worker.launches[0]!.argv.some((arg) =>
            arg.startsWith('--append-system-prompt'),
          ),
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
      const prompts: (string | undefined)[] = [];
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
        // agent-session removes a launch's system prompt file when that session ends: read it while it runs.
        const latest = worker.launches.length - 1;
        prompts[latest] ??= systemPrompt(latest);
        const report = result.delivery!;
        const next = report.session === 'started' ? {} : { ...held };
        for (const p of [...(report.session === 'started' ? report.base : []), ...report.sent])
          next[p.id] = p.hash;
        held = next;
        return result;
      };
      const systemPrompt = (n: number) => {
        const argv = worker.launches[n]!.argv;
        const at = argv.findIndex((arg) => arg.startsWith('--append-system-prompt'));
        return argv[at] === '--append-system-prompt'
          ? argv[at + 1]
          : readFileSync(argv[at + 1]!, 'utf8');
      };
      try {
        const first = await ask('standing', learning('NONE'));
        const second = await ask('learned', learning('violet-anchor-7'));
        launch.update('main', { permissionMode: 'acceptEdits' });
        const relaunched = await ask('learned', learning('violet-anchor-7'));
        launch.update('main', { permissionMode: 'default' });
        const again = await ask('standing', learning('violet-anchor-7'));
        return {
          answers: [first, second, relaunched, again].map((r) => answerNamed(r.content)),
          sessions: [first, second, relaunched, again].map((r) => r.delivery!.session),
          sent: [first, second, relaunched, again].map((r) =>
            r.delivery!.sent.map((part) => part.id),
          ),
          launches: worker.launches.length,
          resumes: worker.launches.map((l) => l.argv.includes('--resume')),
          stateInSystemPrompt: [0, 1, 2].some((n) => prompts[n]?.includes('Thread state')),
          relaunchPromptsIdentical: prompts[1] !== undefined && prompts[1] === prompts[2],
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
          return answerNamed(result.content);
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

test(
  "muse worker session: two turns on one `muse serve` host, on the user's own Muse login, with Meta's API key ignored",
  async () => {
    const vcr = museVcr();
    const out = await scenario(vcr, 'worker', async () => {
      const directory = root(),
        cwd = join(directory, 'project');
      mkdirSync(cwd);
      // The login is the user's own (~/.config/muse); a live run's child gets the account's HOME back.
      // Sessions go to a fresh data home: the recording's command ids are a counter, and `muse serve`
      // remembers ids across runs in its session store, so a shared one refuses a re-record.
      const home = process.env.HOME,
        key = process.env.META_API_KEY,
        data = process.env.XDG_DATA_HOME,
        config = process.env.XDG_CONFIG_HOME;
      process.env.HOME = directory;
      // A CI runner sets XDG_CONFIG_HOME, which Muse's login location follows; point it at the composed home too.
      process.env.XDG_CONFIG_HOME = join(directory, '.config');
      process.env.META_API_KEY = 'meta-model-api-key';
      process.env.XDG_DATA_HOME = join(directory, 'muse-data');
      mkdirSync(join(directory, '.config', 'muse'), { recursive: true, mode: 0o700 });
      const status = recordedMuseStatus(['subscribed'], vcr);
      const host = recordedMuseConnect(['two-turns'], vcr);
      const adapter = new MuseSessionAdapter({
        store: new InMemoryExternalSessionStore(),
        authentication: new SubscriptionAuthentication(
          join(directory, 'runtime-profiles'),
          defaultProfileSource('muse'),
          status.statusSpawn,
        ),
        defaults: { model: LIVE.museModel, effort: 'low' },
        environment: boundLaunchEnvironment,
        connect: host.connect,
      });
      const provider = new SessionBackedProvider({
        id: 'muse',
        adapter,
        defaultModel: LIVE.museModel,
        defaultCwd: cwd,
      });
      try {
        const first = await provider.complete(
          [{ role: 'user', content: answerPrompt('first turn') }],
          { threadId: 'muse-worker', cwd },
        );
        const second = await provider.complete(
          [{ role: 'user', content: answerPrompt('second turn') }],
          { threadId: 'muse-worker', cwd },
        );
        const launch = host.launches[0];
        return {
          turns: [first.content.trim(), second.content.trim()],
          launches: host.launches.length,
          argv: launch?.argv.slice(1),
          statusChecks: status.statusChecks,
          meteredKeyPassed: launch?.env.META_API_KEY !== undefined,
          noAutoUpdate: launch?.env.MUSE_NO_AUTO_UPDATE,
          // agent-session 0.8.0 names the Muse session (nativeSessionId) only on the turn that opened
          // it; the binding (externalSessionId) is on every turn.
          sameSession:
            !!first.native?.externalSessionId &&
            first.native.externalSessionId === second.native?.externalSessionId,
        };
      } finally {
        await adapter.releaseAll();
        process.env.HOME = home;
        if (key === undefined) delete process.env.META_API_KEY;
        else process.env.META_API_KEY = key;
        if (data === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = data;
        if (config === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = config;
      }
    });
    expect(out).toEqual({
      turns: [ANSWER, ANSWER],
      launches: 1,
      argv: ['serve', '--trust-workspace', '--disable-sandbox'],
      statusChecks: 1,
      meteredKeyPassed: false,
      noAutoUpdate: '1',
      sameSession: true,
    });
  },
  LIVE_TIMEOUT,
);
