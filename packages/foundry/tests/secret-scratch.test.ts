import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolRequest } from '@inixiative/agent-session';
import {
  ActionQueue,
  ContextStack,
  EventStream,
  Executor,
  Harness,
  InterventionLog,
  secretInstructionPath,
  Thread,
  ToolRegistry,
} from '@inixiative/foundry-core';
import { createFoundryMcp } from '../src/mcp/server';
import {
  resolveSecretsSettings,
  SecretScratch,
  validateSecretsSettings,
} from '../src/secrets/scratch';
import { SECRET_SCRATCH_DESCRIPTION, SecretScratchTool } from '../src/tools/secret-scratch';
import { createToolGate } from '../src/turns/tool-gate';
import { createViewer } from '../src/viewer/server';
import { connectStreams } from './helpers/data-stream';
import { until } from './helpers/live-watch-fixture';

const require = createRequire(import.meta.url);
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

const SECRET = 'ghp_SuperSecretValue123';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-secrets-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('settings: off by default, the project overrides the switch, globs add up, fields are checked', () => {
  expect(resolveSecretsSettings(undefined, undefined)).toEqual({
    scratchPad: false,
    privatePaths: [],
  });
  expect(
    resolveSecretsSettings(
      { scratchPad: true, privatePaths: ['*.pem'] },
      { scratchPad: false, privatePaths: ['*.key'] },
    ),
  ).toEqual({ scratchPad: false, privatePaths: ['*.pem', '*.key'] });
  expect(() => validateSecretsSettings('secrets', { scratchPad: 'yes' })).toThrow('boolean');
  expect(() => validateSecretsSettings('secrets', { other: 1 })).toThrow('unknown field other');
});

