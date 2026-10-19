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
import {
  type KingdomIntegration,
  kingdomInstallation,
  kingdomIntegrationId,
  selectKingdomIntegration,
} from './kingdom-installation-connection';
import { withoutCompetingCredentials } from './native-authentication';

export type SubscriptionRuntime = 'claude' | 'codex';

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
 * `claude setup-token` (Anthropic's sign-in flow) or `codex login`. The caller wipes the dir.
 */
export async function nativeLogin(
  runtime: SubscriptionRuntime,
  directory: string,
  write: (text: string) => void = (text) => process.stderr.write(text),
): Promise<NativeLogin> {
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
  capacity:
    | { source: 'local' }
    | { source: 'kingdom'; kingdom: string; signetId: string; projectId?: string },
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
