import type { Hono } from 'hono';
import { z } from 'zod';
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
) {
  let pairing: Pairing | undefined;
  let failure: string | undefined;
  const status = async () => {
    const config = await store.load();
    const integrations = (config.kingdomIntegrations ?? []).map((integration) => {
      const id = kingdomIntegrationId(integration);
      return {
        id,
        url: integration.url,
        owner: integration.owner,
        integrationId: integration.integrationId,
        signetId: integration.signetId,
        status: connections.connected(id) ? ('connected' as const) : ('unavailable' as const),
      };
    });
    return {
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
    const parsed = pairSchema.safeParse(await c.req.json().catch(() => null));
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
        await connections.set(settings);
        if (pairing === current) pairing = undefined;
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
  app.post('/api/kingdom/cancel', async (c) => {
    pairing?.controller.abort(Error('Pairing canceled'));
    pairing = undefined;
    failure = undefined;
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
    if (pairing?.replace === removed.id) {
      pairing.controller.abort(Error('Pairing canceled'));
      pairing = undefined;
    }
    return c.json(await status());
  });
}
