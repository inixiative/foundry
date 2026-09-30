import type { Hono } from 'hono';
import {
  beginKingdomPairing,
  completeKingdomPairing,
  disconnectKingdom,
  type KingdomPairing,
  kingdomPairInputSchema,
  pollKingdomPairing,
} from '../../providers/kingdom-pairing';
import { KingdomRuntimeConnection } from '../../providers/kingdom-runtime-connection';
import type { RuntimeJobRegistry } from '../../providers/runtime-job-handler';
import type { ConfigStore } from '../config';

export function registerKingdomRoutes(
  app: Hono,
  store: ConfigStore,
  configDir: string,
  sessionCount: () => number,
  activate: (connection: KingdomRuntimeConnection | null) => void,
  connected: () => boolean,
  handlers?: RuntimeJobRegistry,
) {
  let pending: KingdomPairing | undefined;
  let busy = false,
    lastPoll = 0;
  const status = async () => {
    const config = await store.load();
    if (pending && Date.parse(pending.expiresAt) <= Date.now()) pending = undefined;
    if (!pending && config.kingdomRuntime)
      return {
        status: connected() ? 'connected' : 'unavailable',
        url: config.kingdomRuntime.url,
        installationId: config.kingdomRuntime.installationId,
      };
    return pending
      ? {
          status: 'pending',
          url: pending.url,
          userCode: pending.userCode,
          verificationUrl: pending.verificationUrl,
          expiresAt: pending.expiresAt,
        }
      : { status: 'disconnected' };
  };
  app.use('/api/kingdom/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    return next();
  });
  app.get('/api/kingdom/status', async (c) => c.json(await status()));
  app.post('/api/kingdom/pair', async (c) => {
    if (busy) return c.json({ error: 'Connection operation in progress' }, 409);
    busy = true;
    try {
      const parsed = kingdomPairInputSchema.safeParse(await c.req.json());
      if (!parsed.success)
        return c.json(
          {
            error:
              'Enter an HTTPS Kingdom API address (HTTP is allowed only on localhost) and a runtime name.',
          },
          400,
        );
      if ((await status()).status === 'pending')
        return c.json(
          { error: 'Already connected or pairing; cancel pending pairing first.' },
          409,
        );
      pending = await beginKingdomPairing(parsed.data, configDir);
      lastPoll = 0;
      return c.json(await status());
    } catch {
      return c.json(
        {
          error:
            'Could not start pairing. Check your Kingdom API address and private configuration directory.',
        },
        400,
      );
    } finally {
      busy = false;
    }
  });
  app.post('/api/kingdom/poll', async (c) => {
    if (busy) return c.json({ error: 'Connection operation in progress' }, 409);
    busy = true;
    try {
      const current = await status();
      if (!pending || current.status !== 'pending' || Date.now() - lastPoll < 5000)
        return c.json(current);
      lastPoll = Date.now();
      const data = await pollKingdomPairing(pending);
      if (data.status === 'pending') return c.json(current);
      const { connection } = await completeKingdomPairing(
        store,
        configDir,
        pending,
        data.installationId,
        {
          connect: (settings) =>
            new KingdomRuntimeConnection(settings, sessionCount, fetch, handlers),
          start: true,
        },
      );
      activate(connection);
      pending = undefined;
      return c.json(await status());
    } catch {
      return c.json(
        {
          error:
            'Connection not completed. Retry, or check the runtime in Kingdom before starting again.',
        },
        503,
      );
    } finally {
      busy = false;
    }
  });
  app.post('/api/kingdom/cancel', async (c) => {
    if (busy) return c.json({ error: 'Connection operation in progress' }, 409);
    pending = undefined;
    return c.json(await status());
  });
  app.post('/api/kingdom/disconnect', async (c) => {
    if (busy) return c.json({ error: 'Connection operation in progress' }, 409);
    busy = true;
    try {
      pending = undefined;
      await disconnectKingdom(store, () => activate(null));
      return c.json(await status());
    } finally {
      busy = false;
    }
  });
}
