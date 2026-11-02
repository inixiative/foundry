/**
 * @atlas
 * @kind service
 * @partOf feature:nativeAuth
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { writePrivateFile } from '../client/private-file';
import { FOUNDRY_PLUGIN_DIR } from './native-launch';

/**
 * What a main thread's Claude loads of the user's own setup (CORE-003): settings, commands, skills,
 * agents, plugins, hooks and permissions. `user` alone outside a registered project, because a
 * project's committed hooks run in headless Claude whether or not anyone trusted the folder
 * (measured on Claude 2.1.316); a registered project is one the user chose. CLAUDE.md files are a
 * separate switch (`composition.harnessLoading`, `CLAUDE_CODE_DISABLE_CLAUDE_MDS`).
 */
export type HarnessSettingSources = 'user' | 'user,project,local';

export interface HarnessSettingsLaunch {
  sources: HarnessSettingSources;
  /** The thread's working directory, whose `.claude/settings*.json` the project sources read. */
  cwd: string;
}

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** `user,project,local` inside a registered project, else `user`. */
export function harnessSettingSources(
  cwd: string,
  projectPaths: readonly string[],
): HarnessSettingSources {
  const at = real(cwd);
  const inside = projectPaths.some((path) => {
    const step = relative(real(path), at);
    return step === '' || (!step.startsWith(`..${sep}`) && step !== '..' && !step.startsWith(sep));
  });
  return inside ? 'user,project,local' : 'user';
}

/** Settings keys that hand Claude a credential other than the subscription login. */
const CREDENTIAL_SETTINGS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport'] as const;

/**
 * Blanked whatever the files say: every provider switch and every credential, endpoint or
 * identity variable Claude 2.1.316 reads (from the binary). Claude re-reads settings during a
 * session, so a key added after launch is still covered.
 */
const ALWAYS_BLANK_ENV = [
  'ANTHROPIC_API_HOST',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_AWS_AUTH',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_AWS_WORKSPACE_ID',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'ANTHROPIC_CONFIG_DIR',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_GOOGLE_CLOUD_AUTH',
  'ANTHROPIC_GOOGLE_CLOUD_BASE_URL',
  'ANTHROPIC_GOOGLE_CLOUD_PROJECT',
  'ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID',
  'ANTHROPIC_IDENTITY_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_SERVICE_ACCOUNT_ID',
  'ANTHROPIC_UNIX_SOCKET',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_WORKSPACE_ID',
  'CLAUDE_CODE_FEDERATION_CACHE_DIR',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
] as const;

/**
 * Also blanked when a loaded file sets them: keys a later Claude may add, cloud credentials, and
 * proxy and CA settings. Proxy and CA are blanked only when a file sets them, so a proxy the user
 * runs Foundry behind still works; Node reads a CA only at start, so one added later can't apply.
 */
const CREDENTIAL_ENV =
  /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_API_KEY|CLAUDE_CONFIG_DIR$|AWS_|GOOGLE_APPLICATION_CREDENTIALS$|CLOUD_ML_|VERTEX_|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|SSL_CERT_FILE$|HTTPS?_PROXY$|https?_proxy$)/;

/** The settings files Claude reads for these sources. Managed settings are the machine admin's. */
export function claudeSettingsFiles(
  configDirectory: string,
  launch: HarnessSettingsLaunch,
): string[] {
  const files = [join(configDirectory, 'settings.json')];
  if (launch.sources === 'user,project,local')
    files.push(
      join(launch.cwd, '.claude', 'settings.json'),
      join(launch.cwd, '.claude', 'settings.local.json'),
    );
  return files;
}

function envKeys(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return []; // Claude refuses an unreadable settings file itself.
  }
  const env = (parsed as { env?: unknown } | null)?.env;
  return env && typeof env === 'object' && !Array.isArray(env) ? Object.keys(env) : [];
}

/**
 * The `--settings` a subscription launch adds over the loaded files. Flag settings outrank user,
 * project and local, so a blank here wins: no loaded `apiKeyHelper` or `env` can move the thread
 * to an API key or send the login's token to another endpoint (each did, measured on 2.1.316).
 * A file that sets the subscription token itself is refused: blanking it would end the login.
 */
export function subscriptionSettingsGuard(files: readonly string[]): string {
  const blank = new Set<string>(ALWAYS_BLANK_ENV);
  for (const file of files)
    for (const key of envKeys(file)) {
      if (key === 'CLAUDE_CODE_OAUTH_TOKEN')
        throw Error(
          `Claude settings at ${file} set CLAUDE_CODE_OAUTH_TOKEN; Foundry runs this thread on its subscription login. Remove it, or turn harness settings off (composition.harnessSettings: "off").`,
        );
      if (CREDENTIAL_ENV.test(key)) blank.add(key);
    }
  return JSON.stringify({
    ...Object.fromEntries(CREDENTIAL_SETTINGS.map((key) => [key, ''])),
    env: Object.fromEntries([...blank].sort().map((key) => [key, ''])),
  });
}

