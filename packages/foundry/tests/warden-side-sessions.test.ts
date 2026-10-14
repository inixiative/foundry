import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextLayer, SignalBus } from '@inixiative/foundry-core';
import { DomainLibrarian, domainCachePrefix, threadSection } from '../src/agents/domain-librarian';
import { defaultProfileSource } from '../src/providers/default-profiles';
import {
  createPrimedDecisionHost,
  decisionThread,
  isWardenSession,
  primedRequest,
} from '../src/providers/primed-decisions';
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

function userHome() {
  const root = mkdtempSync(join(tmpdir(), 'warden-side-'));
  roots.push(root);
  mkdirSync(join(root, '.claude'), { mode: 0o755 });
  writeFileSync(join(root, '.claude', '.credentials.json'), '{}', { mode: 0o600 });
  process.env.HOME = root;
  return root;
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Claude CLI doubles: a side session (launched with `--agents`) dispatches Agent calls through the
 * PreToolUse hook and runs subagents (pre-started ones call the moment tool); anything else is a
 * primed decision process answering each turn.
 */
function claudeCli() {
  const sides: { argv: string[]; inputs: string[]; killed: boolean }[] = [];
  const primed: { argv: string[]; inputs: string[] }[] = [];
  const subagentInputs: string[] = [];
  const standbyPrompts: string[] = [];
  const momentInputs: string[] = [];
  const spawn = (
    argv: string[],
    _config: { cwd: string; env: Record<string, string | undefined> },
  ) => {
    let out!: ReadableStreamDefaultController<Uint8Array>, exit!: (code: number) => void;
    let closed = false;
    const emit = (value: unknown) => {
      if (!closed) out.enqueue(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
    };
    const exited = new Promise<number>((resolve) => {
      exit = resolve;
    });
    const end = () => {
      if (closed) return;
      closed = true;
      try {
        out.close();
      } catch {}
      exit(143);
    };
    const side = argv.includes('--agents');
    const record = { argv, inputs: [] as string[], killed: false };
    if (side) {
      // The agent file is read now, as the CLI does at start (it is removed when the process ends).
      JSON.parse(readFileSync(argv[argv.indexOf('--agents') + 1]!, 'utf8'));
      sides.push(record);
    } else primed.push(record);
    let seq = 0;
    const replies = new Map<string, (response: any) => void>();
    const waiting = new Map<string, string>(); // task -> tool use
    let turnOpen = false;
    const sid = `s-${Math.random().toString(36).slice(2)}`;
    const onUser = (text: string) => {
      record.inputs.push(text);
      if (!side) {
        emit({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-haiku-5-5' });
        const reply = text.includes('standing context') ? 'OK' : 'NO_COMMENT';
        emit({
          type: 'assistant',
          session_id: sid,
          message: {
            id: `m${++seq}`,
            model: 'claude-haiku-5-5',
            role: 'assistant',
            content: [{ type: 'text', text: reply }],
          },
        });
        emit({
          type: 'result',
          subtype: 'success',
          uuid: `r${++seq}`,
          session_id: sid,
          result: reply,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
        return;
      }
      turnOpen = true;
      const calls = text.split('\n').map((l) => l.split(' ') as [string, string]);
      let pending = calls.length;
      const done = () => {
        if (--pending === 0 && turnOpen) {
          turnOpen = false;
          emit({ type: 'result', subtype: 'success', session_id: sid, uuid: `r${++seq}` });
        }
      };
      void (async () => {
        for (const [name, token] of calls) {
          const toolUseId = `tu${++seq}`;
          const input = { subagent_type: name, description: token, prompt: '-' };
          emit({
            type: 'assistant',
            session_id: sid,
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input }],
            },
          });
          const hook = `h${++seq}`;
          const response = await new Promise<any>((resolve) => {
            replies.set(hook, resolve);
            emit({
              type: 'control_request',
              request_id: hook,
              request: {
                subtype: 'hook_callback',
                callback_id: 'members',
                input: { tool_name: 'Agent', tool_input: input, tool_use_id: toolUseId },
              },
            });
          });
          const prompt = response.hookSpecificOutput.updatedInput.prompt as string;
          const task = `t${++seq}`;
          emit({
            type: 'system',
            subtype: 'task_started',
            task_id: task,
            tool_use_id: toolUseId,
            prompt,
            session_id: sid,
          });
          const answer = (text: string) => {
            emit({
              type: 'assistant',
              parent_tool_use_id: toolUseId,
              session_id: sid,
              message: {
                role: 'assistant',
                model: 'claude-haiku-5-5',
                content: [{ type: 'text', text }],
                usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 4000 },
              },
            });
            emit({
              type: 'system',
              subtype: 'task_notification',
              task_id: task,
              tool_use_id: toolUseId,
              status: 'completed',
              session_id: sid,
            });
            done();
          };
          const standby = /with token "([^"]+)"/.exec(prompt);
          if (!standby) {
            subagentInputs.push(prompt);
            setTimeout(() => answer('NO_COMMENT'), 5);
            continue;
          }
          standbyPrompts.push(prompt);
          waiting.set(task, toolUseId);
          const rpc = `mcp${++seq}`;
          void new Promise<any>((resolve) => {
            replies.set(rpc, resolve);
            emit({
              type: 'control_request',
              request_id: rpc,
              request: {
                subtype: 'mcp_message',
                server_name: 'foundry',
                message: {
                  jsonrpc: '2.0',
                  id: seq,
                  method: 'tools/call',
                  params: { name: 'moment', arguments: { token: standby[1] } },
                },
              },
            });
          }).then((r) => {
            if (!waiting.delete(task)) return;
            momentInputs.push(r.mcp_response.result.content[0].text);
            answer('NO_COMMENT');
          });
        }
      })();
    };
    return {
      stdout: new ReadableStream<Uint8Array>({
        start(c) {
          out = c;
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      }),
      exited,
      kill() {
        record.killed = true;
        end();
      },
      stdin: {
        write(data: string) {
          for (const line of data.split('\n')) {
            if (!line.trim()) continue;
            const m = JSON.parse(line);
            if (m.type === 'control_response') {
              replies.get(m.response.request_id)?.(m.response.response);
              continue;
            }
            if (m.type === 'control_request') {
              const ok = (response: Record<string, unknown> = {}) =>
                emit({
                  type: 'control_response',
                  response: { subtype: 'success', request_id: m.request_id, response },
                });
              if (m.request.subtype === 'interrupt') {
                for (const [task, toolUseId] of waiting) {
                  waiting.delete(task);
                  emit({
                    type: 'system',
                    subtype: 'task_notification',
                    task_id: task,
                    tool_use_id: toolUseId,
                    status: 'killed',
                    session_id: sid,
                  });
                }
                ok();
                if (turnOpen) {
                  turnOpen = false;
                  emit({
                    type: 'result',
                    subtype: 'error_during_execution',
                    session_id: sid,
                    uuid: `r${++seq}`,
                  });
                }
                continue;
              }
              if (m.request.subtype === 'rewind_conversation') ok({ rewound: true });
              else ok();
              continue;
            }
            if (m.type === 'user') {
              const content = m.message.content;
              onUser(
                typeof content === 'string'
                  ? content
                  : content.map((b: { text?: string }) => b.text ?? '').join(''),
              );
            }
          }
        },
        flush() {},
        end() {},
      },
    };
  };
  return { spawn, sides, primed, subagentInputs, standbyPrompts, momentInputs };
}

function decisionsOn(cli: ReturnType<typeof claudeCli>, extra: { prestart?: boolean } = {}) {
  const root = userHome(),
    directory = join(root, 'receipts');
  mkdirSync(directory, { mode: 0o700 });
  const config: SubscriptionDecisionConfig = {
    directory,
    source: defaultProfileSource('claude'),
    model: 'claude-haiku-5-5',
    maxCalls: 100,
    maxQueued: 64,
    maxConcurrent: 32,
    callTimeoutMs: 5000,
  };
  const primed = createPrimedDecisionHost({
    source: config.source,
    directory,
    model: config.model,
    effort: 'low',
    maxConcurrent: 32,
    callTimeoutMs: config.callTimeoutMs,
    spawn: cli.spawn as never,
    statusSpawn: () => subscriptionStatusProcess(true),
    ...extra,
  });
  const decisions = buildSubscriptionDecisions(config, primed.createRun);
  decisions.provider.prestart = primed.prestart;
  decisions.provider.releaseThread = primed.releaseThread;
  return {
    primed,
    decisions,
    async close() {
      await decisions.shutdown();
      await primed.close();
    },
  };
}

function warden(domain: string, llm: Parameters<typeof scoped>[0], thread: string) {
  const cache = new ContextLayer({ id: `${domain}-cache` });
  cache.set(`${domain} knowledge`);
  const instructions = new ContextLayer({ id: `${domain}-instructions` });
  instructions.set(`You are the ${domain} Warden.`);
  return new DomainLibrarian({
    domain,
    cache,
    instructions,
    signals: new SignalBus(),
    llm: scoped(llm, `${thread}:aux:domain:${domain}`),
    guardTriggers: ['Bash'],
  });
}
function scoped(
  provider: ReturnType<typeof decisionsOn>['decisions']['provider'],
  threadId: string,
): ReturnType<typeof decisionsOn>['decisions']['provider'] {
  return {
    ...provider,
    complete: (m, o) => provider.complete(m, { ...o, threadId }),
    prestart: (m, o) => provider.prestart?.(m, { ...o, threadId }),
  };
}

test('Warden sessions are grouped by thread; other roles keep their own primed sessions', () => {
  expect(isWardenSession('T1:aux:domain:docs')).toBe(true);
  expect(isWardenSession('T1:aux:review:3:domain:docs')).toBe(true);
  expect(isWardenSession('T1:aux:cartographer')).toBe(false);
  expect(isWardenSession('decision:abc')).toBe(false);
  expect(decisionThread('T1:aux:review:3:domain:docs')).toBe('T1');
  expect(decisionThread('decision:abc')).toBeUndefined();
});

test('advice and guard declare the thread section that follows the domain cache; it is the standby context', async () => {
  const seen: { content: string; stablePrefix?: string; threadPrefix?: string }[] = [];
  const llm = {
    id: 'recording',
    async complete(
      messages: { role: string; content: string }[],
      opts?: { stablePrefix?: string; threadPrefix?: string },
    ) {
      seen.push({
        content: messages[1]!.content,
        stablePrefix: opts?.stablePrefix,
        threadPrefix: opts?.threadPrefix,
      });
      return { content: 'NO_COMMENT', model: 'm' };
    },
  };
  const cache = new ContextLayer({ id: 'api' });
  cache.set('Routes live under src/api.');
  const lib = new DomainLibrarian({
    domain: 'api',
    cache,
    signals: new SignalBus(),
    llm: llm as never,
    guardTriggers: ['Bash'],
  });
  await lib.advise('Add a route', 'STATE', { threadKnowledge: 'KNOWN' });
  await lib.guard({ tool: 'Bash', input: { command: 'ls' } } as never, 'STATE', {
    threadKnowledge: 'KNOWN',
  });
  const expected = threadSection('KNOWN');
  for (const call of seen) {
    expect(call.threadPrefix).toBe(expected);
    expect(call.content.startsWith(`${call.stablePrefix}${call.threadPrefix}`)).toBe(true);
  }
  const { spec, input, standby } = primedRequest(
    [
      { role: 'system', content: 'S' },
      { role: 'user', content: seen[0]!.content },
    ],
    { stablePrefix: seen[0]!.stablePrefix, threadPrefix: seen[0]!.threadPrefix },
    'T1:aux:domain:api',
  );
  expect(spec.context).toBe(domainCachePrefix('api', 'Routes live under src/api.'));
  expect(standby).toBe(expected);
  expect(input.startsWith(expected)).toBe(true);
  // The thread state moves with every action: it rides with the moment, never in the standby.
  expect(input.slice(expected.length)).toContain('## Thread state\nSTATE');
});

test("a thread's Wardens fan out in one side session; another thread gets its own", async () => {
  const cli = claudeCli();
  const run = decisionsOn(cli, { prestart: false });
  try {
    const wardens = ['docs', 'tests', 'lean'].map((d) => warden(d, run.decisions.provider, 'T1'));
    const results = await Promise.all(wardens.map((w) => w.advise('Add a route', 'STATE')));
    expect(results.every((r) => r.noComment)).toBe(true);
    expect(cli.sides).toHaveLength(1);
    expect(cli.sides[0]!.inputs).toHaveLength(1); // one fan-out turn
    expect(cli.primed).toHaveLength(0);
    // Without a pre-started member, the standby context rides in front of the input.
    expect(cli.subagentInputs.every((p) => p.startsWith(threadSection(undefined)))).toBe(true);
    await warden('docs', run.decisions.provider, 'T2').advise('Other thread', 'STATE');
    expect(cli.sides).toHaveLength(2);
  } finally {
    await run.close();
  }
});

test('pre-started Wardens take only the moment; a landed turn refreshes them; a closed thread releases them', async () => {
  const cli = claudeCli();
  const run = decisionsOn(cli);
  try {
    const wardens = ['docs', 'tests'].map((d) => warden(d, run.decisions.provider, 'T1'));
    for (const w of wardens) w.prestart();
    await tick(120);
    expect(cli.standbyPrompts).toHaveLength(2);
    expect(cli.standbyPrompts.every((p) => p.startsWith(threadSection(undefined)))).toBe(true);
    const results = await Promise.all(wardens.map((w) => w.advise('Add a route', 'STATE v1')));
    expect(results.every((r) => r.noComment)).toBe(true);
    expect(cli.momentInputs).toHaveLength(2);
    // The moment carries the thread state, then the message.
    expect(
      cli.momentInputs.every((m) =>
        m.startsWith('\n## Thread state\nSTATE v1\n\n## Message\nAdd a route'),
      ),
    ).toBe(true);
    expect(cli.subagentInputs).toEqual([]); // nothing fanned out
    // A new thread state alone does not stale the spares: a guard on the next action takes one.
    await tick(200);
    await wardens[0]!.guard({ tool: 'Bash', input: { command: 'ls' } } as never, 'STATE v2');
    expect(cli.subagentInputs).toEqual([]);
    // A review landed new understanding: every Warden is pre-started with it.
    for (const w of wardens)
      w.threadKnowledge.learn(
        'KNOWN v2',
        { kind: 'dispatch', id: 'review', ok: true, timestamp: 1 },
        'review',
      );
    for (const w of wardens) w.prestart();
    await tick(200);
    expect(cli.standbyPrompts.filter((p) => p.includes('KNOWN v2'))).toHaveLength(2);
    await run.decisions.provider.releaseThread!('T1');
    expect(cli.sides.every((s) => s.killed)).toBe(true);
  } finally {
    await run.close();
  }
});
