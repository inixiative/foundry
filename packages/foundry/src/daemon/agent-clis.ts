/**
 * @atlas
 * @kind helper
 * @partOf feature:daemon
 */
import { $ } from 'bun';

export const SYSTEM_PATH = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];
export const AGENT_CLIS = ['claude', 'codex'] as const;

export type Install = { binary: string; version: number[] };

const directoryOf = (binary: string) => binary.replace(/\/[^/]+$/, '');

const newer = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
};

/** `which` against an explicit PATH: Bun resolves a bare command against the PATH it started
 * with, not against later edits to `process.env.PATH`. */
export const whichOn = (command: string, searchPath = process.env.PATH ?? '') =>
  Bun.which(command, { PATH: searchPath });

/**
 * CLIs that ship inside a macOS app instead of on PATH, as globs under a root. The Codex desktop
 * app carries the codex CLI in its Resources; the Claude desktop app keeps the Claude Code it
 * manages under Application Support, one directory per version.
 */
const appBundled = (command: string, home: string): Array<{ root: string; pattern: string }> => {
  if (command === 'codex')
    return ['/Applications', `${home}/Applications`].map((root) => ({
      root,
      pattern: 'Codex.app/Contents/Resources/codex',
    }));
  if (command === 'claude')
    return [
      {
        root: `${home}/Library/Application Support/Claude/claude-code`,
        pattern: '*/claude.app/Contents/MacOS/claude',
      },
    ];
  return [];
};

/** A binary inside an app bundle shares its directory with the app's other tools. */
const inAppBundle = (binary: string) => binary.includes('.app/Contents/');

export const installLocations = async (
  command: string,
  home: string,
  searchPath = process.env.PATH ?? '',
) => {
  const npmGlobal = (await $`npm prefix -g`.quiet().nothrow().text()).trim();
  const nvm = await Array.fromAsync(
    new Bun.Glob(`.nvm/versions/node/*/bin/${command}`).scan({
      cwd: home,
      absolute: true,
      onlyFiles: false,
    }),
  );
  const bundled: string[] = [];
  for (const { root, pattern } of appBundled(command, home))
    try {
      bundled.push(
        ...(await Array.fromAsync(
          new Bun.Glob(pattern).scan({ cwd: root, absolute: true, onlyFiles: false }),
        )),
      );
    } catch {
      // The app is not installed, so its root does not exist.
    }
  const onPath = (await $`which -a ${command}`.env({ PATH: searchPath }).quiet().nothrow().text())
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const known = [
    `${home}/.local/bin/${command}`,
    `${home}/.claude/local/${command}`,
    `/opt/homebrew/bin/${command}`,
    `/usr/local/bin/${command}`,
    ...(npmGlobal ? [`${npmGlobal}/bin/${command}`] : []),
    `${home}/.bun/bin/${command}`,
    ...nvm,
    ...bundled,
  ];
  const found: string[] = [];
  for (const binary of new Set([...onPath, ...known]))
    if (await Bun.file(binary).exists()) found.push(binary);
  return found;
};

const versionUnder = async (binary: string, pathEntries: string[], home: string) => {
  const run = await $`/usr/bin/env ${binary} --version`
    .env({ HOME: home, PATH: pathEntries.join(':') })
    .quiet()
    .nothrow();
  const match = run.exitCode === 0 ? /(\d+)\.(\d+)\.(\d+)/.exec(run.stdout.toString()) : null;
  return match ? match.slice(1).map(Number) : undefined;
};

export const newestInstall = async (
  command: string,
  home: string,
  pathFor: (directory: string) => string[],
) => {
  let best: Install | undefined;
  for (const binary of await installLocations(command, home)) {
    const version = await versionUnder(binary, pathFor(directoryOf(binary)), home);
    if (!version) continue;
    // On a tie a standalone install beats an app's copy (or an app's wrapper around one).
    const tie = best && !newer(best.version, version) && !newer(version, best.version);
    if (
      !best ||
      newer(version, best.version) ||
      (tie && inAppBundle(best.binary) && !inAppBundle(binary))
    )
      best = { binary, version };
  }
  return best;
};

/**
 * The agent CLIs this process launches: the one already on `env.PATH` when it works, else the
 * newest working install found anywhere, an app bundle included. Every native launch spawns the
 * bare command with an environment built from `process.env`, so a CLI found off PATH has its
 * directory added to `env.PATH`: appended, so an app bundle's other tools never shadow the
 * system's, or prepended when a broken install is in the way. A CLI with no working install is
 * absent from the result.
 */
export const ensureAgentClisOnPath = async (
  clis: readonly string[] = AGENT_CLIS,
  env: Record<string, string | undefined> = process.env,
  home = env.HOME ?? '',
) => {
  const resolved = new Map<string, Install>();
  for (const cli of clis) {
    const entries = (env.PATH ?? '').split(':').filter(Boolean);
    const current = whichOn(cli, entries.join(':'));
    const version = current ? await versionUnder(current, entries, home) : undefined;
    if (current && version) {
      resolved.set(cli, { binary: current, version });
      continue;
    }
    const install = await newestInstall(cli, home, (directory) => [directory, ...entries]);
    if (!install) continue;
    resolved.set(cli, install);
    const directory = directoryOf(install.binary);
    env.PATH = (current ? [directory, ...entries] : [...entries, directory]).join(':');
  }
  return resolved;
};

export const resolveDaemonPath = async (
  bunPath: string,
  home: string,
  systemPath: string[] = SYSTEM_PATH,
) => {
  const base = [directoryOf(bunPath), ...systemPath];
  const node = await newestInstall('node', home, (directory) => [directory, ...base]);
  const runtime = [...(node ? [directoryOf(node.binary)] : []), ...base];
  const resolved = new Map<string, Install>();
  for (const cli of AGENT_CLIS) {
    const install = await newestInstall(cli, home, (directory) => [directory, ...runtime]);
    if (install) resolved.set(cli, install);
  }
  const whichUnder = async (cli: string, entries: string[]) =>
    (
      await $`/usr/bin/env which ${cli}`
        .env({ HOME: home, PATH: entries.join(':') })
        .quiet()
        .nothrow()
        .text()
    ).trim();
  // An app bundle's directory goes after the system's, so its other tools (Codex ships `rg`)
  // never shadow them; it moves to the front only when another install would shadow its CLI.
  const installs = [...resolved.entries()];
  const front = installs.filter(([, i]) => !inAppBundle(i.binary)).map(([, i]) => i.binary);
  const bundled = installs.filter(([, i]) => inAppBundle(i.binary));
  const order = () => [
    ...new Set([
      ...front.map(directoryOf),
      ...runtime,
      ...bundled.map(([, i]) => directoryOf(i.binary)),
    ]),
  ];
  for (const [cli, install] of bundled)
    if ((await whichUnder(cli, order())) !== install.binary) front.unshift(install.binary);
  const pathEntries = order();
  const missing: string[] = [];
  for (const cli of AGENT_CLIS) {
    const chosen = resolved.get(cli);
    if (!chosen || (await whichUnder(cli, pathEntries)) !== chosen.binary) missing.push(cli);
  }
  return { pathEntries, resolved, missing };
};
