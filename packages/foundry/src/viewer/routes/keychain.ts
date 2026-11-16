/**
 * @atlas
 * @kind route
 * @partOf feature:secrets, feature:viewer
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { type Keychain, KeychainError } from '../../secrets/keychain';

const storeBody = z.strictObject({
  value: z.string().min(1),
  holder: z.string().optional(),
  replace: z.boolean().optional(),
});
const holderBody = z.strictObject({ holder: z.string() });
const owner = { kind: 'user' } as const;

const failure = (error: unknown) =>
  error instanceof KeychainError ? { error: error.message } : { error: 'keychain unavailable' };

/**
 * The keychain's API, behind the viewer's operator authentication: every call is the owner's, his
 * grant. Values go in and never come out: nothing here returns one.
 */
export function registerKeychainRoutes(app: Hono, keychain: Keychain): void {
  app.get('/api/keychain', (c) => c.json({ entries: keychain.list() }));

  app.put('/api/keychain/:name', async (c) => {
    const parsed = storeBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'value is a non-empty string' }, 400);
    try {
      const entry = await keychain.store(c.req.param('name'), parsed.data.value, {
        from: 'api',
        actor: owner,
        ...(parsed.data.holder ? { holder: parsed.data.holder } : {}),
        ...(parsed.data.replace ? { replace: true } : {}),
      });
      return c.json({ entry });
    } catch (error) {
      return c.json(failure(error), error instanceof KeychainError ? 400 : 503);
    }
  });

  app.post('/api/keychain/:name/holder', async (c) => {
    const parsed = holderBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'holder is a string' }, 400);
    try {
      return c.json({ entry: keychain.grant(c.req.param('name'), parsed.data.holder, owner) });
    } catch (error) {
      return c.json(failure(error), 400);
    }
  });

  app.delete('/api/keychain/:name', async (c) => {
    try {
      if (!(await keychain.remove(c.req.param('name'), owner)))
        return c.json({ error: `${c.req.param('name')} is not in the keychain` }, 404);
      return c.json({ ok: true });
    } catch (error) {
      return c.json(failure(error), 503);
    }
  });
}
