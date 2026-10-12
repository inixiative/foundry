import { afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultProfileSource } from '../src/providers/default-profiles';
import { createPrimedDecisionHost } from '../src/providers/primed-decisions';
import { SubscriptionAuthentication } from '../src/providers/subscription-authentication';
import {
  buildSubscriptionDecisions,
  type SubscriptionDecisionConfig,
} from '../src/providers/subscription-decisions';
import { subscriptionStatusProcess } from './helpers/subscription-transport';

const roots: string[] = [];
const home = process.env.HOME;
afterEach(() => {
  process.env.HOME = home;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A temporary HOME holding the user's own Claude login. */
function userHome() {
  const root = mkdtempSync(join(tmpdir(), 'primed-claude-'));
  roots.push(root);
  mkdirSync(join(root, '.claude'), { mode: 0o755 });
  writeFileSync(join(root, '.claude', '.credentials.json'), '{}', { mode: 0o600 });
  process.env.HOME = root;
  return root;
}

/** Controlled `claude --print` stream-json processes: one per primer, branch or spare. */
function claudeTransport(options: { model?: string } = {}) {
  const launches: {
    argv: string[];
    env: Record<string, string | undefined>;
    inputs: string[];
    exited: boolean;
    systemPrompt?: string;
  }[] = [];
  return {
    launches,
    spawn(argv: string[], config: { cwd: string; env: Record<string, string | undefined> }) {
      const file = argv.indexOf('--append-system-prompt-file');
      const launch = {
        argv,
        env: config.env,
        inputs: [] as string[],
        exited: false,
        systemPrompt: file >= 0 ? readFileSync(argv[file + 1]!, 'utf8') : undefined,
      };
      launches.push(launch);
      let controller!: ReadableStreamDefaultController<Uint8Array>, exit!: (code: number) => void;
      const stdout = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      const exited = new Promise<number>((resolve) => {
        exit = resolve;
      });
      const id = crypto.randomUUID(),
        model = options.model ?? 'claude-haiku-5-5';
      const emit = (event: unknown) => {
        if (!launch.exited)
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
      };
      return {
        stdout,
        stderr: new ReadableStream<Uint8Array>({
          start(c) {
            c.close();
          },
        }),
        exited,
        stdin: {
          write(input: string) {
            const content = JSON.parse(input).message.content as string | { text?: string }[];
            const text =
              typeof content === 'string' ? content : content.map((b) => b.text ?? '').join('');
            launch.inputs.push(text);
            const answer = text.includes('Reply with OK only') ? 'OK' : '{"decided":true}';
            emit({ type: 'system', subtype: 'init', session_id: id, model });
            emit({
              type: 'assistant',
              session_id: id,
              message: {
                role: 'assistant',
                model,
                content: [{ type: 'text', text: answer }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            });
            emit({
              type: 'result',
              subtype: 'success',
              is_error: false,
              result: answer,
              session_id: id,
              usage: { input_tokens: 1, output_tokens: 1 },
            });
          },
          flush() {},
          end() {},
        },
        kill() {
          if (!launch.exited) {
            launch.exited = true;
            controller.close();
            exit(143);
          }
        },
      };
    },
  };
}

function claudeDecisions(
  transport: ReturnType<typeof claudeTransport>,
  options: { subscribed?: boolean; bounds?: Partial<SubscriptionDecisionConfig> } = {},
) {
  const root = userHome(),
    directory = join(root, 'receipts');
  mkdirSync(directory, { mode: 0o700 });
  const config: SubscriptionDecisionConfig = {
    directory,
    source: defaultProfileSource('claude'),
    model: 'claude-haiku-5-5',
    maxCalls: 20,
    maxQueued: 8,
    maxConcurrent: 8,
    callTimeoutMs: 5000,
    ...options.bounds,
  };
  let statusChecks = 0;
  const primed = createPrimedDecisionHost({
    source: config.source,
    directory,
    model: config.model,
    effort: 'low',
    maxConcurrent: config.maxConcurrent ?? 1,
    callTimeoutMs: config.callTimeoutMs,
    spawn: transport.spawn,
    statusSpawn: () => {
      statusChecks++;
      return subscriptionStatusProcess(options.subscribed ?? true);
    },
  });
  const decisions = buildSubscriptionDecisions(config, primed.createRun);
  return {
    root,
    primed,
    decisions,
    get statusChecks() {
      return statusChecks;
    },
    async close() {
      await decisions.shutdown();
      await primed.close();
    },
  };
}

const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];

test('Claude decisions run text-only on the shared Claude login, primed once per role and forked per cycle', async () => {
  const transport = claudeTransport();
  const run = claudeDecisions(transport);
  const cache = '## Domain cache (api)\nroutes live under src/api\n';
  const advise = (message: string) =>
    run.decisions.provider.complete(
      [
        { role: 'system', content: 'ADVISE' },
        { role: 'user', content: `${cache}\n## Message\n${message}` },
      ],
      { threadId: 'T:aux:domain:api', stablePrefix: cache },
    );
  try {
    const first = await advise('one');
    expect(first).toMatchObject({ content: '{"decided":true}', model: 'claude-haiku-5-5' });
    expect(first.native).toMatchObject({ nativeOutcome: 'completed' });
    await advise('two');
    expect(run.statusChecks).toBe(1);
    // A shared registration on the user's login while the host lives.
    expect(existsSync(join(run.root, '.claude', '.foundry-auth-shared'))).toBe(true);
    const [primer, ...branches] = transport.launches;
    expect(primer!.inputs[0]).toContain('routes live under src/api');
    expect(primer!.inputs[0]).toContain('Reply with OK only');
    // Each decision forks the primed session and sends only the per-cycle part.
    const decided = branches.filter((launch) => launch.inputs.length);
    expect(decided.map((launch) => launch.inputs[0])).toEqual([
      '\n## Message\none',
      '\n## Message\ntwo',
    ]);
    for (const launch of transport.launches) {
      expect(launch.argv[0]).toBe('claude');
      expect(flag(launch.argv, '--model')).toBe('claude-haiku-5-5');
      expect(flag(launch.argv, '--effort')).toBe('low');
      expect(flag(launch.argv, '--tools')).toBe('');
      expect(launch.argv).toContain('--strict-mcp-config');
      expect(launch.argv.slice(-2)).toEqual(['--setting-sources', '']);
      expect(launch.argv.join(' ')).not.toContain('Message');
      // The default login is selected by omission; paid credentials never reach a decision.
      expect(
        Object.keys(launch.env).filter((key) => /API_KEY|AUTH_TOKEN|CLAUDE_CONFIG_DIR/.test(key)),
      ).toEqual([]);
    }
    expect(primer!.systemPrompt).toContain("Foundry's internal decision middleware");
    expect(primer!.systemPrompt).toContain('ADVISE');
    for (const launch of decided) expect(launch.argv).toContain('--fork-session');
  } finally {
    await run.close();
  }
  expect(transport.launches.every((launch) => launch.exited)).toBe(true);
  expect(existsSync(join(run.root, '.claude', '.foundry-auth-shared'))).toBe(false);
});

test('phases and threads with the same primed content share one key; a key no session holds is dropped', async () => {
  const transport = claudeTransport();
  const run = claudeDecisions(transport);
  const ask = (threadId: string, cache: string) =>
    run.decisions.provider.complete(
      [
        { role: 'system', content: 'WARDEN' },
        { role: 'user', content: `${cache}\n## Message\nhi` },
      ],
      { threadId, stablePrefix: cache },
    );
  const A = '## Domain cache (api)\nA\n',
    B = '## Domain cache (api)\nB\n';
  const primers = () => transport.launches.filter((l) => !l.argv.includes('--fork-session')).length;
  try {
    await ask('T1:aux:domain:api', A);
    await ask('T1:aux:review:1:domain:api', A);
    await ask('T2:aux:domain:api', A);
    expect(primers()).toBe(1);
    expect(run.primed.host.snapshot().sessions).toBe(1);
    // T1's phases move on; T2 still holds A, so it stays primed.
    await ask('T1:aux:domain:api', B);
    await ask('T1:aux:review:1:domain:api', B);
    expect(primers()).toBe(2);
    expect(run.primed.host.snapshot().sessions).toBe(2);
    // The last holder moves on: A is dropped.
    await ask('T2:aux:domain:api', B);
    await Bun.sleep(20);
    expect(primers()).toBe(2);
    expect(run.primed.host.snapshot().sessions).toBe(1);
  } finally {
    await run.close();
  }
});

test('a login that is not a Claude subscription dispatches nothing and stays refused, with no API fallback', async () => {
  const transport = claudeTransport();
  const run = claudeDecisions(transport, { subscribed: false });
  try {
    await expect(
      run.decisions.provider.complete([{ role: 'user', content: 'private-input' }]),
    ).rejects.toThrow('no fallback or retry');
    expect(transport.launches).toHaveLength(0);
    expect(existsSync(join(run.root, '.claude', '.foundry-auth-shared'))).toBe(false);
  } finally {
    await run.close();
  }
});

test('a substituted Claude model is refused even though the turn completed', async () => {
  const transport = claudeTransport({ model: 'claude-other' });
  const run = claudeDecisions(transport);
  try {
    await expect(
      run.decisions.provider.complete([{ role: 'user', content: 'private-input' }]),
    ).rejects.toThrow('no fallback or retry');
    expect(run.decisions.snapshot().closed).toBe(true);
  } finally {
    await run.close();
  }
});

test('the Claude worker and Claude decisions hold the one login together', async () => {
  const transport = claudeTransport();
  const run = claudeDecisions(transport);
  const worker = new SubscriptionAuthentication(
    join(run.root, 'worker-auth'),
    defaultProfileSource('claude'),
    () => subscriptionStatusProcess(),
  );
  const launch = await worker.prepare('main', 'claude');
  launch.launch(['claude'], {});
  try {
    await run.decisions.provider.complete([{ role: 'user', content: 'decide' }]);
    expect(
      readdirSync(join(run.root, '.claude', '.foundry-auth-shared')).filter((name) =>
        name.endsWith('.json'),
      ),
    ).toHaveLength(2);
  } finally {
    launch.release();
    await run.close();
  }
  expect(existsSync(join(run.root, '.claude', '.foundry-auth-shared'))).toBe(false);
});