/** The user's own folders, reached from a Foundry-owned home. */
// Not plugins: every Claude on the login writes its own plugin state there, so a link would
// let pool sessions rewrite the user's installed plugins. The user's plugins are not shared yet.
const USER_FOLDERS = ['commands', 'skills', 'agents', 'output-styles'] as const;

/**
 * A Kingdom pool login runs on a Foundry-owned CLAUDE_CONFIG_DIR, so `user` would read an empty
 * home. Give it the user's own setup: their settings.json as a private copy (the profile check
 * refuses a linked settings file; the guard blanks its credentials) and their folders by link.
 * A real folder found where a link goes is moved aside, kept, not deleted. Links are swapped by rename, so another thread on the login never sees a gap.
 * Nothing that holds the user's login (`.credentials.json`, the keychain entry) is reachable.
 * User-scope MCP servers (`~/.claude.json`) and plugins are not shared.
 */
export function shareUserSetup(home: string, userDirectory: string): void {
  const settings = join(userDirectory, 'settings.json');
  const copy = join(home, 'settings.json');
  if (existsSync(settings)) {
    const text = readFileSync(settings, 'utf8');
    let same = false;
    try {
      same = readFileSync(copy, 'utf8') === text;
    } catch {
      /* No copy yet. */
    }
    // Other threads on this login hold the home open: rewrite only what changed.
    if (!same) writePrivateFile(copy, text);
  } else
    try {
      unlinkSync(copy);
    } catch {
      /* Nothing to remove. */
    }
  linkUserFolders(home, userDirectory, USER_FOLDERS);
}

/**
 * Links `names` in a Foundry-owned home to the user's own folders. A real folder found where a link
 * goes is moved aside, kept, not deleted; links are swapped by rename, so another thread on the
 * home never sees a gap.
 */
function linkUserFolders(home: string, userDirectory: string, names: readonly string[]): void {
  for (const name of names) {
    const link = join(home, name);
    const target = join(userDirectory, name);
    let current: ReturnType<typeof lstatSync> | undefined;
    try {
      current = lstatSync(link);
    } catch {
      /* Missing. */
    }
    const wanted = existsSync(target);
    if (current?.isSymbolicLink() && wanted && readlinkSync(link) === target) continue;
    if (current && !current.isSymbolicLink())
      renameSync(link, `${link}.before-foundry-${Date.now()}`);
    if (!wanted) {
      if (current?.isSymbolicLink()) unlinkSync(link);
      continue;
    }
    const temporary = join(home, `.${name}-${crypto.randomUUID()}`);
    symlinkSync(target, temporary);
    renameSync(temporary, link);
  }
}

/**
 * The parts of a user's Codex `config.toml` a Foundry main thread takes (CORE-003), by allowlist:
 * their MCP servers, plugins and marketplaces, skills, tools, hooks, notify, shell policy and
 * display settings. Never their model, provider, profiles, base URLs, login settings, project
 * trust or memories, so nothing in it can move the thread off the subscription login, and
 * AGENTS.md and memories stay with Foundry's composition. Not `features` either: flags there turn
 * on memories, faster paid tiers, other identities and auth storage (codex 0.162.1). A denylist
 * could be bypassed by quoting or dotted keys; an allowlist over the parsed table cannot.
 */
const CODEX_USER_KEYS = [
  'mcp_servers',
  'plugins',
  'marketplaces',
  'skills',
  'tools',
  'hooks',
  'notify',
  'shell_environment_policy',
  'sandbox_workspace_write',
  'model_reasoning_summary',
  'model_verbosity',
  'hide_agent_reasoning',
  'show_raw_agent_reasoning',
  'file_opener',
] as const;

/**
 * Env an MCP server must not get from the user's config: it would point the server at the user's
 * own Codex home and login (the ChatGPT app's `node_repl` sets `CODEX_HOME=~/.codex`), so a pool
 * run's tools would bill the user's personal login.
 */
const MCP_LOGIN_ENV = /^(CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_CONFIG_DIR$|CLAUDE_CODE_OAUTH_TOKEN$)/;

function withoutLoginEnv(servers: unknown): unknown {
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return servers;
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      const env = (server as { env?: unknown } | null)?.env;
      if (!env || typeof env !== 'object' || Array.isArray(env)) return [name, server];
      return [
        name,
        {
          ...(server as Record<string, unknown>),
          env: Object.fromEntries(Object.entries(env).filter(([key]) => !MCP_LOGIN_ENV.test(key))),
        },
      ];
    }),
  );
}

