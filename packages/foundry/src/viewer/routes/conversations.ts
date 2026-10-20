/**
 * @atlas
 * @kind route
 * @partOf feature:viewer, feature:conversations
 */
import { floorModeSchema } from '@inixiative/signet';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { ConversationService } from '../../conversations/service';
import type { KingdomHolders } from '../../providers/kingdom-holder';
import {
  type KingdomIntegration,
  kingdomIntegrationId,
} from '../../providers/kingdom-installation-connection';

const floorBody = z.strictObject({ mode: floorModeSchema.nullable() });
const conchBody = z.strictObject({ to: z.string().min(1).max(128).nullable() });
const answerBody = z.strictObject({
  action: z.enum(['release', 'edit', 'withdraw']),
  input: z.string().max(16_000).optional(),
});

/**
 * Where the owner invites a party into a thread (§5.5 path 1): Kingdom's grant form, pre-filled with
 * the Foundry integration, its `threads` resource and the thread. Kingdom resolves the resource from
 * the integration; the form's preset fills the member's terms.
 */
export function inviteUrl(webUrl: string, integrationId: string, threadId: string): string {
  const url = new URL('/dashboard', webUrl);
  url.searchParams.set('grantThreads', integrationId);
  url.searchParams.set('threadId', threadId);
  return url.toString();
}

/**
 * The owner's side of a conversation in the viewer: the participants panel, the floor, a pause and
 * a resume, and answers to held sends (validated, like feedback answers).
 */
export function registerConversationRoutes(
  app: Hono,
  conversations: ConversationService,
  kingdom: { integrations: () => Promise<readonly KingdomIntegration[]>; holders: KingdomHolders },
) {
  const guard = async (run: () => unknown) => {
    try {
      return { ok: true as const, body: await run() };
    } catch (error) {
      return { ok: false as const, error: (error as Error).message };
    }
  };

  app.get('/api/threads/:threadId/conversation', async (c) => {
    const threadId = c.req.param('threadId');
    const result = await guard(async () => {
      const view = conversations.view(threadId);
      const invites = await Promise.all(
        (await kingdom.integrations()).map(async (integration) => {
          const described = await kingdom.holders.get(integration, 1_500);
          return {
            kingdomId: kingdomIntegrationId(integration),
            kingdomUrl: integration.url,
            integrationId: integration.integrationId,
            url: described.holder
              ? inviteUrl(described.holder.webUrl, integration.integrationId, threadId)
              : null,
          };
        }),
      );
      return { ...view, invites };
    });
    return result.ok ? c.json(result.body) : c.json({ error: result.error }, 404);
  });

  app.post('/api/threads/:threadId/conversation/floor', async (c) => {
    const parsed = floorBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'mode must be talk, speak-when-spoken-to, conch or null' }, 400);
    const result = await guard(() =>
      conversations.setFloor(c.req.param('threadId'), parsed.data.mode),
    );
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, 409);
  });

  app.post('/api/threads/:threadId/conversation/conch', async (c) => {
    const parsed = conchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'to must be a member id or null' }, 400);
    const result = await guard(() =>
      conversations.giveConch(
        c.req.param('threadId'),
        parsed.data.to ? { kind: 'signet', id: parsed.data.to } : null,
      ),
    );
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, 409);
  });

  app.post('/api/threads/:threadId/conversation/resume', async (c) => {
    const result = await guard(() => conversations.resume(c.req.param('threadId')));
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, 409);
  });

  app.post('/api/threads/:threadId/conversation/pause', async (c) => {
    const result = await guard(() => conversations.pauseByOwner(c.req.param('threadId')));
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, 409);
  });

  app.post('/api/conversations/held/:heldId/answer', async (c) => {
    const parsed = answerBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'action must be release, edit or withdraw' }, 400);
    const result = await guard(() =>
      conversations.submitHeld(
        c.req.param('heldId'),
        parsed.data.action,
        parsed.data.input,
        'viewer',
      ),
    );
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, 409);
  });
}
