/**
 * @atlas
 * @kind config
 * @partOf feature:acp
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { acpLaunchPath, readAcpLaunch, startDaemon } from '@inixiative/foundry/client';
import {
  DAEMON_LOG_DIR,
  daemonLoaded,
  enabledPrefilter,
  ensureStarterSettings,
  installDaemon,
  installedDaemon,
  installPrefilterModel,
  prefilterInstalled,
  WardenPrefilter,
} from '@inixiative/foundry/daemon';
import { runRepeats } from '@inixiative/foundry/repeats';
import { $ } from 'bun';
import packageJson from '../package.json' with { type: 'json' };

export const SETUP_USAGE = `foundry-acp setup [--write] [--yes] [--reinstall] [--no-repeats]

Installs Foundry on this Mac and points your ACP hosts at it:
  1. installs @inixiative/foundry-acp globally (bun), so hosts and launchd have a stable path;
  2. installs and starts the Foundry daemon (a launchd agent; macOS only); when its settings turn
     the Warden pre-filter on (\`prefilter.enabled\`, off by default), first installs its model
     (Kev, about 9 GB, under ~/.foundry/models; needs uv), which the daemon serves;
  3. shows the Paseo and T3 Code provider settings, and writes Paseo's with --write or your yes;
  4. runs \`foundry repeats\`: the corrections you keep giving your agents.

  --write        write ~/.paseo/config.json without asking
  --yes          answer yes to every question (installs, writes)
  --reinstall    replace an installed daemon that runs from somewhere else
  --no-repeats   skip the repeat report`;

const PORT = 4500;
const ok = (message: string) => console.log(`✓ ${message}`);
const info = (message: string) => console.log(`  ${message}`);
const warn = (message: string) => console.log(`! ${message}`);

/** The Foundry checkout this package runs from, when it is one (development), else undefined. */
function checkoutRoot(packageDir: string): string | undefined {
  const root = resolve(packageDir, '..', '..');
  return existsSync(join(root, 'scripts', 'daemon', 'supervisor.ts')) &&
    existsSync(join(root, '.git'))
    ? root
    : undefined;
}

async function ask(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim());
  } finally {
    prompt.close();
  }
}

/** The global bun install of this version; installs it when this run comes from a bunx cache. */
async function stablePackageDir(packageDir: string, yes: boolean): Promise<string> {
  const globalDir = join(
    process.env.BUN_INSTALL ?? join(homedir(), '.bun'),
    'install',
    'global',
    'node_modules',
    '@inixiative',
    'foundry-acp',
  );
  const installed = existsSync(join(globalDir, 'package.json'))
    ? (JSON.parse(readFileSync(join(globalDir, 'package.json'), 'utf8')) as { version?: string })
        .version
    : undefined;
  if (realpathSync(packageDir) === (existsSync(globalDir) ? realpathSync(globalDir) : ''))
    return globalDir;
  if (installed === packageJson.version) return globalDir;
  const spec = `@inixiative/foundry-acp@${packageJson.version}`;
  if (
    !(await ask(
      `Install ${spec} globally with bun (gives you \`foundry\` and \`foundry-acp\`)?`,
      yes,
    ))
  )
    throw Error(`Setup needs a stable install for hosts and launchd: run \`bun add -g ${spec}\``);
  const added = await $`bun add -g ${spec}`.nothrow();
  if (added.exitCode !== 0) throw Error(`bun add -g ${spec} failed`);
  ok(`installed ${spec} (${globalDir})`);
  return globalDir;
}

/** A bun path that survives upgrades (Homebrew's Cellar path does not): bun's own, else the one on PATH. */
function stableBun(): string {
  const own = join(process.env.BUN_INSTALL ?? join(homedir(), '.bun'), 'bin', 'bun');
  return existsSync(own) ? own : (Bun.which('bun') ?? process.execPath);
}

/** Where `@inixiative/foundry` resolves from the given foundry-acp install. */
function foundryDir(acpDir: string): string {
  return dirname(dirname(Bun.resolveSync('@inixiative/foundry', acpDir)));
}

