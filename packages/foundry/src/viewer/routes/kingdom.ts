/**
 * @atlas
 * @kind route
 * @partOf feature:viewer, integration:kingdom
 */
import { type HostedSignetRequest, kingdomUrl } from '@inixiative/signet';
import type { Hono } from 'hono';
import { z } from 'zod';
import { type FoundryConversationSettings, joiningDefault } from '../../conversations/types';
import { defaultKingdomUrl, installationNameOf } from '../../providers/kingdom-cli';
import type { KingdomHolders } from '../../providers/kingdom-holder';
import {
  type KingdomInstallationConnection,
  type KingdomInstallationConnections,
  kingdomIntegrationId,
  overallStatus,
} from '../../providers/kingdom-installation-connection';
import {
  disconnectKingdom,
  type KingdomReview,
  kingdomPairInputSchema,
  pairKingdomIntegration,
  withdrawKingdomRegistration,
} from '../../providers/kingdom-pairing';
import type { ConfigStore } from '../config';

/** The operations each asked-for resource picks (a Project row asks for none). */
const picked = (request: HostedSignetRequest) =>
  request.terms.resources.flatMap((resource) =>
    resource.resourceModel === 'IntegrationResource' ? [resource.operations] : [],
  );

/** A thread's name on this Foundry; undefined when it has no such thread. */
export type ThreadNames = (threadId: string) => string | undefined;

/**
 * The threads a request asks to join (`resourceHandles`: a conversation's thread id by resource
 * id), each with its name here; one this Foundry doesn't have is kept, marked unknown, never dropped.
 */
export const requestedThreads = (
  request: Pick<HostedSignetRequest, 'resourceHandles'>,
  names: ThreadNames,
) =>
  [...new Set(Object.values(request.resourceHandles))].map((threadId) => {
    const name = names(threadId);
    return name === undefined ? { threadId, unknown: true as const } : { threadId, name };
  });

/**
 * Kingdom's review link, carrying this Foundry's default conversation permissions for the
 * requester's audience as `permissions`, comma-separated (empty: none), and the name of the thread
 * asked for as `threadName` when this Foundry has it: the review opens with those permissions the
 * request asked for, showing which thread. It only sets where the form starts; Kingdom still refuses
 * an approval wider than the request.
 */
export const reviewUrlWithDefault = (
  request: Pick<HostedSignetRequest, 'reviewUrl' | 'requester' | 'resourceHandles'>,
  conversations: FoundryConversationSettings | undefined,
  names: ThreadNames = () => undefined,
) => {
  const url = new URL(request.reviewUrl);
  url.searchParams.set(
    'permissions',
    joiningDefault(conversations, request.requester.audience).permissions.join(','),
  );
  const name = requestedThreads(request, names).flatMap((thread) =>
    'name' in thread ? [thread.name] : [],
  )[0];
  if (name !== undefined) url.searchParams.set('threadName', name);
  return url.toString();
};

