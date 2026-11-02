/**
 * @atlas
 * @kind service
 * @partOf feature:nativeAuth, integration:kingdom
 */
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { signetPost, signetProof } from '@inixiative/signet';
import { z } from 'zod';
import { readPrivateJson, writePrivateFile } from '../client/private-file';
import type { ConfigStore } from '../viewer/config';
import type { SubscriptionRuntime } from './kingdom-client';
import {
  type KingdomIntegration,
  kingdomInstallation,
  kingdomIntegrationId,
  selectKingdomIntegration,
} from './kingdom-installation-connection';
import { withoutCompetingCredentials } from './native-authentication';

export type { SubscriptionRuntime } from './kingdom-client';

/** What `claude setup-token` prints: Anthropic's one-year, inference-only subscription token. */
const SETUP_TOKEN = /sk-ant-oat\d+-[A-Za-z0-9_-]{20,}/;

const subscriptionLoginResponseSchema = z.object({
  integrationId: z.string().uuid(),
  credentialId: z.string().uuid(),
  resourceId: z.string().uuid(),
  capacityId: z.string().uuid(),
  owner: z.object({ ownerModel: z.string() }).passthrough(),
});

const codexAuthSchema = z.object({
  tokens: z.object({
    id_token: z.string().min(1),
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
  }),
});

/**
 * Muse Code's own sign-in: the device-code flow its `muse` launcher runs (`device_login`), against
 * Meta's auth service with Muse Code's public client. The reply is only `{ access_token, token_type }`:
 * an opaque bearer, no refresh token, no expiry (measured 2026-11-01/02).
 */
export const MUSE_SIGN_IN = {
  origin: 'https://auth.meta.com',
  authorization: '/oidc/device/authorization/',
  token: '/oidc/device/token/',
  clientId: '1031625952748946',
  grant: 'urn:ietf:params:oauth:grant-type:device_code',
} as const;

const museDeviceSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  verification_uri_complete: z.string().optional(),
  expires_in: z.coerce.number().optional().catch(undefined),
  interval: z.coerce.number().optional().catch(undefined),
});

/** The launcher's rule: an https page, an http one upgraded, anything else refused. */
const httpsPage = (url: string | undefined) => {
  if (!url) return undefined;
  if (url.startsWith('https://')) return url;
  if (url.startsWith('http://')) return `https://${url.slice('http://'.length)}`;
  return undefined;
};

export interface MuseDeviceLoginOptions {
  write?: (text: string) => void;
  /** Opens the sign-in page; default the system browser (`open` on macOS, `xdg-open` elsewhere). */
  open?: (url: string) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
}

