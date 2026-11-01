/**
 * @atlas
 * @kind service
 * @partOf feature:nativeAuth
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { writePrivateFile } from '../client/private-file';

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

/** Blanked whatever the files say: a file may change between Foundry's read and Claude's. */
const ALWAYS_BLANK_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
] as const;

/** Env a settings file may set that changes who is billed or where the login's token is sent. */
const CREDENTIAL_ENV =
  /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_API_KEY|CLAUDE_CONFIG_DIR$|AWS_|GOOGLE_APPLICATION_CREDENTIALS$|CLOUD_ML_|VERTEX_|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$)/;

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

/** The user's own command, skill, agent and plugin folders, reached from a Foundry-owned home. */
const USER_FOLDERS = ['commands', 'skills', 'agents', 'plugins'] as const;

/**
 * A Kingdom pool login runs on a Foundry-owned CLAUDE_CONFIG_DIR, so `user` would read an empty
 * home. Give it the user's own setup: their settings.json as a private copy (the profile check
 * refuses a linked settings file; the guard blanks its credentials) and their folders by link.
 * Nothing that holds the user's login (`.credentials.json`, the keychain entry) is reachable.
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
  for (const name of USER_FOLDERS) {
    const link = join(home, name);
    const target = join(userDirectory, name);
    let current: ReturnType<typeof lstatSync> | undefined;
    try {
      current = lstatSync(link);
    } catch {
      /* Missing. */
    }
    if (current && !current.isSymbolicLink())
      throw Error(`${link} is not Foundry's link to the user's ${name}`);
    const wanted = existsSync(target);
    if (current && wanted && readlinkSync(link) === target) continue;
    if (current) unlinkSync(link);
    if (wanted) symlinkSync(target, link);
  }
}
