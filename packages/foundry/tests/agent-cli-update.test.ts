// Agent-CLI upgrades at daemon start: every command, locate and login check is injected, so
// nothing here reaches the network or moves a real CLI.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentCliReport,
  type AgentCliUpdateOptions,
  readAgentCliReport,
  updateAgentClis,
} from '../src/daemon/agent-cli-update';
import type { Install } from '../src/daemon/agent-clis';
import { validateDaemonSettings } from '../src/daemon/settings';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const undo of cleanup.splice(0)) undo();
});

const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const install = (binary: string, version: string): Install => ({
  binary,
  version: version.split('.').map(Number),
});

const of = (report: AgentCliReport, cli: string) => report.clis.find((entry) => entry.cli === cli);

/** A machine whose CLIs move when their update command runs. */
function machine(versions: Record<string, { binary: string; version: string; next?: string }>) {
  const state = structuredClone(versions);
  const runs: Array<{ argv: string[]; env: Record<string, string | undefined> }> = [];
  const logins: string[] = [];
  const options: Partial<AgentCliUpdateOptions> = {
    env: {
      PATH: '/usr/bin',
      HOME: '/home/me',
      DISABLE_AUTOUPDATER: '1',
      MUSE_NO_AUTO_UPDATE: '1',
      ANTHROPIC_API_KEY: 'secret',
    },
    locate: async () =>
      new Map(Object.entries(state).map(([cli, v]) => [cli, install(v.binary, v.version)])),
    run: async (argv, env) => {
      runs.push({ argv, env });
      const cli = Object.keys(state).find((name) => state[name]!.binary === argv[0]);
      if (cli && state[cli]!.next) state[cli]!.version = state[cli]!.next!;
      return { exitCode: 0, output: '' };
    },
    signedIn: async (cli) => {
      logins.push(cli);
      return true;
    },
    pinned: { muse: '1.4.20' },
    isMuseLauncher: async () => true,
  };
  return { state, runs, logins, options };
}

test('Claude and Codex run their own update where they were found; versions and logins are read again', async () => {
  const configDir = tempDir('agent-clis-');
  const m = machine({
    claude: { binary: '/home/me/.local/bin/claude', version: '2.1.325', next: '2.1.330' },
    codex: { binary: '/home/me/.bun/bin/codex', version: '0.169.0' },
    muse: { binary: '/home/me/.local/bin/muse', version: '1.4.20' },
  });
  const lines: string[] = [];
  const report = await updateAgentClis({
    ...m.options,
    updates: true,
    configDir,
    log: (line) => lines.push(line),
  });
  expect(m.runs.map((run) => run.argv)).toEqual([
    ['/home/me/.local/bin/claude', 'update'],
    ['/home/me/.bun/bin/codex', 'update'],
  ]);
  // The CLIs' own updaters are allowed; competing credentials never reach an upgrade.
  for (const { env } of m.runs) {
    expect(env.DISABLE_AUTOUPDATER).toBeUndefined();
    expect(env.MUSE_NO_AUTO_UPDATE).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  }
  expect(report.clis).toEqual([
    {
      cli: 'claude',
      binary: '/home/me/.local/bin/claude',
      before: '2.1.325',
      after: '2.1.330',
      outcome: 'updated',
      signedIn: true,
    },
    {
      cli: 'codex',
      binary: '/home/me/.bun/bin/codex',
      before: '0.169.0',
      after: '0.169.0',
      outcome: 'current',
      signedIn: true,
    },
    { cli: 'muse', binary: '/home/me/.local/bin/muse', before: '1.4.20', outcome: 'current' },
  ]);
  expect(m.logins).toEqual(['claude', 'codex']);
  expect(lines).toContain('claude updated 2.1.325 → 2.1.330; signed in');
  expect(await readAgentCliReport(configDir)).toEqual(report);
});

test('off by default: nothing is upgraded and no login is checked', async () => {
  const configDir = tempDir('agent-clis-');
  const m = machine({
    claude: { binary: '/home/me/.local/bin/claude', version: '2.1.325', next: '2.1.330' },
  });
  const report = await updateAgentClis({ ...m.options, updates: false, configDir });
  expect(m.runs).toEqual([]);
  expect(m.logins).toEqual([]);
  expect(report).toMatchObject({ updates: false, clis: [] });
});

test('a failed upgrade and a lost login are reported, not swallowed', async () => {
  const configDir = tempDir('agent-clis-');
  const m = machine({
    claude: { binary: '/home/me/.local/bin/claude', version: '2.1.325' },
    codex: { binary: '/home/me/.bun/bin/codex', version: '0.169.0' },
  });
  const report = await updateAgentClis({
    ...m.options,
    updates: true,
    configDir,
    run: async (argv) =>
      argv[0]!.endsWith('claude')
        ? { exitCode: 1, output: `${'x'.repeat(600)}network unreachable\n` }
        : { exitCode: 0, output: '' },
    signedIn: async (cli) => cli !== 'codex',
  });
  const [claude, codex] = report.clis;
  expect(claude).toMatchObject({ cli: 'claude', outcome: 'failed', signedIn: true });
  expect(claude!.detail!.endsWith('network unreachable')).toBe(true);
  expect(claude!.detail!.length).toBeLessThanOrEqual(401);
  expect(codex).toMatchObject({ cli: 'codex', outcome: 'current', signedIn: false });
});

