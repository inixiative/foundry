// The decision login host: the Claude decision login every project Warden host launches on, its
// receipts and its folders. Its Warden calls are served by a fake project host (no model calls).
import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { markedRun } from '@inixiative/archive/exemption';
import { type LLMMessage, servedModel } from '@inixiative/foundry-core';
import { foundryRunKind } from '../src/archives/run-stamp';
import {
  createDecisionLoginHost,
  decisionHostsDirectory,
} from '../src/providers/decision-login-host';
import { defaultProfileSource } from '../src/providers/default-profiles';
import { ProjectWardenHosts } from '../src/providers/project-warden-hosts';
import { SubscriptionAuthentication } from '../src/providers/subscription-authentication';
import { buildSubscriptionDecisions } from '../src/providers/subscription-decisions';
import { PROJECT_HOST_DEFAULTS } from '../src/providers/subscription-policy';
import { primedRequest } from '../src/providers/warden-routing';
import { fakeClaudeTree } from './helpers/fake-claude-tree';
import { subscriptionStatusProcess } from './helpers/subscription-transport';

const cleanup: Array<() => unknown> = [];
const home = process.env.HOME;
const hostsDir = process.env.FOUNDRY_HOSTS_DIR;
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  process.env.HOME = home;
  if (hostsDir === undefined) delete process.env.FOUNDRY_HOSTS_DIR;
  else process.env.FOUNDRY_HOSTS_DIR = hostsDir;
});

/** A temporary HOME holding the user's own Claude login, with a private hosts directory of its own. */
function userHome() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'decision-login-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.claude'), { mode: 0o755 });
  writeFileSync(join(root, '.claude', '.credentials.json'), '{}', { mode: 0o600 });
  process.env.HOME = root;
  delete process.env.CLAUDE_CONFIG_DIR;
  const hosts = join(root, 'hosts');
  mkdirSync(hosts, { mode: 0o700 });
  process.env.FOUNDRY_HOSTS_DIR = hosts;
  return root;
}

const CACHE = '## Domain cache (api)\nroutes live under src/api\n';
const MESSAGES: LLMMessage[] = [
  { role: 'system', content: 'API WARDEN' },
  { role: 'user', content: `${CACHE}\n## Message\nadd a route` },
];

