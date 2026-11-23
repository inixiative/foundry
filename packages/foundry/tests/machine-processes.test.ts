import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { elapsedSeconds, parseProcessTable, processTree } from '../src/providers/process-table';
import type { ProjectHostState } from '../src/providers/project-warden-hosts';
import { machineProcesses } from '../src/viewer/machine-processes';
import { registerMachineProcessRoutes } from '../src/viewer/routes/machine-processes';

const PS = `
  100     1 4852832 11.8    03:33 /Users/a/.bun/bin/bun run /x/scripts/daemon/supervisor.ts
  101   100  387488  0.0    03:08 claude --print --verbose --input-format stream-json --model claude-haiku-5-5 --effort low --no-session-persistence
  102   100  382080  0.0    03:08 claude --print --verbose --input-format stream-json --model claude-sonnet-5-5 --effort low
  103   100  418784  1.1 01-02:03:04 claude --print --model claude-opus-5-5 --permission-prompt-tool stdio --resume sess-abc
  104   103   51872  0.0    03:03 bun /x/packages/foundry/src/mcp/proxy.ts /tmp/foundry-b
  105   103  144560  0.0    03:03 npm exec @playwright/mcp@latest
  106   105  112176  0.0    02:59 node /y/node_modules/.bin/playwright-mcp
  107   100  238640  0.0    03:03 claude --print --model claude-haiku-5-5 --effort low --max-turns 1 --safe-mode
  108   100  234544  0.1    03:03 claude --print --model claude-haiku-5-5 --effort low --max-turns 1 --safe-mode
  110   100    2048  0.0    00:05 /bin/zsh -c grep -rn mcp packages --token=sk-secret
  200     1    1024  0.0    00:01 /bin/zsh
`;

const host = (pid: number, lane?: string): ProjectHostState =>
  ({ status: 'serving', expected: 3, held: 3, pid, ...(lane ? { lane } : {}) }) as ProjectHostState;

describe('the process table', () => {
  test('reads ps elapsed time in every form', () => {
    expect(elapsedSeconds('03:33')).toBe(213);
    expect(elapsedSeconds('02:03:04')).toBe(7384);
    expect(elapsedSeconds('01-02:03:04')).toBe(93_784);
  });

  test('parses each row and keeps the command whole', () => {
    const table = parseProcessTable(PS);
    expect(table).toHaveLength(11);
    expect(table[3]).toMatchObject({ pid: 103, ppid: 100, cpu: 1.1, ageSeconds: 93_784 });
    expect(table[3]?.command).toEndWith('--resume sess-abc');
  });

  test('a tree is the process and everything below it, nothing beside it', () => {
    const pids = processTree(parseProcessTable(PS), 103).map((row) => row.pid);
    expect(pids.sort()).toEqual([103, 104, 105, 106]);
  });
});

describe('the Status view process list', () => {
  const table = parseProcessTable(PS);
  const root = machineProcesses(table, 100, {
    hosts: { foundry: host(101), 'foundry (sonnet-5-5 low)': host(102, 'sonnet-5-5 low') },
    projectLabel: (id) => (id === 'foundry' ? 'Foundry' : undefined),
    threadOfSession: (id) => (id === 'sess-abc' ? 't1' : undefined),
    threadName: (id) => (id === 't1' ? 'Make Foundry fast' : undefined),
  });
  const byPid = (pid: number) => root?.children.find((child) => child.pid === pid);

  test('names each process for what it is', () => {
    expect(root?.role).toBe('daemon');
    expect(byPid(101)).toMatchObject({ role: 'warden-host', label: 'Wardens · Foundry' });
    expect(byPid(102)).toMatchObject({
      role: 'warden-host',
      label: 'Wardens · Foundry (sonnet-5-5 low)',
      model: 'claude-sonnet-5-5',
    });
    expect(byPid(103)).toMatchObject({
      role: 'thread',
      label: 'Make Foundry fast',
      threadId: 't1',
    });
    expect(byPid(107)).toMatchObject({ role: 'one-shot', model: 'claude-haiku-5-5' });
    const thread = byPid(103);
    expect(thread?.children.map((child) => child.label).sort()).toEqual([
      'Foundry tools bridge',
      'Playwright MCP',
    ]);
  });

  test('a tree total is its own memory plus everything below it', () => {
    const thread = byPid(103);
    expect(thread?.treeRssMb).toBe(409 + 51 + 141 + 110);
    expect(root?.children).toHaveLength(6);
  });

  test("a shell that mentions mcp is not an MCP server, and its command line isn't sent", () => {
    expect(byPid(110)).toMatchObject({ role: 'other', label: 'zsh', command: 'zsh' });
    expect(byPid(103)?.command).toEndWith('--resume sess-abc');
  });

  test('an unknown session is still a native session, and an absent root is undefined', () => {
    const bare = machineProcesses(table, 100);
    expect(bare?.children.find((child) => child.pid === 103)?.label).toBe('Native session');
    expect(bare?.children.find((child) => child.pid === 101)?.role).toBe('session');
    expect(machineProcesses(table, 999)).toBeUndefined();
  });
});

describe('GET /api/machine/processes', () => {
  test('reads this process as the root and names threads from the session bindings', async () => {
    const app = new Hono();
    registerMachineProcessRoutes(app, {
      projectLabel: () => undefined,
      sessionBindings: async () => [{ threadId: 't1:auth:x:y', externalSessionId: 'sess-abc' }],
      threadName: () => undefined,
    });
    const res = await app.request('/api/machine/processes');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { root: { pid: number; role: string } | null };
    expect(body.root).toMatchObject({ pid: process.pid, role: 'daemon' });
  });
});