async function daemonAnswers(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const launch = readAcpLaunch(acpLaunchPath());
      const response = await fetch(`${launch.endpoint}/api/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status < 500) return true;
    } catch {}
    await Bun.sleep(1_000);
  }
  return false;
}

/** Paseo's provider block; `command` runs this install with bun directly, since hosts start with a bare PATH. */
export function paseoProvider(command: string[]) {
  return { extends: 'acp', label: 'Foundry', command };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The Foundry provider already in a Paseo config, if any. */
function paseoFoundry(config: unknown): unknown {
  return isRecord(config) && isRecord(config.agents) && isRecord(config.agents.providers)
    ? config.agents.providers.foundry
    : undefined;
}

/** Paseo's config with the Foundry provider set; refuses shapes it would have to overwrite. */
export function mergePaseoConfig(existing: unknown, command: string[]) {
  if (existing !== undefined && !isRecord(existing))
    throw Error('The Paseo config is not a JSON object; add the block by hand');
  const config: Record<string, unknown> = structuredClone(existing ?? {});
  const agents = config.agents ?? {};
  if (!isRecord(agents)) throw Error('Paseo `agents` is not an object; add the block by hand');
  const providers = agents.providers ?? {};
  if (!isRecord(providers))
    throw Error('Paseo `agents.providers` is not an object; add the block by hand');
  config.agents = { ...agents, providers: { ...providers, foundry: paseoProvider(command) } };
  return config;
}

export async function runSetup(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      write: { type: 'boolean' },
      yes: { type: 'boolean' },
      reinstall: { type: 'boolean' },
      'no-repeats': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(SETUP_USAGE);
    return 0;
  }
  const yes = Boolean(values.yes);
  const packageDir = resolve(import.meta.dir, '..');
  const bun = stableBun();

  // 1. A stable install: the checkout in development, else the global bun install.
  const checkout = checkoutRoot(packageDir);
  const acpDir = checkout ? packageDir : await stablePackageDir(packageDir, yes);
  const acpCommand = [bun, join(acpDir, 'src', 'cli.ts')];
  if (checkout) ok(`using the Foundry checkout at ${checkout}`);

  // 2. The daemon.
  if (process.platform !== 'darwin') {
    warn(
      'The Foundry daemon is a launchd agent, so this platform is not supported yet (macOS only). Skipping it.',
    );
  } else {
    const workingDirectory = checkout ?? join(homedir(), '.foundry', 'home');
    const installed = installedDaemon();
    const program = checkout
      ? undefined
      : [bun, 'run', join(foundryDir(acpDir), 'src', 'start.ts')];
    const elsewhere =
      installed &&
      (!installed.readable || resolve(installed.workingDirectory) !== resolve(workingDirectory));
    const current =
      installed?.readable &&
      !elsewhere &&
      (!program || installed.program.join('\0') === program.join('\0')) &&
      (await daemonLoaded());
    // The Warden pre-filter's model, opt-in: only when the daemon's settings turn it on, and before
    // the daemon that serves it. Off (the default), nothing is downloaded and every Warden is asked.
    const settingsHome =
      elsewhere && !values.reinstall && installed.readable
        ? installed.workingDirectory
        : workingDirectory;
    const prefilter = await enabledPrefilter(settingsHome);
    let modelAdded = false,
      daemonInstalled = false;
    if (prefilter) {
      if (prefilterInstalled()) ok('the Warden pre-filter model is installed');
      else {
        info('installing the Warden pre-filter model (Kev, about 9 GB, under ~/.foundry/models)');
        const model = await installPrefilterModel(info);
        modelAdded = model.ok;
        if (model.ok) ok('installed the Warden pre-filter model');
        else
          warn(
            `the Warden pre-filter model was not installed (${model.reason}); Foundry asks every Warden until it is. Rerun setup to retry.`,
          );
      }
    }
    if (elsewhere && !values.reinstall) {
      ok(
        `a Foundry daemon is already installed${installed.readable ? `, running from ${installed.workingDirectory}` : ` (${installed.plistPath})`}`,
      );
      info('foundry-acp connects to whichever daemon is running; pass --reinstall to replace it');
      if (!(await daemonLoaded())) await startDaemon();
    } else if (current && !values.reinstall) {
      // Reinstalling restarts the daemon and ends its live sessions: only on request.
      ok('the Foundry daemon is installed and running; pass --reinstall to restart it');
    } else {
      if (!checkout && (await ensureStarterSettings(workingDirectory)))
        ok(`wrote starter settings in ${join(workingDirectory, '.foundry')}`);
      const claude = await $`claude auth status --json`.quiet().nothrow();
      if (claude.exitCode !== 0)
        warn(
          '`claude auth status` failed: log in with `claude` first; Foundry runs on your Claude login.',
        );
      await installDaemon({
        workingDirectory,
        ...(program ? { program } : {}),
        port: PORT,
        log: info,
      });
      daemonInstalled = true;
      ok(`daemon installed (logs: ${DAEMON_LOG_DIR}/foundry.out.log)`);
    }
    if (await daemonAnswers(60_000)) ok(`daemon answering — viewer at http://localhost:${PORT}`);
    else warn(`the daemon did not answer within a minute; see ${DAEMON_LOG_DIR}/foundry.err.log`);
    if (prefilter && prefilterInstalled()) {
      const health = await new WardenPrefilter(prefilter).waitReady(
        modelAdded && !daemonInstalled ? 0 : 120_000,
      );
      if (health.ok) ok('the Warden pre-filter answers');
      else
        warn(
          `the Warden pre-filter did not answer (${health.reason}); every Warden is asked. The daemon serves it from its start: pass --reinstall to restart it.`,
        );
    }
  }

  // 3. Hosts.
  const paseoPath = join(process.env.PASEO_HOME ?? join(homedir(), '.paseo'), 'config.json');
  const block = { agents: { providers: { foundry: paseoProvider(acpCommand) } } };
  console.log(`\nPaseo (${paseoPath}):\n${JSON.stringify(block, null, 2)}`);
  let existing: unknown;
  if (existsSync(paseoPath)) {
    try {
      existing = JSON.parse(readFileSync(paseoPath, 'utf8'));
    } catch {
      throw Error(`${paseoPath} is not valid JSON; add the block above by hand`);
    }
  }
  const previous = paseoFoundry(existing);
  if (previous && JSON.stringify(previous) !== JSON.stringify(paseoProvider(acpCommand)))
    warn(
      `${paseoPath} already has a different Foundry provider:\n${JSON.stringify(previous, null, 2)}`,
    );
  if (values.write || (await ask(`Write this provider to ${paseoPath}?`, yes))) {
    const merged = mergePaseoConfig(existing, acpCommand);
    let backup: string | undefined;
    if (existsSync(paseoPath)) {
      backup = `${paseoPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      copyFileSync(paseoPath, backup);
    }
    mkdirSync(dirname(paseoPath), { recursive: true });
    writeFileSync(paseoPath, `${JSON.stringify(merged, null, 2)}\n`);
    ok(`wrote ${paseoPath}${backup ? ` (previous copy: ${backup})` : ''}`);
  } else info('not written; paste the block above, or rerun with --write');
  console.log(
    [
      '',
      'T3 Code: Settings → Providers → Add provider → Local ACP command',
      `  Executable: ${acpCommand[0]}`,
      `  Argument:   ${acpCommand[1]}`,
      '  Name:       Foundry',
      '',
      'Either host: add `--permission-mode <default|acceptEdits|plan|bypassPermissions>` after the path for a default mode.',
    ].join('\n'),
  );

  // 4. The aha.
  if (!values['no-repeats']) {
    console.log('\nThe corrections you keep giving your agents (foundry repeats):\n');
    try {
      await runRepeats([]);
    } catch (error) {
      warn(`the repeat report could not run: ${(error as Error).message}`);
      info('run it later with `foundry repeats`');
    }
  }
  return 0;
}
