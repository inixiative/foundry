import { $ } from "bun";

export const SYSTEM_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
export const AGENT_CLIS = ["claude", "codex"] as const;

export type Install = { binary: string; version: number[] };

const directoryOf = (binary: string) => binary.replace(/\/[^/]+$/, "");

const newer = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
};

// Native, Homebrew, npm, bun and nvm installs can coexist; PATH order says nothing about which is current.
export const installLocations = async (command: string, home: string, searchPath = process.env.PATH ?? "") => {
  const npmGlobal = (await $`npm prefix -g`.quiet().nothrow().text()).trim();
  const nvm = await Array.fromAsync(new Bun.Glob(`.nvm/versions/node/*/bin/${command}`).scan({ cwd: home, absolute: true, onlyFiles: false }));
  const onPath = (await $`which -a ${command}`.env({ PATH: searchPath }).quiet().nothrow().text()).split("\n").map(line => line.trim()).filter(Boolean);
  const known = [`${home}/.local/bin/${command}`, `${home}/.claude/local/${command}`, `/opt/homebrew/bin/${command}`, `/usr/local/bin/${command}`,
    ...(npmGlobal ? [`${npmGlobal}/bin/${command}`] : []), `${home}/.bun/bin/${command}`, ...nvm];
  const found: string[] = [];
  for (const binary of new Set([...onPath, ...known])) if (await Bun.file(binary).exists()) found.push(binary);
  return found;
};

// launchd starts with an empty environment, so each CLI must run under the exact PATH the plist will carry.
const versionUnder = async (binary: string, pathEntries: string[], home: string) => {
  const run = await $`/usr/bin/env ${binary} --version`.env({ HOME: home, PATH: pathEntries.join(":") }).quiet().nothrow();
  const match = run.exitCode === 0 ? /(\d+)\.(\d+)\.(\d+)/.exec(run.stdout.toString()) : null;
  return match ? match.slice(1).map(Number) : undefined;
};

export const newestInstall = async (command: string, home: string, pathFor: (directory: string) => string[]) => {
  let best: Install | undefined;
  for (const binary of await installLocations(command, home)) {
    const version = await versionUnder(binary, pathFor(directoryOf(binary)), home);
    if (version && (!best || newer(version, best.version))) best = { binary, version };
  }
  return best;
};

export const resolveDaemonPath = async (bunPath: string, home: string, systemPath: string[] = SYSTEM_PATH) => {
  const base = [directoryOf(bunPath), ...systemPath];
  const node = await newestInstall("node", home, directory => [directory, ...base]);
  const runtime = [...(node ? [directoryOf(node.binary)] : []), ...base];
  const resolved = new Map<string, Install>();
  for (const cli of AGENT_CLIS) {
    const install = await newestInstall(cli, home, directory => [directory, ...runtime]);
    if (install) resolved.set(cli, install);
  }
  const pathEntries = [...new Set([...[...resolved.values()].map(install => directoryOf(install.binary)), ...runtime])];
  const missing: string[] = [];
  for (const cli of AGENT_CLIS) {
    const chosen = resolved.get(cli);
    const onDaemonPath = (await $`/usr/bin/env which ${cli}`.env({ HOME: home, PATH: pathEntries.join(":") }).quiet().nothrow().text()).trim();
    if (!chosen || onDaemonPath !== chosen.binary) missing.push(cli);
  }
  return { pathEntries, resolved, missing };
};

