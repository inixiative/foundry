import type { Hono } from 'hono';
import { z } from 'zod';
import { defaultKingdomUrl, installationNameOf } from '../../providers/kingdom-cli';
import type { KingdomHolders } from '../../providers/kingdom-holder';
import {
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

const pairSchema = kingdomPairInputSchema.extend({ replace: z.string().optional() }).strict();
const disconnectSchema = z.object({ id: z.string().min(1) }).strict();

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
