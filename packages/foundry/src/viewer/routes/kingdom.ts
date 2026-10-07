import type { Hono } from 'hono';
import { z } from 'zod';
import {
  beginKingdomPairing,
  completeKingdomPairing,
  disconnectKingdom,
  type KingdomPairing,
  kingdomPairInputSchema,
  pollKingdomPairing,
} from '../../providers/kingdom-pairing';
import { kingdomRuntimeId } from '../../providers/kingdom-runtime-connection';
import {
  type KingdomRuntimeConnections,
  overallStatus,
} from '../../providers/kingdom-runtime-connections';
import type { ConfigStore } from '../config';

const pairSchema = kingdomPairInputSchema.extend({ replace: z.string().optional() }).strict();
const disconnectSchema = z.object({ id: z.string().min(1) }).strict();

export function registerKingdomRoutes(
  app: Hono,
  store: ConfigStore,
  configDir: string,
  sessionCount: () => number,
  connections: KingdomRuntimeConnections,
) {
  let pending: (KingdomPairing & { replace?: string }) | undefined;
  let busy = false,
    lastPoll = 0;
  const status = async () => {
    const config = await store.load();
    if (pending && Date.parse(pending.expiresAt) <= Date.now()) pending = undefined;
    const runtimes = (config.kingdomRuntimes ?? []).map((runtime) => {
      const id = kingdomRuntimeId(runtime);
      return {
        id,
        url: runtime.url,
        owner: runtime.owner,
        installationId: runtime.installationId,
        status: connections.get(id)?.connected ? ('connected' as const) : ('unavailable' as const),
      };
    });
    return {
      status: overallStatus(runtimes),
      runtimes,
      ...(pending
        ? {
            pending: {
              url: pending.url,
              userCode: pending.userCode,
              verificationUrl: pending.verificationUrl,
              expiresAt: pending.expiresAt,
              ...(pending.replace ? { replace: pending.replace } : {}),
            },
          }
        : {}),
    };
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
      const parsed = pairSchema.safeParse(await c.req.json());
      if (!parsed.success)
        return c.json(
          {
            error:
              'Enter an HTTPS Kingdom API address (HTTP is allowed only on localhost) and a runtime name.',
          },
          400,
        );
      const current = await status();
      if (current.pending)
        return c.json({ error: 'Already pairing; cancel pending pairing first.' }, 409);
      const { replace, ...input } = parsed.data;
      if (
        replace &&
        !current.runtimes.some((runtime) => runtime.id === replace && runtime.url === input.url)
      )
        return c.json({ error: 'The Kingdom to pair again is not paired at that address.' }, 400);
      pending = {
        ...(await beginKingdomPairing(input, configDir)),
        ...(replace ? { replace } : {}),
      };
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
      if (!pending || !current.pending || Date.now() - lastPoll < 5000) return c.json(current);
      lastPoll = Date.now();
      const data = await pollKingdomPairing(pending);
      if (data.status === 'pending') return c.json(current);
      const { settings } = await completeKingdomPairing(
        store,
        configDir,
        pending,
        data.installationId,
        {
          sessionCount: sessionCount(),
          ...(pending.replace ? { replace: pending.replace } : {}),
        },
      );
      await connections.set(settings);
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
    const parsed = disconnectSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Choose the paired Kingdom to disconnect.' }, 400);
    busy = true;
    try {
      const removed = await disconnectKingdom(store, parsed.data.id).catch(() => undefined);
      if (!removed) return c.json({ error: 'That Kingdom is not paired.' }, 404);
      connections.remove(removed.id);
      if (pending?.replace === removed.id) pending = undefined;
      return c.json(await status());
    } finally {
      busy = false;
    }
  });
}