/** Pending, unexpired Signet requests across every paired Kingdom, newest first. */
export function incomingRequests(
  connections: readonly Pick<KingdomInstallationConnection, 'url' | 'signetRequests'>[],
  now = Date.now(),
  conversations?: FoundryConversationSettings,
  names: ThreadNames = () => undefined,
) {
  return connections
    .flatMap((connection) =>
      connection.signetRequests
        .filter((request) => request.status === 'sent')
        .filter((request) => !request.expiresAt || Date.parse(request.expiresAt) > now)
        .map((request) => ({
          id: request.id,
          kingdomUrl: connection.url,
          requester: request.requester.displayName,
          requesterModel: request.requester.sourceModel,
          audience: request.requester.audience,
          createdAt: request.createdAt,
          expiresAt: request.expiresAt,
          name: request.terms.name,
          lifecycle: request.terms.lifecycle,
          maxRequests: request.terms.maxRequests,
          until: request.terms.expiresAt,
          // A resource asked for whole (`full`) is everything it offers, now and as it grows.
          full: picked(request).some((pick) => 'full' in pick),
          operations: [
            ...new Set(picked(request).flatMap((pick) => ('picks' in pick ? pick.picks : []))),
          ],
          threads: requestedThreads(request, names),
          reviewUrl: reviewUrlWithDefault(request, conversations, names),
        })),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const pairSchema = kingdomPairInputSchema.extend({ replace: z.string().optional() }).strict();
const disconnectSchema = z.object({ id: z.string().min(1) }).strict();
const viewerSchema = z.object({ id: z.string().min(1), opensViewer: z.boolean() }).strict();

/** A message safe to show: our own errors as written, anything else generic. */
const shown = (error: unknown, fallback: string) =>
  error instanceof Error && error.name === 'Error' ? error.message : fallback;

type Pairing = {
  url: string;
  replace?: string;
  review?: KingdomReview;
  waiting?: string;
  controller: AbortController;
};

/**
 * Settings → Kingdom. Pairing runs in the background: Kingdom shows a review code, a person approves
 * it there, and the pairing completes on its own; the page polls status until it has.
 */
export function registerKingdomRoutes(
  app: Hono,
  store: ConfigStore,
  configDir: string,
  connections: KingdomInstallationConnections,
  viewerToken: () => string | undefined,
  holders: KingdomHolders,
  threadNames: ThreadNames = () => undefined,
) {
  let pairing: Pairing | undefined;
  let failure: string | undefined;
  const status = async () => {
    const config = await store.load();
    const integrations = await Promise.all(
      (config.kingdomIntegrations ?? []).map(async (integration) => {
        const id = kingdomIntegrationId(integration);
        // Who holds the Signet, as Kingdom describes it: names for the table, links to Kingdom.
        const described = await holders.get(integration);
        return {
          id,
          url: integration.url,
          owner: integration.owner,
          integrationId: integration.integrationId,
          signetId: integration.signetId,
          opensViewer: !config.kingdomViewerRefused?.includes(kingdomUrl(integration.url)),
          status:
            described.status === 'revoked'
              ? ('revoked' as const)
              : connections.connected(id)
                ? ('connected' as const)
                : ('unavailable' as const),
          holder: described.holder,
        };
      }),
    );
    return {
      defaultUrl: defaultKingdomUrl(),
      installationName: installationNameOf(config),
      status: overallStatus(integrations),
      integrations,
      installations: connections.all().map((connection) => ({
        url: connection.url,
        connected: connection.connected,
        revoked: connection.isRevoked,
      })),
      ...(pairing?.review
        ? {
            pending: {
              url: pairing.url,
              reviewCode: pairing.review.reviewCode,
              review: pairing.review.review,
              expiresAt: pairing.review.expiresAt,
              ...(pairing.replace ? { replace: pairing.replace } : {}),
              ...(pairing.waiting ? { waiting: pairing.waiting } : {}),
            },
          }
        : {}),
      ...(failure ? { error: failure } : {}),
    };
  };
  app.use('/api/kingdom/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    return next();
  });
  app.get('/api/kingdom/status', async (c) => c.json(await status()));
  // Incoming: parties asking to join this Foundry's threads. Nothing runs until the owner accepts in
  // Kingdom (the request's reviewUrl); Foundry only shows them, read from the Installation snapshot.
  app.get('/api/kingdom/incoming', async (c) =>
    c.json({
      requests: incomingRequests(
        connections.all(),
        Date.now(),
        (await store.load()).conversations,
        threadNames,
      ),
    }),
  );
  app.post('/api/kingdom/pair', async (c) => {
    if (pairing) return c.json({ error: 'Already pairing; cancel pending pairing first.' }, 409);
    const body = await c.req.json().catch(() => null);
    // The Foundry's name is its profile name (Settings → Profile) unless the request names one.
    const parsed = pairSchema.safeParse(
      body && typeof body === 'object' && !('name' in body)
        ? { ...body, name: installationNameOf(await store.load()) }
        : body,
    );
    if (!parsed.success)
      return c.json(
        {
          error:
            'Enter an HTTPS Kingdom API address (HTTP is allowed only on localhost) and a Foundry name.',
        },
        400,
      );
    const { replace, ...input } = parsed.data;
    const current: Pairing = {
      url: input.url,
      ...(replace ? { replace } : {}),
      controller: new AbortController(),
    };
    pairing = current;
    failure = undefined;
    const reviewed = Promise.withResolvers<void>();
    void pairKingdomIntegration(store, configDir, {
      ...input,
      ...(replace ? { replace } : {}),
      signal: current.controller.signal,
      viewerToken: viewerToken(),
      around: (url, pair) => connections.whilePairing(url, pair),
      onReview: (review) => {
        current.review = review;
        reviewed.resolve();
      },
      onWaiting: (message) => {
        current.waiting = message;
      },
    }).then(
      async ({ settings }) => {
        // The review is over once Kingdom approved: never show its code beside the live connection.
        if (pairing === current) pairing = undefined;
        await connections.set(settings).catch((error) => {
          failure = shown(error, 'Paired, but the connection to Kingdom did not start.');
        });
      },
      (error) => {
        reviewed.reject(error);
        if (pairing !== current) return;
        pairing = undefined;
        failure = shown(
          error,
          'Pairing did not complete. Check the Foundry in Kingdom and pair again.',
        );
      },
    );
    try {
      await reviewed.promise;
    } catch (error) {
      failure = undefined;
      return c.json(
        {
          error: shown(
            error,
            'Could not start pairing. Check your Kingdom API address and private configuration directory.',
          ),
        },
        400,
      );
    }
    return c.json(await status());
  });
  const cancelPairing = async (canceled: Pairing) => {
    canceled.controller.abort(Error('Pairing canceled'));
    if (pairing === canceled) pairing = undefined;
    await withdrawKingdomRegistration(configDir, canceled.url).catch((error) => {
      failure = shown(
        error,
        'Pairing canceled, but Kingdom could not withdraw the request; decline it in Kingdom.',
      );
    });
  };
  app.post('/api/kingdom/cancel', async (c) => {
    failure = undefined;
    if (pairing) await cancelPairing(pairing);
    return c.json(await status());
  });
  app.post('/api/kingdom/viewer', async (c) => {
    const parsed = viewerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Choose the paired Kingdom.' }, 400);
    const integration = ((await store.load()).kingdomIntegrations ?? []).find(
      (candidate) => kingdomIntegrationId(candidate) === parsed.data.id,
    );
    if (!integration) return c.json({ error: 'That Kingdom is not paired.' }, 404);
    await store.update((next) => {
      const refused = new Set(next.kingdomViewerRefused);
      if (parsed.data.opensViewer) refused.delete(kingdomUrl(integration.url));
      else refused.add(kingdomUrl(integration.url));
      if (refused.size) next.kingdomViewerRefused = [...refused];
      else delete next.kingdomViewerRefused;
    });
    connections.setViewerServing(integration.url, parsed.data.opensViewer);
    return c.json(await status());
  });

  app.post('/api/kingdom/disconnect', async (c) => {
    const parsed = disconnectSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Choose the paired Kingdom to disconnect.' }, 400);
    const removed = await disconnectKingdom(store, configDir, parsed.data.id).catch(
      () => undefined,
    );
    if (!removed) return c.json({ error: 'That Kingdom is not paired.' }, 404);
    connections.remove(removed.id);
    holders.forget(removed.id);
    if (pairing?.replace === removed.id) await cancelPairing(pairing);
    return c.json(await status());
  });
}
