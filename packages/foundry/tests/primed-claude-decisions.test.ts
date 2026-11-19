import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CLAUDE_DECISION_CACHE_ENV } from '@inixiative/agent-session';
import { markedRun } from '@inixiative/archive/exemption';
import { foundryRunKind } from '../src/archives/run-stamp';
import { defaultProfileSource } from '../src/providers/default-profiles';
import {
  createPrimedDecisionHost,
  decisionHostsDirectory,
} from '../src/providers/primed-decisions';
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
    cwd: string;
    inputs: string[];
    /** The base context file's contents at spawn; agent-session removes the file when the session ends. */
    base?: string;
    /** The `--agents` definitions file's contents at spawn (subagent side sessions). */
    agents?: string;
    exited: boolean;
  }[] = [];
  return {
    launches,
    spawn(argv: string[], config: { cwd: string; env: Record<string, string | undefined> }) {
      const file = argv[argv.indexOf('--append-system-prompt-file') + 1];
      const launch = {
        argv,
        env: config.env,
        cwd: config.cwd,
        inputs: [] as string[],
        base:
          argv.includes('--append-system-prompt-file') && file
            ? readFileSync(file, 'utf8')
            : undefined,
        agents: argv.includes('--agents')
          ? readFileSync(argv[argv.indexOf('--agents') + 1]!, 'utf8')
          : undefined,
        exited: false,
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
      const id = Bun.randomUUIDv7(),
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
  options: {
    subscribed?: boolean;
    bounds?: Partial<SubscriptionDecisionConfig>;
    subagents?: { processes: number; membersPerProcess: number };
  } = {},
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
    ...(options.subagents ? { subagents: options.subagents } : {}),
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

test('Claude decisions run text-only on the shared Claude login, the role held in the system prompt, a fresh session per cycle', async () => {
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
    // Each decision is a fresh session that sends only the per-cycle part; the stable text rides in
    // the system prompt.
    const decided = transport.launches.filter((launch) => launch.inputs.length);
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
        Object.entries(launch.env).flatMap(([key, value]) =>
          value && /API_KEY|AUTH_TOKEN|BASE_URL|CLAUDE_CONFIG_DIR/.test(key) ? [key] : [],
        ),
      ).toEqual([]);
      // The system prompt is cached for an hour, each decision's input for five minutes.
      expect(launch.env).toMatchObject(CLAUDE_DECISION_CACHE_ENV);
    }
    // agent-session hands the base context over in a private file, never on argv.
    for (const launch of decided) {
      expect(launch.base).toContain("Foundry's internal decision middleware");
      expect(launch.base).toContain('ADVISE');
      expect(launch.base).toContain('routes live under src/api');
      expect(launch.argv).toContain('--no-session-persistence');
      expect(launch.argv).not.toContain('--resume');
    }
    // Receipts stay in the receipt directory; the sessions run in the host's own empty folder under
    // the hosts directory, outside any git work tree, stamped for Archive as Foundry's own.
    const [host] = readdirSync(join(run.root, 'receipts')).filter((name) =>
      name.startsWith('primed-'),
    );
    expect(readdirSync(join(run.root, 'receipts', host!)).sort()).toEqual([
      'decisions.jsonl',
      'host.json',
    ]);
    const workspace = join(decisionHostsDirectory(), host!);
    expect(new Set(transport.launches.map((launch) => launch.cwd))).toEqual(
      new Set([join(workspace, 'fixture')]),
    );
    expect(readdirSync(join(workspace, 'fixture'))).toEqual([]);
    expect(statSync(workspace).mode & 0o777).toBe(0o700);
    for (const stamped of [workspace, decisionHostsDirectory()])
      expect(readFileSync(join(stamped, '.archive-run'), 'utf8').trim()).toBe(foundryRunKind());
    expect(markedRun(join(workspace, 'fixture'))).toBe(`run:${foundryRunKind()}`);
  } finally {
    await run.close();
  }
  // Closed: its folder is gone, and the hosts directory's marker still stamps any session it left behind.
  const [host] = readdirSync(join(run.root, 'receipts')).filter((name) =>
    name.startsWith('primed-'),
  );
  expect(existsSync(join(decisionHostsDirectory(), host!))).toBe(false);
  expect(markedRun(join(decisionHostsDirectory(), host!, 'fixture'))).toBe(
    `run:${foundryRunKind()}`,
  );
  expect(transport.launches.every((launch) => launch.exited)).toBe(true);
  expect(existsSync(join(run.root, '.claude', '.foundry-auth-shared'))).toBe(false);
});

