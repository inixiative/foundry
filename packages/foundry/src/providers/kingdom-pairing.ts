import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { kingdomUrl, pairInstallation, signetCredentialFile } from '@inixiative/signet';
import { z } from 'zod';
import { log } from '../logger';
import type { ConfigStore } from '../viewer/config';
import { privateTunnelToken } from '../viewer/private-token';
import { ownerKey } from './kingdom-client';
import {
  type KingdomIntegration,
  kingdomInstallationPaths,
  kingdomInstallationRoot,
  kingdomIntegrationId,
  selectKingdomIntegration,
  shareViewerCredential,
} from './kingdom-installation-connection';

/** Hosted production Kingdom API origin; the default offered by guided setup. */
export const HOSTED_KINGDOM_URL = 'https://api.kingdom.inixiative.com';

export const kingdomPairInputSchema = z
  .object({
    url: z.string().transform((value, context) => {
      try {
        return kingdomUrl(value);
      } catch {
        context.addIssue({
          code: 'custom',
          message: 'Use an HTTPS origin or loopback HTTP origin.',
        });
        return z.NEVER;
      }
    }),
    name: z.string().trim().min(1).max(120),
  })
  .strict();

/** What a person needs to approve the pairing in Kingdom. */
export type KingdomReview = { url: string; reviewCode: string; review: string; expiresAt: string };

export interface PairKingdomIntegration {
  url: string;
  name: string;
  /** Id of the paired Kingdom being paired again; approval must come from its owner. */
  replace?: string;
  onReview: (review: KingdomReview) => void;
  /** Kingdom refused a poll or dropped the socket while waiting; waiting continues. */
  onWaiting?: (message: string) => void;
  /** The Signet is collected and the review code spent; runs before the integration is saved. */
  onPaired?: () => void;
  signal?: AbortSignal;
  /** The token Kingdom uses to reach the viewer; defaults to the private tunnel-token file. */
  viewerToken?: string;
  /** Runs the pairing; the viewer passes one that keeps its live connection from dropping the new Signet. */
  around?: <T>(url: string, pair: () => Promise<T>) => Promise<T>;
  socketOptions?: { pollMs?: number; retryBaseMs?: number; authTimeoutMs?: number };
}

const alreadyPaired = (url: string, owner: string, id: string) =>
  Error(
    `Already paired with ${url} as ${owner} (id ${id}). Pass --replace to pair it again, or run bun run kingdom disconnect --kingdom ${id}.`,
  );

async function privateDirectory(configDir: string) {
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
}

/**
 * Pairs this Foundry with a Kingdom as an Installation: Kingdom shows a review code, a person approves
 * it as an owner, and this Foundry collects the Signet that owner's new Foundry integration holds.
 * The owner is confirmed before anything is collected, so a refused pairing keeps nothing.
 */
export async function pairKingdomIntegration(
  store: ConfigStore,
  configDir: string,
  input: PairKingdomIntegration,
) {
  const { url, name } = kingdomPairInputSchema.parse({ url: input.url, name: input.name });
  const integrations = (await store.load()).kingdomIntegrations ?? [];
  const replaced = input.replace
    ? integrations.find((integration) => kingdomIntegrationId(integration) === input.replace)
    : undefined;
  if (input.replace && (!replaced || kingdomUrl(replaced.url) !== url))
    throw Error('The Kingdom to pair again is not paired at that address.');
  await privateDirectory(configDir);
  const pair = () =>
    pairInstallation({
      url,
      root: kingdomInstallationRoot(configDir),
      kind: 'foundry',
      name,
      terms: {
        name,
        lifecycle: 'ongoing',
        resources: [],
        expiresAt: null,
        maxRequests: null,
        maxConcurrent: 2,
      },
      onReview: (review) => input.onReview({ url, ...review }),
      onError: (error) =>
        input.onWaiting?.(error instanceof Error ? error.message : 'Kingdom did not answer'),
      confirmOwner: async ({ owner, ownerName }) => {
        if (!owner) return false;
        const key = ownerKey(owner);
        if (replaced && key !== replaced.owner)
          throw Error(
            `Kingdom approved this Foundry for ${ownerName ?? key}, not the paired owner ${replaced.owner}; nothing was replaced. Revoke the new Foundry integration in Kingdom.`,
          );
        const id = kingdomIntegrationId({ url, owner: key });
        if (
          !replaced &&
          integrations.some((integration) => kingdomIntegrationId(integration) === id)
        )
          throw alreadyPaired(url, key, id);
        return true;
      },
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.socketOptions ? { socketOptions: input.socketOptions } : {}),
    });
  const paired = await (input.around ? input.around(url, pair) : pair());
  input.onPaired?.();
  const settings: KingdomIntegration = {
    url,
    integrationId: paired.integrationId,
    owner: ownerKey(paired.owner),
    signetId: paired.signetId,
  };
  let id: string;
  try {
    ({ id } = await saveKingdomIntegration(store, configDir, settings, !!replaced));
  } catch (error) {
    await unlink(paired.credentialFile).catch(() => {});
    throw error;
  }
  try {
    await shareViewerCredential(
      configDir,
      (await store.load()).kingdomIntegrations ?? [],
      input.viewerToken ?? privateTunnelToken(configDir),
      (message) => log.warn(message),
    );
  } catch (error) {
    log.warn(`[Kingdom] viewer credential not shared: ${(error as Error).message}`);
  }
  return { id, settings, ownerName: paired.ownerName };
}

/** Adds a paired Kingdom; `replace` swaps the one with the same Kingdom + owner and deletes its Signet file. */
export async function saveKingdomIntegration(
  store: ConfigStore,
  configDir: string,
  integration: KingdomIntegration,
  replace = false,
) {
  const id = kingdomIntegrationId(integration);
  let replaced: KingdomIntegration | undefined;
  await store.load();
  await store.update((draft) => {
    const integrations = draft.kingdomIntegrations ?? [];
    replaced = integrations.find((item) => kingdomIntegrationId(item) === id);
    if (replaced && !replace) throw alreadyPaired(integration.url, integration.owner, id);
    draft.kingdomIntegrations = [...integrations.filter((item) => item !== replaced), integration];
  });
  if (replaced && replaced.signetId !== integration.signetId)
    await unlink(
      signetCredentialFile(
        kingdomInstallationPaths(configDir, replaced.url).directory,
        replaced.signetId,
      ),
    ).catch(() => {});
  return { id, replaced };
}

/** Removes one paired Kingdom's local entry and its Signet file. Revoking the integration stays with Kingdom. */
export async function disconnectKingdom(store: ConfigStore, configDir: string, selector?: string) {
  const { kingdomIntegrations } = await store.load();
  if (!kingdomIntegrations?.length) return undefined;
  const integration = selectKingdomIntegration(kingdomIntegrations, selector);
  const id = kingdomIntegrationId(integration);
  await store.update((draft) => {
    const kept = (draft.kingdomIntegrations ?? []).filter(
      (item) => kingdomIntegrationId(item) !== id,
    );
    if (kept.length) draft.kingdomIntegrations = kept;
    else delete draft.kingdomIntegrations;
  });
  await unlink(
    signetCredentialFile(
      kingdomInstallationPaths(configDir, integration.url).directory,
      integration.signetId,
    ),
  ).catch(() => {});
  return { id, ...integration };
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