const openInBrowser = (url: string) => {
  try {
    Bun.spawn([process.platform === 'darwin' ? 'open' : 'xdg-open', url], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
  } catch {
    /* No browser here: the page is printed above. */
  }
};

/**
 * Signs in to Muse Code with Meta's device flow, as `muse login` does, without the CLI: nothing is
 * written to the user's own Muse config or keychain, and the token only reaches the caller. Shows
 * the page and the code, opens the page, then polls at the server's interval (`slow_down` adds five
 * seconds) until approval, denial or expiry. Redirects are refused, as the launcher refuses them.
 */
export async function museDeviceLogin(options: MuseDeviceLoginOptions = {}): Promise<NativeLogin> {
  const write = options.write ?? ((text: string) => process.stderr.write(text));
  const request = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = options.now ?? Date.now;
  const post = async (path: string, form: Record<string, string>) => {
    const response = await request(`${MUSE_SIGN_IN.origin}${path}`, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw Error('Muse sign-in redirected the request; not following it');
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  };
  const started = await post(MUSE_SIGN_IN.authorization, { client_id: MUSE_SIGN_IN.clientId });
  if (started.status === 404) throw Error('Muse sign-in is not available yet');
  if (started.status < 200 || started.status >= 300)
    throw Error(`Muse sign-in could not be started (HTTP ${started.status})`);
  const device = museDeviceSchema.parse(started.body);
  const page = httpsPage(device.verification_uri_complete) ?? httpsPage(device.verification_uri);
  if (!page) throw Error('Muse sign-in returned no https sign-in page');
  // The launcher's bounds: the code lives one to thirty minutes; polling every five seconds by default.
  const lifetime = Math.min(1800, Math.max(60, device.expires_in || 900));
  let interval = device.interval && device.interval > 0 ? device.interval : 5;
  const deadline = now() + lifetime * 1000;
  const completes = !!httpsPage(device.verification_uri_complete);
  write(
    `\nOpen this page to sign in to Muse Code:\n  ${page}\n${completes ? 'Confirm this code matches' : 'Enter this code'}:\n  ${device.user_code}\n\n`,
  );
  (options.open ?? openInBrowser)(page);
  write(`Waiting for approval (the code expires in ${Math.ceil(lifetime / 60)} minutes)...\n`);
  while (true) {
    await sleep(interval * 1000);
    if (now() >= deadline) throw Error('The Muse sign-in request expired before it was approved');
    const polled = await post(MUSE_SIGN_IN.token, {
      grant_type: MUSE_SIGN_IN.grant,
      device_code: device.device_code,
      client_id: MUSE_SIGN_IN.clientId,
    });
    if (polled.status >= 200 && polled.status < 300) {
      const token = (polled.body as { access_token?: unknown } | undefined)?.access_token;
      if (typeof token !== 'string' || !token)
        throw Error('The Muse sign-in response carried no usable token');
      write('Signed in.\n');
      return { accessToken: token };
    }
    const error = (polled.body as { error?: unknown } | undefined)?.error;
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      interval += 5;
      continue;
    }
    if (error === 'access_denied') throw Error('The Muse sign-in request was denied');
    if (error === 'expired_token')
      throw Error('The Muse sign-in request expired before it was approved');
    throw Error(`Muse sign-in failed (HTTP ${polled.status})`);
  }
}

export type NativeLogin = {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
};

const pairedWith = (integration: KingdomIntegration, kingdom: string) => {
  try {
    selectKingdomIntegration([integration], kingdom);
    return true;
  } catch {
    return false;
  }
};

/** The paired Kingdom owner a login is for: a paired-Kingdom id, an owner key, or an organization or user id in it. */
export function selectOwner<T extends KingdomIntegration>(
  integrations: readonly T[] | undefined,
  owner?: string,
  kingdom?: string,
): T {
  if (!owner) return selectKingdomIntegration(integrations, kingdom);
  const matches = (integrations ?? []).filter(
    (integration) =>
      (!kingdom || pairedWith(integration, kingdom)) &&
      (kingdomIntegrationId(integration) === owner ||
        integration.owner === owner ||
        integration.owner.split(':').slice(1).includes(owner)),
  );
  if (matches.length === 1) return matches[0]!;
  const paired = (integrations ?? [])
    .map((integration) => `${kingdomIntegrationId(integration)} (${integration.owner})`)
    .join(', ');
  throw Error(
    matches.length
      ? `Several paired owners match ${owner}; choose one by id: ${paired}`
      : `No paired Kingdom owner matches ${owner}. Paired: ${paired || 'none'}. Pair with that owner first (bun run kingdom pair).`,
  );
}

/** Streams the child's output as plain text with any setup-token replaced, and returns the token it printed. */
export async function maskedOutput(
  stream: ReadableStream<Uint8Array>,
  write: (text: string) => void,
) {
  const decoder = new TextDecoder();
  let pending = '',
    seen = '';
  const flush = (text: string) =>
    write(text.replace(new RegExp(SETUP_TOKEN, 'g'), '[token captured]'));
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const cut = Math.max(pending.lastIndexOf('\n'), pending.lastIndexOf('\r'));
    if (cut < 0) continue;
    const ready = pending.slice(0, cut + 1);
    pending = pending.slice(cut + 1);
    const plain = stripVTControlCharacters(ready);
    seen += plain;
    flush(plain);
  }
  pending += decoder.decode();
  const plain = stripVTControlCharacters(pending);
  seen += plain;
  flush(plain);
  return seen.match(SETUP_TOKEN)?.[0];
}

/**
 * Runs the native login in a throwaway config dir, so the machine's own logins are never touched:
 * `claude setup-token` (Anthropic's sign-in flow), `codex login`, or Muse Code's device sign-in
 * (no CLI and no dir: `museDeviceLogin`). The caller wipes the dir.
 */