test('an app-bundled CLI is left to its app', async () => {
  const configDir = tempDir('agent-clis-');
  const m = machine({
    codex: { binary: '/Applications/Codex.app/Contents/Resources/codex', version: '0.169.0' },
  });
  const report = await updateAgentClis({ ...m.options, updates: true, configDir });
  expect(m.runs).toEqual([]);
  expect(of(report, 'codex')).toMatchObject({
    outcome: 'not-updated',
    detail: 'its app updates it',
  });
});

test('Muse Code moves only to the pinned version, and never past it', async () => {
  // Below the pin with Meta's launcher: its install runs, and the result is checked against the pin.
  const below = machine({
    muse: { binary: '/home/me/.local/bin/muse', version: '1.4.18', next: '1.4.20' },
  });
  const moved = await updateAgentClis({
    ...below.options,
    updates: true,
    configDir: tempDir('agent-clis-'),
  });
  expect(below.runs.map((run) => run.argv)).toEqual([['/home/me/.local/bin/muse']]);
  expect(below.runs[0]!.env.MUSE_LAUNCHER_INSTALL).toBe('1');
  expect(below.runs[0]!.env.MUSE_NO_AUTO_UPDATE).toBeUndefined();
  expect(of(moved, 'muse')).toMatchObject({
    before: '1.4.18',
    after: '1.4.20',
    outcome: 'updated',
  });

  // The launcher only installs its channel's newest: past the pin is a failure, said plainly.
  const overshoot = machine({
    muse: { binary: '/home/me/.local/bin/muse', version: '1.4.18', next: '1.4.22' },
  });
  const past = await updateAgentClis({
    ...overshoot.options,
    updates: true,
    configDir: tempDir('agent-clis-'),
  });
  expect(of(past, 'muse')).toMatchObject({ outcome: 'failed', after: '1.4.22' });
  expect(of(past, 'muse')?.detail).toContain('1.4.20');

  // Above the pin: the launcher cannot go back, so nothing runs.
  const above = machine({ muse: { binary: '/home/me/.local/bin/muse', version: '1.4.22' } });
  const kept = await updateAgentClis({
    ...above.options,
    updates: true,
    configDir: tempDir('agent-clis-'),
  });
  expect(above.runs).toEqual([]);
  expect(of(kept, 'muse')).toMatchObject({ outcome: 'not-updated' });

  // Not Meta's launcher: nothing to run it with.
  const other = machine({ muse: { binary: '/opt/muse', version: '1.4.18' } });
  const unmanaged = await updateAgentClis({
    ...other.options,
    updates: true,
    configDir: tempDir('agent-clis-'),
    isMuseLauncher: async () => false,
  });
  expect(other.runs).toEqual([]);
  expect(of(unmanaged, 'muse')).toMatchObject({
    outcome: 'not-updated',
    detail: 'install muse 1.4.20',
  });
});

test('cassettes recorded on an older CLI than the installed one are flagged for re-recording', async () => {
  const fixturesDir = tempDir('agent-clis-vcr-');
  writeFileSync(
    join(fixturesDir, 'policy.json'),
    JSON.stringify({ maxAgeDays: 14, blessed: { claude: '2.1.300', codex: '0.169.0' } }),
  );
  mkdirSync(join(fixturesDir, 'claude'));
  const recordedAt = new Date().toISOString();
  for (const name of ['one', 'two'])
    writeFileSync(
      join(fixturesDir, 'claude', `${name}.json`),
      JSON.stringify({ version: '2.1.325', recorded: { recordedAt, cli: 'claude' } }),
    );
  writeFileSync(
    join(fixturesDir, 'claude', 'old.json'),
    JSON.stringify({ version: '2.1.330', recorded: { recordedAt, cli: 'claude' } }),
  );
  const m = machine({
    claude: { binary: '/home/me/.local/bin/claude', version: '2.1.325', next: '2.1.330' },
  });
  const report = await updateAgentClis({
    ...m.options,
    updates: true,
    configDir: tempDir('agent-clis-'),
    fixturesDir,
  });
  expect(report.reRecord).toEqual([{ cli: 'claude', installed: '2.1.330', cassettes: 2 }]);

  // A release without the cassettes' policy has nothing to compare.
  const bare = await updateAgentClis({
    ...m.options,
    updates: false,
    configDir: tempDir('agent-clis-'),
    fixturesDir: tempDir('agent-clis-none-'),
  });
  expect(bare.reRecord).toEqual([]);
});

test('daemon settings: known fields only, each of its type', () => {
  expect(() =>
    validateDaemonSettings('daemon', {
      autoUpdate: 'apply',
      updateAgentClis: true,
      updateCheckSeconds: 300,
      drainTimeoutSeconds: 3600,
      bootTimeoutSeconds: 0,
    }),
  ).not.toThrow();
  expect(() => validateDaemonSettings('daemon', undefined)).not.toThrow();
  expect(() => validateDaemonSettings('daemon', { updateAgentClis: 'yes' })).toThrow(
    'daemon.updateAgentClis must be a boolean',
  );
  expect(() => validateDaemonSettings('daemon', { autoUpdate: 'always' })).toThrow(
    'daemon.autoUpdate must be off, check or apply',
  );
  expect(() => validateDaemonSettings('daemon', { updateCheckSeconds: -1 })).toThrow(
    'daemon.updateCheckSeconds must be a whole number of seconds',
  );
  expect(() => validateDaemonSettings('daemon', { upgradeClis: true })).toThrow(
    'daemon: unknown field upgradeClis',
  );
  expect(() => validateDaemonSettings('daemon', [])).toThrow('daemon must be an object');
});