/** Codex folders shared from the user's home: their skills, execpolicy rules and prompts. */
const CODEX_USER_FOLDERS = ['rules', 'prompts'] as const;

const tomlKey = (key: string) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key));

function tomlValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'nan';
    if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
    return String(value);
  }
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  if (value && typeof value === 'object')
    return `{ ${Object.entries(value)
      .map(([key, inner]) => `${tomlKey(key)} = ${tomlValue(inner)}`)
      .join(', ')} }`;
  throw Error('Unsupported value in Codex config.toml');
}

/** One `key = value` line, kept only when it reads back as the same value (a TOML date doesn't). */
function tomlLine(key: string, value: unknown): string | undefined {
  try {
    const line = `${key} = ${tomlValue(value)}\n`;
    const back = (Bun.TOML.parse(line) as Record<string, unknown>)[key];
    return Bun.deepEquals(back, value) ? line : undefined;
  } catch {
    return undefined;
  }
}

/** Tables whose entries stand alone: one entry that can't be written back drops only itself. */
const CODEX_PER_ENTRY = new Set<string>(['mcp_servers', 'plugins', 'marketplaces']);

/**
 * The allowlisted part of the user's Codex config.toml, as TOML lines; empty when there is none.
 * A value that can't be written back unchanged (a TOML date, `-0`) is left out, never written
 * altered: one MCP server, plugin or marketplace entry at a time, any other key whole. Each drop,
 * and a config Bun can't read, is reported through `warn`.
 */
export function codexUserConfig(
  userDirectory: string,
  warn: (message: string) => void = console.warn,
): string {
  const file = join(userDirectory, 'config.toml');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return ''; // No config: nothing to take.
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (error) {
    warn(`[Codex] ${file} could not be read (${(error as Error).message}); none of it is loaded`);
    return '';
  }
  const lines: string[] = [];
  for (const key of CODEX_USER_KEYS) {
    if (!(key in parsed)) continue;
    let value = key === 'mcp_servers' ? withoutLoginEnv(parsed[key]) : parsed[key];
    if (CODEX_PER_ENTRY.has(key) && value && typeof value === 'object' && !Array.isArray(value))
      value = Object.fromEntries(
        Object.entries(value).filter(([name, entry]) => {
          if (tomlLine('entry', entry)) return true;
          warn(`[Codex] ${key}.${name} in ${file} can't be carried over unchanged; left out`);
          return false;
        }),
      );
    const line = tomlLine(key, value);
    if (line) lines.push(line);
    else warn(`[Codex] ${key} in ${file} can't be carried over unchanged; left out`);
  }
  return lines.join('');
}

/**
 * A Foundry-owned CODEX_HOME for a main thread: the user's rules and prompts by link, and a skills
 * folder holding the user's own skills (one link each) beside Foundry's (`foundry-<name>`, from the
 * plugin Claude loads with `--plugin-dir`), so a Codex thread learns Foundry's tools the same way.
 */
export function shareCodexUserSetup(
  home: string,
  userDirectory: string,
  foundrySkills: string = join(FOUNDRY_PLUGIN_DIR, 'skills'),
): void {
  linkUserFolders(home, userDirectory, CODEX_USER_FOLDERS);
  composeSkills(join(home, 'skills'), join(userDirectory, 'skills'), foundrySkills);
}

const present = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** `folder` as a real directory of links: each of the user's skills, then each of Foundry's as `foundry-<name>`. */
function composeSkills(folder: string, userSkills: string, foundrySkills: string): void {
  const entries = (dir: string) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  let current: ReturnType<typeof lstatSync> | undefined;
  try {
    current = lstatSync(folder);
  } catch {
    /* Missing. */
  }
  // An earlier home linked the whole folder to the user's: replace the link, never the user's folder.
  if (current?.isSymbolicLink()) unlinkSync(folder);
  mkdirSync(folder, { recursive: true });
  const wanted = new Map<string, string>([
    ...entries(userSkills)
      .filter((name) => !name.startsWith('.') && !name.startsWith('foundry-'))
      .map((name) => [name, join(userSkills, name)] as const),
    ...entries(foundrySkills).map(
      (name) => [`foundry-${name}`, join(foundrySkills, name)] as const,
    ),
  ]);
  for (const name of entries(folder)) {
    const path = join(folder, name);
    if (!lstatSync(path).isSymbolicLink()) continue;
    if (wanted.get(name) !== readlinkSync(path)) unlinkSync(path);
  }
  for (const [name, target] of wanted) {
    const link = join(folder, name);
    // Kept above when it already points at its target; anything else there is the user's to keep.
    if (present(link)) continue;
    const temporary = join(folder, `.${name}-${crypto.randomUUID()}`);
    symlinkSync(target, temporary);
    renameSync(temporary, link);
  }
}
