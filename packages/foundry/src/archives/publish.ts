// Native authentication adapter. Preserve standalone Archive's durable outbox/replay semantics.

import type { LocalArchiveStore } from '@inixiative/archive/local';
import type { CredentialReference, CredentialResolver } from '@inixiative/foundry-core';
import { z } from 'zod';
import { FoundryCredentials } from '../providers/credentials';
import { RUNTIME_SECRET_PREFIX } from '../providers/kingdom-secrets';
import {
  type ArchiveDestination,
  archiveDestinationSchema,
  connectDestination,
  destinationIdentity,
  destinationUrl,
} from './config';

export { type ArchiveDestination, archiveDestinationSchema } from './config';

/** Identifies the Kingdom owner and forwarding connection; standalone Archive needs neither. */
export function kingdomFields(destination: ArchiveDestination) {
  if (destination.kind === 'archive') return {};
  const { ownerModel, organizationId, spaceId, connectionId } = destination;
  return Object.fromEntries(
    Object.entries({ ownerModel, organizationId, spaceId, connectionId }).filter(
      ([, value]) => value !== undefined,
    ),
  );
}

export async function verifyArchiveDestination(
  destination: ArchiveDestination,
  credentials: CredentialResolver,
  transport: typeof fetch = fetch,
) {
  if (destination.kind === 'kingdom' && destination.connectionId) {
    const listed = await archiveRequest(
      { ...destination, connectionId: undefined },
      'remote/connections',
      kingdomFields({ ...destination, connectionId: undefined }),
      transport,
      credentials,
    );
    if (
      !Array.isArray(listed.data) ||
      !listed.data.some(
        (connection) =>
          connection.id === destination.connectionId &&
          connection.projectId === destination.projectId,
      )
    )
      throw Error('Kingdom Archive publication is not configured for this project');
  }
  const result = await archiveRequest(
    destination,
    'search',
    {
      query: '',
      budget: 16,
      limit: 1,
      ...(destination.kind === 'archive'
        ? { projectId: destination.projectId }
        : kingdomFields(destination)),
    },
    transport,
    credentials,
  );
  if (!Array.isArray(result.data?.archives)) throw Error('Archive protocol unavailable');
}

/** Hosted Archive destinations Kingdom has bound to a paired Kingdom's owner (`selector`: id or API origin). */
export async function listKingdomConnections(
  credentials: FoundryCredentials,
  selector?: string,
  transport: typeof fetch = fetch,
  sessionCount = 0,
) {
  const identity = await credentials.kingdomIdentity(selector, transport, sessionCount);
  const result = await archiveRequest(
    {
      url: identity.url,
      kind: 'kingdom',
      projectId: 'discovery',
      credential: { type: 'kingdom-runtime', owner: identity.owner },
    },
    'remote/connections',
    {},
    transport,
    credentials,
  );
  return { ...identity, connections: result.data };
}

/** Verifies then saves a destination; a direct `secret` becomes a managed credential, removed again on failure. */
export async function saveArchiveConnection(
  configPath: string,
  input: unknown,
  credentials: FoundryCredentials,
  transport: typeof fetch = fetch,
) {
  let created: CredentialReference | undefined;
  let committed = false;
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw Error('Invalid connection');
    const { secret, ...configuration } = input as Record<string, unknown>;
    if (secret !== undefined) {
      if (configuration.credential || configuration.tokenEnv) throw Error('Choose one credential');
      // Validate the destination before accepting secret custody.
      const candidate = archiveDestinationSchema.parse({
        ...configuration,
        credential: { type: 'managed', id: crypto.randomUUID() },
      });
      if (candidate.kind !== 'archive') throw Error('Pair Kingdom to use native credentials');
      created = await credentials.save(
        { service: 'archive', url: candidate.url, projectId: candidate.projectId },
        z.string().min(1).max(16384).parse(secret),
      );
      configuration.credential = created;
    }
    const destination = archiveDestinationSchema.parse(configuration);
    await verifyArchiveDestination(destination, credentials, transport);
    const configured = connectDestination(configPath, destination);
    committed = true;
    return configured;
  } catch (error) {
    if (created && !committed) await credentials.remove(created).catch(() => {});
    throw error;
  }
}