/** A decision login host on the fake CLI with its project host, and the scheduler over it. */
function claudeDecisions(
  options: {
    subscribed?: boolean;
    model?: string;
    openHostsFolder?: boolean;
    hangOn?: string;
    callTimeoutMs?: number;
  } = {},
) {
  const callTimeoutMs = options.callTimeoutMs ?? 3_000;
  const root = userHome();
  if (options.openHostsFolder) chmodSync(process.env.FOUNDRY_HOSTS_DIR!, 0o755);
  const directory = join(root, 'receipts');
  mkdirSync(directory, { mode: 0o700 });
  const tree = fakeClaudeTree({
    ...(options.model ? { model: options.model } : {}),
    ...(options.hangOn ? { hangOn: options.hangOn } : {}),
  });
  let statusChecks = 0;
  const wardens = new ProjectWardenHosts({
    model: 'claude-haiku-5-5',
    effort: 'low',
    timeoutMs: callTimeoutMs,
    projectOf: () => 'P',
    projectHost: { ...PROJECT_HOST_DEFAULTS, setupDeadlineMs: 5_000, maxRestarts: 0 },
    rss: () => 100,
  });
  const host = createDecisionLoginHost({
    source: defaultProfileSource('claude'),
    directory,
    model: 'claude-haiku-5-5',
    effort: 'low',
    maxConcurrent: 1,
    callTimeoutMs,
    spawn: tree.spawn,
    statusSpawn: () => {
      statusChecks++;
      return subscriptionStatusProcess(options.subscribed ?? true);
    },
    projectHosts: wardens,
  });
  const decisions = buildSubscriptionDecisions(
    {
      directory,
      source: defaultProfileSource('claude'),
      model: 'claude-haiku-5-5',
      maxCalls: 20,
      maxQueued: 8,
      maxConcurrent: 1,
      callTimeoutMs,
    },
    host.createRun,
  );
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await decisions.shutdown();
    await wardens.close();
    await host.close();
  };
  cleanup.push(close);
  /** Open the project's host holding the API Warden, and wait until it serves. */
  const serve = async () => {
    const { spec } = primedRequest(MESSAGES, { stablePrefix: CACHE }, 'T0:aux:domain:api');
    wardens.openProject('P', [{ spec, standby: '' }]);
    return wardens.projectReady('P', 5_000);
  };
  const advise = (message = 'add a route') =>
    decisions.provider.complete(
      [MESSAGES[0]!, { role: 'user', content: `${CACHE}\n## Message\n${message}` }],
      { threadId: 'T1:aux:domain:api', stablePrefix: CACHE },
    );
  /** Every receipt the host wrote, in order. */
  const receipts = () =>
    readFileSync(join(directory, `host-${host.hostId}`, 'decisions.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { valid: boolean; failure?: string; settled?: boolean });
  return {
    root,
    tree,
    host,
    decisions,
    serve,
    advise,
    receipts,
    close,
    get statusChecks() {
      return statusChecks;
    },
  };
}

test('the decision login is held while the host lives; receipts stay in the receipt directory and the host runs in its own private, stamped folder', async () => {
  const run = claudeDecisions();
  expect(await run.serve()).toBe(true);
  const answer = await run.advise();
  expect(answer).toMatchObject({ model: 'claude-haiku-5-5' });
  // The model and effort it ran on.
  expect(servedModel(answer)).toEqual({ model: 'claude-haiku-5-5', effort: 'low' });
  expect(answer.content).toBe('ANS:\n## Message\nadd a route');
  expect(run.statusChecks).toBe(1);
  // A shared registration on the user's login while the host lives.
  expect(existsSync(join(run.root, '.claude', '.foundry-auth-shared'))).toBe(true);
  const folder = `host-${run.host.hostId}`;
  expect(readdirSync(join(run.root, 'receipts', folder)).sort()).toEqual([
    'decisions.jsonl',
    'host.json',
  ]);
  const receipt = JSON.parse(
    readFileSync(join(run.root, 'receipts', folder, 'decisions.jsonl'), 'utf8').trim(),
  );
  expect(receipt).toMatchObject({ valid: true, settled: true, transport: 'primed' });
  const workspace = join(decisionHostsDirectory(), folder);
  expect(statSync(workspace).mode & 0o777).toBe(0o700);
  expect(dirname(run.tree.processes[0]!.cwd!)).toBe(workspace);
  for (const stamped of [workspace, decisionHostsDirectory()])
    expect(readFileSync(join(stamped, '.archive-run'), 'utf8').trim()).toBe(foundryRunKind());
  // The default login is selected by omission; paid credentials never reach the host.
  expect(
    Object.entries(run.tree.processes[0]!.env).flatMap(([key, value]) =>
      value && /API_KEY|AUTH_TOKEN|BASE_URL|CLAUDE_CONFIG_DIR/.test(key) ? [key] : [],
    ),
  ).toEqual([]);
  await run.close();
  // Closed: its folder is gone, and the hosts directory's marker still stamps any session it left behind.
  expect(existsSync(workspace)).toBe(false);
  expect(markedRun(join(workspace, 'project-x'))).toBe(`run:${foundryRunKind()}`);
  expect(run.tree.processes.every((process) => process.exited)).toBe(true);
  expect(existsSync(join(run.root, '.claude', '.foundry-auth-shared'))).toBe(false);
});

test('a hosts folder that is not private refuses the host and says how to fix it', () => {
  expect(() => claudeDecisions({ openHostsFolder: true })).toThrow(
    /^Foundry's decision hosts folder \S+, where Wardens run outside any git checkout, must be a directory you own with mode 0700/,
  );
});

test('a login that is not a Claude subscription dispatches nothing and stays refused, with no API fallback', async () => {
  const run = claudeDecisions({ subscribed: false });
  await expect(run.advise()).rejects.toThrow('no fallback or retry');
  expect(run.tree.processes).toHaveLength(0);
  expect(existsSync(join(run.root, '.claude', '.foundry-auth-shared'))).toBe(false);
});

test('a call that is not a Warden call is refused before the login is checked, and starts nothing', async () => {
  const run = claudeDecisions();
  await expect(
    run.decisions.provider.complete([{ role: 'user', content: 'private-input' }]),
  ).rejects.toThrow('no fallback or retry');
  expect(run.statusChecks).toBe(0);
  expect(run.tree.processes).toHaveLength(0);
});

test('a substituted Claude model is refused even though the turn completed', async () => {
  const run = claudeDecisions({ model: 'claude-other' });
  expect(await run.serve()).toBe(true);
  await expect(run.advise()).rejects.toThrow('no fallback or retry');
  expect(run.decisions.snapshot().closed).toBe(true);
});

test('a member that hangs past the decision deadline fails as a deadline, settled; admission stays open', async () => {
  const run = claudeDecisions({ hangOn: 'HANG', callTimeoutMs: 1_000 });
  expect(await run.serve()).toBe(true);
  await expect(run.advise('HANG here')).rejects.toThrow('no fallback or retry');
  expect(run.receipts().at(-1)).toMatchObject({ valid: false, failure: 'deadline', settled: true });
  expect(run.decisions.snapshot().closed).toBe(false);
  // The host holds the Warden again, and the next call is answered.
  expect(await run.serve()).toBe(true);
  expect((await run.advise()).content).toBe('ANS:\n## Message\nadd a route');
});

test('the host process exiting mid-decision fails the call as settled; admission stays open', async () => {
  const run = claudeDecisions({ hangOn: 'HANG' });
  expect(await run.serve()).toBe(true);
  const pending = run.advise('HANG here').then(
    () => undefined,
    (error: Error) => error.message,
  );
  for (let n = 0; !run.tree.moments.some((m) => m.includes('HANG')) && n < 500; n++)
    await Bun.sleep(5);
  run.tree.processes[0]!.crash();
  expect(await pending).toContain('no fallback or retry');
  expect(run.receipts().at(-1)).toMatchObject({
    valid: false,
    failure: 'process-lost',
    settled: true,
  });
  expect(run.decisions.snapshot().closed).toBe(false);
});

test('the Claude worker and Claude decisions hold the one login together', async () => {
  const run = claudeDecisions();
  const worker = new SubscriptionAuthentication(
    join(run.root, 'worker-auth'),
    defaultProfileSource('claude'),
    () => subscriptionStatusProcess(),
  );
  const launch = await worker.prepare('main', 'claude');
  launch.launch(['claude'], {});
  try {
    expect(await run.serve()).toBe(true);
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

test("Foundry's own folders take the harness's run kind, else foundry", () => {
  expect(foundryRunKind({})).toBe('foundry');
  expect(foundryRunKind({ ARCHIVE_RUN: 'oracle' })).toBe('oracle');
  expect(foundryRunKind({ ARCHIVE_RUN: ' test ' })).toBe('test');
  expect(foundryRunKind({ ARCHIVE_RUN: 'nonsense' })).toBe('foundry');
});
