import {
  type ArchiveSnapshot,
  archiveKey,
  archiveSnapshotSchema,
  chunkArchive,
  selectChunks,
  snapshotDigest,
} from '@inixiative/archive';
import { ArchiveClient, type ArchiveListing } from '@inixiative/archive/remote';
import { defaultSettings } from '@inixiative/archive/schemas';
import { archiveReferences, suggestTags } from '@inixiative/archive/tags';

type Revision = { revision: number; digest: string; snapshot: ArchiveSnapshot };

/**
 * An in-memory Archive server with the endpoints Foundry uses (info, head, ingest, read, list,
 * search, settings/read), so tests never need Postgres or the real local Archive.
 */
export function startFakeArchive(token = 'fake-archive-token-0000000000000000') {
  const sourceId = crypto.randomUUID();
  const archives = new Map<string, Revision[]>();
  const requests: string[] = [];
  let failing = false;
  /** Libraries this Archive's paired Signet grants sessions.write on; connect refuses others. */
  const libraries: { integrationId: string; resourceId: string; name: string }[] = [];
  const destinations: { projectId: string; integrationId: string; resourceId: string }[] = [];
  const sameRoute = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    a.projectId === b.projectId &&
    a.integrationId === b.integrationId &&
    a.resourceId === b.resourceId;
  const latest = (id: string) => archives.get(id)?.at(-1);
  const listing = (id: string, { revision, digest, snapshot }: Revision): ArchiveListing => {
    const { entries, ...meta } = snapshot;
    const models = new Map<string, { model: string; effort?: string; entries: number }>();
    for (const entry of entries)
      if (entry.model) {
        const key = JSON.stringify([entry.model, entry.effort]);
        const current = models.get(key) ?? {
          model: entry.model,
          ...(entry.effort ? { effort: entry.effort } : {}),
          entries: 0,
        };
        current.entries++;
        models.set(key, current);
      }
    return {
      ...meta,
      id,
      revision,
      digest,
      entries: entries.length,
      models: [...models.values()],
      suggestedTags: suggestTags(snapshot),
      references: archiveReferences(snapshot),
    };
  };
  const current = (projectId?: string) =>
    [...archives.entries()].flatMap(([id, revisions]) => {
      const top = revisions.at(-1);
      return top && (projectId === undefined || top.snapshot.projectId === projectId)
        ? [{ listing: listing(id, top), snapshot: top.snapshot }]
        : [];
    });
  const listings = (projectId?: string) => current(projectId).map((found) => found.listing);
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const action = new URL(request.url).pathname.replace('/api/v1/archive/', '');
      requests.push(action);
      if (request.headers.get('authorization') !== `Bearer ${token}`)
        return json({ error: 'Unauthorized' }, 401);
      if (failing) return json({ error: 'Archive operation failed' }, 500);
      const body = (await request.json()) as Record<string, unknown>;
      if (action === 'info') return json({ data: { sourceId, protocol: 2 } });
      if (action === 'settings/read') return json({ data: defaultSettings });
      if (action === 'head' || action === 'read') {
        const revisions = archives.get(String(body.archiveId));
        const found = body.revision
          ? revisions?.find((r) => r.revision === body.revision)
          : revisions?.at(-1);
        if (!found) return json({ error: 'Archive unavailable' }, 404);
        const id = String(body.archiveId);
        return json({
          data:
            action === 'head'
              ? { id, digest: found.digest, revision: found.revision, projectId: null }
              : { id, ...found, chunks: chunkArchive(found.snapshot) },
        });
      }
      if (action === 'ingest') {
        const snapshot = archiveSnapshotSchema.parse(body.snapshot);
        const id = archiveKey(snapshot),
          digest = snapshotDigest(snapshot),
          old = latest(id);
        if (old?.digest === digest)
          return json({ data: { id, digest, revision: old.revision, changed: false } });
        if ((old?.digest ?? null) !== body.previousDigest)
          return json({ error: 'Revision conflict' }, 409);
        const revision = (old?.revision ?? 0) + 1;
        archives.set(id, [...(archives.get(id) ?? []), { revision, digest, snapshot }]);
        return json({ data: { id, digest, revision, changed: true } });
      }
      if (action === 'list')
        return json({
          data: {
            archives: listings(body.projectId as string | undefined),
            nextCursor: null,
          },
        });
      if (action === 'search') {
        const query = String(body.query ?? '');
        let remaining = Number(body.budget ?? 2048);
        const found = [];
        for (const { listing: a, snapshot } of current(body.projectId as string | undefined)) {
          const text = [a.title, ...a.tags, ...snapshot.entries.map((e) => e.text)].join('\n');
          if (query && !text.toLowerCase().includes(query.toLowerCase())) continue;
          const selected =
            remaining >= 16
              ? selectChunks(chunkArchive(snapshot), query, remaining)
              : { chunks: [], tokenCount: 0 };
          remaining -= selected.tokenCount;
          const { id, entries: _, ...meta } = a;
          found.push({ archiveId: id, ...meta, ...selected });
        }
        return json({
          data: {
            archives: found,
            tokenCount: Number(body.budget ?? 2048) - remaining,
            nextCursor: null,
          },
        });
      }
      if (action === 'destinations/list')
        return json({
          data: {
            destinations: destinations
              .filter((d) => body.projectId === undefined || d.projectId === body.projectId)
              .map((d) => ({
                configured: true,
                kind: 'kingdom',
                url: 'https://kingdom.example',
                ...d,
                delivered: 0,
                pending: current(d.projectId).length,
              })),
          },
        });
      if (action === 'destinations/libraries')
        return json({ data: { paired: libraries.length > 0, libraries } });
      if (action === 'destinations/connect') {
        if (
          !libraries.some(
            (l) => l.integrationId === body.integrationId && l.resourceId === body.resourceId,
          )
        )
          return json(
            { error: "This Archive's Signet does not grant sessions.write on that library" },
            403,
          );
        const route = {
          projectId: String(body.projectId),
          integrationId: String(body.integrationId),
          resourceId: String(body.resourceId),
        };
        if (!destinations.some((d) => sameRoute(d, route))) destinations.push(route);
        return json({
          data: { configured: true, kind: 'kingdom', url: 'https://kingdom.example', ...route },
        });
      }
      if (action === 'destinations/remove') {
        const index = destinations.findIndex((d) => sameRoute(d, body));
        if (index >= 0) destinations.splice(index, 1);
        return json({ data: { removed: index >= 0 } });
      }
      return json({ error: 'Not found' }, 404);
    },
  });
  const url = server.url.href;
  return {
    url,
    token,
    sourceId,
    requests,
    client: () => new ArchiveClient({ url, token }),
    snapshots: (id: string) => (archives.get(id) ?? []).map((r) => r.snapshot),
    listings,
    grantLibrary: (library: { integrationId: string; resourceId: string; name: string }) =>
      libraries.push(library),
    /** Answers every authenticated request with a server error until set back. */
    fail(value: boolean) {
      failing = value;
    },
    stop: () => server.stop(true),
  };
}
export type FakeArchive = ReturnType<typeof startFakeArchive>;