export async function archiveRequest(
  destination: ArchiveDestination,
  action: string,
  body: unknown,
  transport: typeof fetch = fetch,
  credentials: CredentialResolver = new FoundryCredentials(),
) {
  const url = destinationUrl(destination.url);
  const token = destination.credential
    ? await credentials.resolve(destination.credential, {
        service: 'archive',
        url: destination.url,
        projectId: destination.projectId,
      })
    : process.env[destination.tokenEnv!];
  if (!token || (destination.kind === 'kingdom' && !token.startsWith(RUNTIME_SECRET_PREFIX)))
    throw new Error('Archive runtime credential unavailable');
  const path =
    destination.kind === 'kingdom' && destination.connectionId ? `remote/${action}` : action;
  const response = await transport(new URL(`api/v1/archive/${path}`, url), {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`Archive request rejected (${response.status}); local archive retained`);
  return response.json() as Promise<{ data: any }>;
}

export async function publishArchive(
  store: LocalArchiveStore,
  id: string,
  input: ArchiveDestination,
  transport: typeof fetch = fetch,
  credentials: CredentialResolver = new FoundryCredentials(),
) {
  const destination = archiveDestinationSchema.parse(input);
  const archive = store.read(id);
  if (!archive || archive.snapshot.projectId !== destination.projectId)
    throw new Error('Archive is outside destination project');
  const receiptKey = destinationIdentity(destination);
  let sent = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const latest = store.read(id)!;
    const previousDigest = store.receipt(id, receiptKey);
    let pending = store.pending(id, receiptKey);
    if (!pending) {
      if (previousDigest === latest.digest) return { unchanged: !sent };
      store.enqueue(id, receiptKey, { revision: latest.revision });
      pending = store.pending(id, receiptKey)!;
    }
    const queued = store.read(id, pending.revision);
    if (!queued || queued.snapshot.projectId !== destination.projectId)
      throw new Error('Pending archive is outside destination project');
    const body = await archiveRequest(
      destination,
      'ingest',
      {
        ...kingdomFields(destination),
        previousDigest,
        snapshot: queued.snapshot,
      },
      transport,
      credentials,
    );
    if (body.data?.digest !== queued.digest) throw new Error('Archive acknowledgement mismatch');
    store.delivered(id, receiptKey, queued.digest);
    sent = true;
  }
  throw new Error('Archive changed repeatedly during publication; retry sync');
}

export function routingPreview(store: LocalArchiveStore, destinations: ArchiveDestination[]) {
  return store.list().map((archive) => ({
    id: archive.id,
    projectId: archive.projectId,
    tags: archive.tags,
    suggestedTags: archive.suggestedTags,
    destinations: destinations
      .filter((d) => d.projectId === archive.projectId)
      .map((d) => ({
        kind: d.kind,
        url: d.url,
        ...kingdomFields(d),
      })),
  }));
}

export async function syncArchives(
  store: LocalArchiveStore,
  destinations: ArchiveDestination[],
  credentials: CredentialResolver = new FoundryCredentials(),
) {
  const results: { id: string; destination: string; status: string }[] = [];
  for (const archive of store.list())
    for (const destination of destinations.filter((d) => d.projectId === archive.projectId)) {
      try {
        const result = await publishArchive(store, archive.id, destination, fetch, credentials);
        results.push({
          id: archive.id,
          destination: destination.url,
          status: result.unchanged ? 'unchanged' : 'published',
        });
      } catch {
        results.push({
          id: archive.id,
          destination: destination.url,
          status: 'failed; local revision retained',
        });
      }
    }
  return results;
}

export async function searchRemotes(
  destinations: ArchiveDestination[],
  query: string,
  budget = 2048,
  credentials: CredentialResolver = new FoundryCredentials(),
) {
  return Promise.all(
    destinations.map(async (destination) => {
      try {
        const result = await archiveRequest(
          destination,
          'search',
          {
            query,
            budget,
            ...(destination.kind === 'archive'
              ? { projectId: destination.projectId }
              : kingdomFields(destination)),
          },
          fetch,
          credentials,
        );
        return {
          destination: destination.url,
          projectId: destination.projectId,
          data: result.data,
        };
      } catch {
        return {
          destination: destination.url,
          projectId: destination.projectId,
          error: 'Remote unavailable',
        };
      }
    }),
  );
}