/** A thread on Foundry's MCP bridge with the scratch tools, its working directory a temp dir. */
async function bridge(on = true, projects: Record<string, string | undefined> = {}) {
  const root = tempDir();
  const secrets = new SecretScratch(join(root, 'state', '.private', 'scratch'), {
    settings: () => ({ scratchPad: on, privatePaths: [] }),
    projectOf: (threadId) => (threadId in projects ? projects[threadId] : null),
  });
  const thread = new Thread('thread-1', new ContextStack());
  thread.meta.cwd = root;
  thread.meta.projectId = projects['thread-1'];
  const tools = new ToolRegistry();
  tools.register(new SecretScratchTool(() => secrets), SECRET_SCRATCH_DESCRIPTION);
  const mcp = createFoundryMcp({ thread, tools });
  const client = new Client({ name: 'secret-scratch', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return {
      isError: !!result.isError,
      text: (result.content as Array<{ text: string }>)[0]!.text,
    };
  };
  return { root, secrets, thread, client, call };
}

test('the tools never return a value: env into a file, pipe from it, list and consume', async () => {
  const b = await bridge();
  const names = (await b.client.listTools()).tools.map((tool: { name: string }) => tool.name);
  expect(names).toEqual(expect.arrayContaining(['secret_scratch', 'secret_pipe']));
  expect(b.secrets.lift(b.thread, 'turn_a', `set it up with $$${SECRET} please`).text).toBe(
    'set it up with †turn_a.1 please',
  );
  const results: string[] = [];
  const run = async (name: string, args: Record<string, unknown>) => {
    const result = await b.call(name, args);
    results.push(result.text);
    return result;
  };
  expect((await run('secret_scratch', { action: 'list' })).text).toContain('†turn_a.1');
  expect(
    await run('secret_scratch', {
      action: 'env',
      ref: '†turn_a.1',
      path: '.env.local',
      key: 'GH_TOKEN',
      consume: true,
    }),
  ).toEqual({ isError: false, text: 'GH_TOKEN is set in .env.local; the secret is consumed.' });
  expect(readFileSync(join(b.root, '.env.local'), 'utf8')).toBe(`GH_TOKEN=${SECRET}\n`);
  const out = join(b.root, 'piped');
  expect(
    await run('secret_pipe', {
      command: `cat > ${out}; echo ${'$'}(cat ${out})`,
      envFile: '.env.local',
      key: 'GH_TOKEN',
    }),
  ).toEqual({ isError: false, text: 'The command exited 0 (output withheld).' });
  expect(readFileSync(out, 'utf8')).toBe(SECRET);
  expect((await run('secret_scratch', { action: 'list' })).text).toBe(
    'Nothing is pending in that pad.',
  );
  expect((await run('secret_scratch', { action: 'consume', ref: '†turn_a.1' })).isError).toBe(true);
  expect(results.join('\n')).not.toContain(SECRET);
});

test('a leftover pad of another thread of the same project is reached with the full reference', async () => {
  const b = await bridge(true, { 'thread-1': 'p1', 'old-thread': 'p1' });
  const old = new Thread('old-thread', new ContextStack());
  b.secrets.lift(old, 'turn_x', `$$${SECRET}`);
  expect((await b.call('secret_scratch', { action: 'list', all: true })).text).toContain(
    '†old-thread/turn_x.1',
  );
  await b.call('secret_scratch', {
    action: 'write',
    ref: '†old-thread/turn_x.1',
    path: 'key.txt',
    consume: true,
  });
  expect(readFileSync(join(b.root, 'key.txt'), 'utf8')).toBe(SECRET);
  expect(b.secrets.pad.threads()).toEqual([]);
});

test('with the setting off the tools are not offered and nothing is lifted', async () => {
  const b = await bridge(false);
  const names = (await b.client.listTools()).tools.map((tool: { name: string }) => tool.name);
  expect(names).not.toContain('secret_scratch');
  expect(b.secrets.lift(b.thread, 'turn_a', `$$${SECRET}`).text).toBe(`$$${SECRET}`);
  expect(b.secrets.privacy(undefined)).toBeUndefined();
});

test('the gate denies reading private paths and files the pad wrote, in every mode, and lets the scratch tool through', async () => {
  const b = await bridge();
  b.secrets.lift(b.thread, 'turn_a', `$$${SECRET}`);
  b.secrets.pad.env('turn_a.1', b.thread.id, '.env.local', 'K', { cwd: b.root });
  const rows: Array<Record<string, unknown>> = [];
  const decide = createToolGate({
    threadId: b.thread.id,
    rules: () => undefined,
    mode: () => 'bypassPermissions',
    queue: new ActionQueue(),
    turnId: () => 'turn-1',
    journal: (_id, phase, _turn, record) => phase === 'gate-outcome' && rows.push(record),
    privacy: () => b.secrets.privacy(undefined),
  });
  const ask = (toolName: string, toolInput: Record<string, unknown>): ToolRequest => ({
    stage: 'pre-use',
    toolName,
    toolInput,
  });
  expect(await decide(ask('Read', { file_path: join(b.root, '.env.local') }))).toMatchObject({
    behavior: 'deny',
  });
  expect(await decide(ask('Bash', { command: 'cat .env.local' }))).toMatchObject({
    behavior: 'deny',
  });
  expect(await decide(ask('Read', { file_path: join(b.root, 'notes.private.md') }))).toMatchObject({
    behavior: 'deny',
  });
  expect(await decide(ask('Bash', { command: `ls ${b.secrets.pad.dir}` }))).toMatchObject({
    behavior: 'deny',
  });
  expect(await decide(ask('Bash', { command: 'ls src' }))).toEqual({ behavior: 'allow' });
  const own = `mcp__foundry_${'a'.repeat(32)}__secret_scratch`;
  expect(await decide(ask(own, { action: 'write', path: 'keys.private' }))).toEqual({
    behavior: 'allow',
  });
  expect(rows.filter((row) => row.by === 'private-path')).toHaveLength(4);
});

test('a $$ secret is lifted before the journal and the executor see it; archiving the thread deletes its pad', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ secrets: { scratchPad: true } }));
  const received: string[] = [];
  const main = new Thread('main', new ContextStack());
  main.register(
    new Executor({
      id: 'worker',
      stack: main.stack,
      handler: async (_context, payload) => {
        received.push(String(payload));
        return 'ok';
      },
    }),
  );
  const harness = new Harness(main);
  harness.setDefaultExecutor('worker');
  const viewer = createViewer({
    harness,
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    configDir: dir,
  });
  await viewer.configStore.load();
  const client = connectStreams(viewer);
  cleanup.push(async () => {
    client.disconnect();
    await viewer.analyticsReady.catch(() => {});
    viewer.localStore?.close();
  });
  const response = await viewer.app.request('/api/messages/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'turn_s1',
      threadId: 'main',
      message: `deploy with $$${SECRET} now`,
      clientId: client.socket.data.clientId,
    }),
  });
  expect(response.status).toBe(202);
  await until(() => received.length === 1, 'turn ran');
  expect(received[0]).toContain('deploy with †turn_s1.1 now');
  expect(received.join('\n')).not.toContain(SECRET);
  const journal = readdirSync(dir)
    .filter((name) => name.startsWith('sessions.sqlite'))
    .map((name) => readFileSync(join(dir, name)).toString('utf8'))
    .join('');
  expect(journal.includes(SECRET)).toBe(false);
  expect(journal.includes('†turn_s1.1')).toBe(true);
  const pad = join(dir, '.private', 'scratch', 'main.pad');
  expect(readFileSync(pad, 'utf8')).toContain(JSON.stringify(SECRET));
  // A second send with the same id is refused before anything is lifted.
  const again = await viewer.app.request('/api/messages/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'turn_s1', threadId: 'main', message: '$$another-secret-1' }),
  });
  expect(again.status).toBe(409);
  expect(viewer.secrets.list('main')[0]?.daggers.map((d) => d.positions)).toEqual([[1]]);
  // The lift watched the live thread: archiving it deletes its pad.
  main.archive();
  expect(existsSync(pad)).toBe(false);
});