export async function nativeLogin(
  runtime: SubscriptionRuntime,
  directory: string,
  write: (text: string) => void = (text) => process.stderr.write(text),
): Promise<NativeLogin> {
  if (runtime === 'muse') return museDeviceLogin({ write });
  const env = withoutCompetingCredentials(process.env);
  if (runtime === 'claude') {
    const child = Bun.spawn(
      [
        'script',
        '-q',
        '/dev/null',
        'sh',
        '-c',
        'stty cols 4000 2>/dev/null; exec claude setup-token',
      ],
      {
        env: { ...env, CLAUDE_CONFIG_DIR: directory },
        stdin: 'inherit',
        stdout: 'pipe',
        stderr: 'inherit',
      },
    );
    const token = await maskedOutput(child.stdout, write);
    const code = await child.exited;
    if (code !== 0 || !token) throw Error('claude setup-token did not produce a token');
    return { accessToken: token };
  }
  writePrivateFile(join(directory, 'config.toml'), 'cli_auth_credentials_store = "file"\n');
  const child = Bun.spawn(['codex', 'login'], {
    env: { ...env, CODEX_HOME: directory },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if ((await child.exited) !== 0) throw Error('codex login did not complete');
  const auth = join(directory, 'auth.json');
  if (!existsSync(auth)) throw Error('codex login left no ChatGPT login');
  const { tokens } = codexAuthSchema.parse(readPrivateJson(auth, 'Codex login'));
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
  };
}

/** Hands a login to the owner's Kingdom as this Installation; Kingdom keeps it on the owner's Integration. */
export async function uploadSubscriptionLogin(
  configDir: string,
  integration: Pick<KingdomIntegration, 'url' | 'integrationId'>,
  runtime: SubscriptionRuntime,
  login: NativeLogin,
  name?: string,
) {
  const { keyFile } = await kingdomInstallation(configDir, integration.url);
  return subscriptionLoginResponseSchema.parse(
    await signetPost(
      integration.url,
      'setSubscriptionLogin',
      {
        integrationId: integration.integrationId,
        runtime,
        ...(name ? { name } : {}),
        ...login,
      },
      { DPoP: await signetProof(integration.url, 'setSubscriptionLogin', keyFile) },
    ),
  );
}

export interface KingdomLoginOptions {
  configDir: string;
  runtime: SubscriptionRuntime;
  owner?: string;
  kingdom?: string;
  name?: string;
  store: ConfigStore;
  login?: (runtime: SubscriptionRuntime, directory: string) => Promise<NativeLogin>;
}

/** `foundry kingdom login`: sign in natively, give the login to Kingdom, keep nothing on this machine. */
export async function kingdomLogin(options: KingdomLoginOptions) {
  const integration = selectOwner(
    (await options.store.load()).kingdomIntegrations,
    options.owner,
    options.kingdom,
  );
  const directory = mkdtempSync(join(tmpdir(), 'foundry-login-'));
  chmodSync(directory, 0o700);
  const wipe = () => rmSync(directory, { recursive: true, force: true });
  const interrupted = () => {
    wipe();
    process.exit(130);
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    const login = await (options.login ?? nativeLogin)(options.runtime, directory);
    const stored = await uploadSubscriptionLogin(
      options.configDir,
      integration,
      options.runtime,
      login,
      options.name,
    );
    return { status: 'stored' as const, pairedOwner: integration.owner, ...stored };
  } finally {
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
    wipe();
  }
}

/** `foundry kingdom capacity`: a project's main threads run on this machine's login or a Kingdom pool. */
export async function setProjectCapacity(
  store: ConfigStore,
  projectId: string,
  capacity: { source: 'local' } | { source: 'kingdom'; kingdom: string; signetId: string },
) {
  const config = await store.load();
  if (!config.projects[projectId]) throw Error(`No Foundry project ${projectId}`);
  return store.update((draft) => {
    const project = draft.projects[projectId]!;
    if (capacity.source === 'local') {
      project.capacity = 'local';
      delete project.kingdomCapacity;
      return;
    }
    const { source: _source, ...kingdomCapacity } = capacity;
    project.capacity = 'kingdom';
    project.kingdomCapacity = kingdomCapacity;
  });
}

/** `foundry kingdom project`: link a Foundry project to its one Kingdom project, or unlink it (null). */
export async function setKingdomProject(
  store: ConfigStore,
  projectId: string,
  link: { kingdom: string; projectId: string } | null,
) {
  const config = await store.load();
  if (!config.projects[projectId]) throw Error(`No Foundry project ${projectId}`);
  return store.update((draft) => {
    const project = draft.projects[projectId]!;
    if (link) project.kingdomProject = link;
    else delete project.kingdomProject;
  });
}