test('a hosts folder that is not private refuses the host and says how to fix it', () => {
  const own = process.env.FOUNDRY_HOSTS_DIR;
  const hosts = join(mkdtempSync(join(tmpdir(), 'hosts-open-')), 'hosts');
  roots.push(dirname(hosts));
  mkdirSync(hosts, { mode: 0o755 });
  chmodSync(hosts, 0o755);
  process.env.FOUNDRY_HOSTS_DIR = hosts;
  try {
    expect(() => claudeDecisions(claudeTransport())).toThrow(
      `Foundry's decision hosts folder ${hosts}, where Wardens run outside any git checkout, must be a directory you own with mode 0700`,
    );
  } finally {
    process.env.FOUNDRY_HOSTS_DIR = own;
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

test('subagents: decisions are served by a bounded pool of dispatcher side sessions holding each role as a subagent', async () => {
  const transport = claudeTransport();
  const run = claudeDecisions(transport, {
    subagents: { processes: 2, membersPerProcess: 2 },
    bounds: { callTimeoutMs: 400 },
  });
  const cache = (domain: string) => `## Domain cache (${domain})\nknowledge of ${domain}\n`;
  const advise = (domain: string) =>
    run.decisions.provider.complete(
      [
        { role: 'system', content: `ADVISE ${domain}` },
        { role: 'user', content: `${cache(domain)}\n## Message\nhello` },
      ],
      { threadId: `T:aux:domain:${domain}`, stablePrefix: cache(domain) },
    );
  try {
    // The fake transport never answers the dispatcher, so each decision times out; the launches show the shape.
    await Promise.allSettled(['a', 'b', 'c', 'd'].map(advise));
    expect(transport.launches.length).toBeGreaterThan(0);
    expect(transport.launches.length).toBeLessThanOrEqual(2);
    const roles = transport.launches.flatMap((launch) =>
      Object.values(JSON.parse(launch.agents ?? '{}') as Record<string, { prompt: string }>),
    );
    for (const launch of transport.launches) {
      expect(flag(launch.argv, '--tools')).toBe('Agent');
      expect(flag(launch.argv, '--model')).toBe('claude-haiku-5-5');
      expect(launch.argv.slice(-2)).toEqual(['--setting-sources', '']);
      expect(
        Object.entries(launch.env).flatMap(([key, value]) =>
          value && /API_KEY|AUTH_TOKEN|BASE_URL|CLAUDE_CONFIG_DIR/.test(key) ? [key] : [],
        ),
      ).toEqual([]);
    }
    // Each role's prompt is the decision base, its instructions and its stable context, as primed.
    const a = roles.find((role) => role.prompt.includes('ADVISE a'));
    expect(a?.prompt).toContain("Foundry's internal decision middleware");
    expect(a?.prompt).toContain('knowledge of a');
  } finally {
    await run.close();
  }
});

test("Foundry's own folders take the harness's run kind, else foundry", () => {
  expect(foundryRunKind({})).toBe('foundry');
  expect(foundryRunKind({ ARCHIVE_RUN: 'oracle' })).toBe('oracle');
  expect(foundryRunKind({ ARCHIVE_RUN: ' test ' })).toBe('test');
  expect(foundryRunKind({ ARCHIVE_RUN: 'nonsense' })).toBe('foundry');
});