test("another project's pad, and an outside party's turn, are refused; list shows only this project", async () => {
  const b = await bridge(true, { 'thread-1': 'p1', 'mine-too': 'p1', theirs: 'p2' });
  b.secrets.lift(new Thread('mine-too', new ContextStack()), 'turn_m', '$$secret-mine-1');
  b.secrets.lift(new Thread('theirs', new ContextStack()), 'turn_t', `$$${SECRET}`);
  const listed = await b.call('secret_scratch', { action: 'list', all: true });
  expect(listed.text).toContain('mine-too');
  expect(listed.text).not.toContain('theirs');
  const used = await b.call('secret_scratch', {
    action: 'write',
    ref: '†theirs/turn_t.1',
    path: 'x',
  });
  expect(used).toMatchObject({ isError: true });
  expect(used.text).toContain("not in this thread's project");
  b.secrets.ownerInstructed = () => false;
  const outside = await b.call('secret_pipe', {
    ref: '†mine-too/turn_m.1',
    command: 'cat >/dev/null',
  });
  expect(outside.text).toContain("owner's own message");
});

test('secret_scratch writes only inside the working directory, never into version control or agent configuration', async () => {
  const b = await bridge();
  b.secrets.lift(b.thread, 'turn_a', `$$${SECRET}`);
  for (const path of [
    '../escape.txt',
    '/tmp/escape.txt',
    '.git/hooks/pre-commit',
    '.claude/settings.json',
    '.mcp.json',
  ]) {
    const result = await b.call('secret_scratch', { action: 'write', ref: '†turn_a.1', path });
    expect(result.isError).toBe(true);
  }
  symlinkSync(tmpdir(), join(b.root, 'out'));
  expect(
    (await b.call('secret_scratch', { action: 'write', ref: '†turn_a.1', path: 'out/x' })).isError,
  ).toBe(true);
  expect(
    (
      await b.call('secret_scratch', {
        action: 'env',
        ref: '†turn_a.1',
        path: 'config/.env',
        key: 'K',
      })
    ).isError,
  ).toBe(true);
  mkdirSync(join(b.root, 'config'));
  expect(
    (
      await b.call('secret_scratch', {
        action: 'env',
        ref: '†turn_a.1',
        path: 'config/.env',
        key: 'K',
      })
    ).isError,
  ).toBe(false);
});

test('an unreadable held-files list denies every call: the gate fails closed', async () => {
  const b = await bridge();
  b.secrets.lift(b.thread, 'turn_a', `$$${SECRET}`);
  writeFileSync(join(b.secrets.pad.dir, 'held-files.json'), '{not json');
  const decide = createToolGate({
    threadId: b.thread.id,
    rules: () => undefined,
    mode: () => 'bypassPermissions',
    queue: new ActionQueue(),
    turnId: () => null,
    journal: () => {},
    privacy: () => b.secrets.privacy(undefined),
  });
  expect(
    await decide({ stage: 'pre-use', toolName: 'Bash', toolInput: { command: 'ls src' } }),
  ).toMatchObject({
    behavior: 'deny',
  });
});

test('the composer never imports a .private path', () => {
  expect(secretInstructionPath('/repo/.private/notes.md')).toBe(true);
  expect(secretInstructionPath('/repo/docs/keys.private.md')).toBe(true);
  expect(secretInstructionPath('/repo/docs/private-routes.md')).toBe(false);
});
