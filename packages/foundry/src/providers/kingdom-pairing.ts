import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { ConfigStore } from '../viewer/config';
import { kingdomUrl, ownerKey } from './kingdom-client';
import { writePrivateJson } from './kingdom-credential-file';
import {
  type KingdomRuntimeSettings,
  kingdomRuntimeId,
  readRuntimeIdentity,
  selectKingdomRuntime,
} from './kingdom-runtime-connection';
import { RUNTIME_SECRET_PREFIX } from './kingdom-secrets';
import type { RuntimeJobRegistry } from './runtime-job-handler';

/** Hosted production Kingdom API origin; the default offered by guided setup. */
export const HOSTED_KINGDOM_URL = 'https://kingdom-prod-api-prod.up.railway.app';

export const kingdomPairInputSchema = z
  .object({ url: z.string().transform(kingdomUrl), name: z.string().trim().min(1).max(120) })
  .strict();
const pairSchema = z.object({
  data: z.object({
    deviceCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    userCode: z.string().regex(/^[A-F0-9]{12}$/),
    verificationUrl: z.string().url(),
    expiresAt: z.string().datetime(),
    interval: z.number().int().min(1).max(60).optional(),
  }),
});
const pollSchema = z.object({
  data: z.discriminatedUnion('status', [
    z.object({ status: z.literal('pending') }),
    z.object({ status: z.literal('approved'), installationId: z.string().uuid() }),
  ]),
});

export interface KingdomPairing {
  url: string;
  secret: string;
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  interval?: number;
}
export type KingdomPollResult = z.output<typeof pollSchema>['data'];

async function request(url: string, action: string, body: unknown, transport: typeof fetch) {
  const response = await transport(`${url}/api/v1/access/${action}`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error('Kingdom refused the request. Check the address or start pairing again.');
  }
  return response.json();
}

/** Creates the runtime secret locally and sends Kingdom only its hash. */
export async function beginKingdomPairing(
  input: z.output<typeof kingdomPairInputSchema>,
  configDir: string,
  transport: typeof fetch = fetch,
): Promise<KingdomPairing> {
  const directory = resolve(configDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw Error('Configuration directory must be owned by this user.');
  await chmod(directory, 0o700);
  const secret = `${RUNTIME_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
  const { data } = pairSchema.parse(
    await request(
      input.url,
      'pairRuntime',
      { name: input.name, keyHash: createHash('sha256').update(secret).digest('hex') },
      transport,
    ),
  );
  const verification = new URL(data.verificationUrl);
  kingdomUrl(verification.origin);
  if (
    verification.username ||
    verification.password ||
    (new URL(input.url).protocol === 'https:' && verification.protocol !== 'https:')
  )
    throw Error('Kingdom returned an unsafe login address.');
  return { ...data, url: input.url, secret };
}

export async function pollKingdomPairing(
  pairing: KingdomPairing,
  transport: typeof fetch = fetch,
): Promise<KingdomPollResult> {
  return pollSchema.parse(
    await request(pairing.url, 'pollRuntime', { deviceCode: pairing.deviceCode }, transport),
  ).data;
}

/** Adds a paired Kingdom; `replace` swaps the one with the same Kingdom + owner. Deletes a replaced credential. */
export async function saveKingdomRuntime(
  store: ConfigStore,
  runtime: KingdomRuntimeSettings,
  replace = false,
) {
  const id = kingdomRuntimeId(runtime);
  let replaced: KingdomRuntimeSettings | undefined;
  await store.load();
  await store.update((draft) => {
    const runtimes = draft.kingdomRuntimes ?? [];
    replaced = runtimes.find((item) => kingdomRuntimeId(item) === id);
    if (replaced && !replace)
      throw Error(
        `Already paired with ${runtime.url} as ${runtime.owner} (id ${id}). Pass --replace to pair it again, or run bun run kingdom disconnect --kingdom ${id}.`,
      );
    draft.kingdomRuntimes = [...runtimes.filter((item) => item !== replaced), runtime];
  });
  if (replaced && replaced.credentialFile !== runtime.credentialFile)
    await unlink(replaced.credentialFile).catch(() => {});
  return { id, replaced };
}

/**
 * Persists the approved credential, reads the owner Kingdom approved it for, then records the paired Kingdom.
 * `replace` names the paired Kingdom being re-paired; approval must come from the same owner. Nothing is kept on failure.
 */
export async function completeKingdomPairing(
  store: ConfigStore,
  configDir: string,
  pairing: KingdomPairing,
  installationId: string,
  options: {
    replace?: string;
    transport?: typeof fetch;
    sessionCount?: number;
    handlers?: RuntimeJobRegistry;
  } = {},
) {
  const credentialFile = join(resolve(configDir), `kingdom-runtime-${installationId}.json`);
  await writePrivateJson(credentialFile, { secret: pairing.secret });
  try {
    const identity = await readRuntimeIdentity(
      { url: pairing.url, installationId, credentialFile },
      options,
    );
    const settings: KingdomRuntimeSettings = {
      url: pairing.url,
      owner: ownerKey(identity.owner),
      installationId,
      credentialFile,
    };
    if (options.replace && kingdomRuntimeId(settings) !== options.replace)
      throw Error(
        `Kingdom approved this runtime for ${settings.owner}, not the paired Kingdom ${options.replace}; nothing was replaced. Revoke the new runtime in Kingdom's Foundry tab.`,
      );
    const { id } = await saveKingdomRuntime(store, settings, !!options.replace);
    return { id, settings };
  } catch (error) {
    await unlink(credentialFile).catch(() => {});
    throw error;
  }
}

/** Removes one paired Kingdom's local binding and credential. Kingdom-side revocation stays with Kingdom. */
export async function disconnectKingdom(store: ConfigStore, selector?: string) {
  const { kingdomRuntimes } = await store.load();
  if (!kingdomRuntimes?.length) return undefined;
  const runtime = selectKingdomRuntime(kingdomRuntimes, selector);
  await store.update((draft) => {
    const kept = (draft.kingdomRuntimes ?? []).filter(
      (item) => kingdomRuntimeId(item) !== kingdomRuntimeId(runtime),
    );
    if (kept.length) draft.kingdomRuntimes = kept;
    else delete draft.kingdomRuntimes;
  });
  await unlink(runtime.credentialFile).catch(() => {});
  return { id: kingdomRuntimeId(runtime), ...runtime };
}

/** A local viewer answering on its port holds settings in memory until restarted. */
export async function viewerRunning(
  port = Number(process.env.VIEWER_PORT ?? 4500),
  transport: typeof fetch = fetch,
) {
  try {
    const response = await transport(`http://127.0.0.1:${port}/api/kingdom/status`, {
      redirect: 'error',
      signal: AbortSignal.timeout(1000),
    });
    await response.body?.cancel();
    return response.status !== 404;
  } catch {
    return false;
  }
}
