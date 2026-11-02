/**
 * @atlas
 * @kind route
 * @partOf feature:viewer, feature:conversations
 */
import { join } from 'node:path';
import { floorModeSchema, threadTextLimit } from '@inixiative/signet';
import type { Hono } from 'hono';
import { z } from 'zod';
import { REPOSITORY_SETTINGS_FILE } from '../../agents/region-roster';
import type { ConversationService } from '../../conversations/service';
import {
  conversationSettingSources,
  resolveConversationSettings,
} from '../../conversations/settings';
import {
  type ConversationSettingsInput,
  OWNER_MEMBER,
  validateConversationSettings,
} from '../../conversations/types';
import type { KingdomHolders } from '../../providers/kingdom-holder';
import {
  type KingdomIntegration,
  kingdomIntegrationId,
} from '../../providers/kingdom-installation-connection';
import type { ConfigStore } from '../config';
import { readRepositorySettings, writeRepositorySetting } from '../config-resolve';

const floorBody = z.strictObject({ mode: floorModeSchema.nullable() });
const conchBody = z.strictObject({
  to: z.string().min(1).max(128).nullable(),
  kind: z.enum(['signet', 'local']).optional(),
});
const localBody = z.strictObject({
  threadId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(200).optional(),
});
const asideBody = z.strictObject({
  text: z.string().min(1).max(threadTextLimit),
  /** The viewer's own id for it, so a retried send is recorded once. */
  postId: z.string().min(1).max(128).optional(),
});
const voiceBody = z.strictObject({
  agent: z.string().min(1).max(200),
  voice: z.enum(['speaking', 'listening']).nullable(),
});
const agentsBody = z.strictObject({ mode: z.enum(['silent', 'drafting']).nullable() });
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
  configStore: ConfigStore,
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
        parsed.data.to ? { kind: parsed.data.kind ?? 'signet', id: parsed.data.to } : null,
      ),
    );
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, 409);
  });

  // The owner's own agents on this machine (§4.11 point 2): another of his threads joins as a member.
  app.post('/api/threads/:threadId/conversation/locals', async (c) => {
    const parsed = localBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'threadId is required' }, 400);
    const result = await guard(() =>
      conversations.joinLocal(
        c.req.param('threadId'),
        parsed.data.threadId,
        parsed.data.displayName,
      ),
    );
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, 409);
  });

  app.delete('/api/threads/:threadId/conversation/locals/:memberThreadId', async (c) => {
    const result = await guard(() =>
      conversations.leaveLocal(c.req.param('threadId'), c.req.param('memberThreadId')),
    );
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, 409);
  });

  // The owner's aside (M6): to every person in the thread, never an agent, until he promotes it.
  app.post('/api/threads/:threadId/conversation/asides', async (c) => {
    const parsed = asideBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'text is required' }, 400);
    const result = await guard(() =>
      conversations.aside(
        c.req.param('threadId'),
        { member: OWNER_MEMBER, displayName: 'the owner' },
        parsed.data.text,
        ...(parsed.data.postId ? [parsed.data.postId] : []),
      ),
    );
    return result.ok ? c.json(result.body) : c.json({ error: result.error }, 409);
  });

  // Promote an aside to the log, once: his own becomes his message, a member's its post.
  app.post('/api/threads/:threadId/conversation/asides/:asideId/promote', async (c) => {
    const result = await guard(() =>
      conversations.promoteAside(c.req.param('threadId'), c.req.param('asideId')),
    );
    return result.ok
      ? c.json({ ok: true, said: result.body })
      : c.json({ error: result.error }, 409);
  });

  // An agent's voice (§4.11 point 1): `host` or a local member; null resets it to the default.
  app.post('/api/threads/:threadId/conversation/voice', async (c) => {
    const parsed = voiceBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'agent and voice (speaking, listening or null) are required' }, 400);
    const result = await guard(() =>
      conversations.setVoice(c.req.param('threadId'), parsed.data.agent, parsed.data.voice),
    );
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, 409);
  });

  app.post('/api/threads/:threadId/conversation/agents', async (c) => {
    const parsed = agentsBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'mode must be silent, drafting or null' }, 400);
    const result = await guard(() =>
      conversations.setAgents(c.req.param('threadId'), parsed.data.mode),
    );
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, 409);
  });

  app.post('/api/threads/:threadId/conversation/share-history', async (c) => {
    const result = await guard(() => conversations.shareHistory(c.req.param('threadId')));
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

  // A project's `conversations` setting (§4.6): what is in effect and which layer each field is from;
  // set it for me (this machine's project settings) or for everyone (the repository's file).
  app.get('/api/projects/:id/conversations', async (c) => {
    await configStore.load();
    const project = configStore.config.projects[c.req.param('id')];
    if (!project) return c.json({ error: 'project not found' }, 404);
    const repository = readRepositorySettings(project.path);
    return c.json({
      settings: resolveConversationSettings(project, undefined).settings,
      from: conversationSettingSources(project),
      mine: project.conversations ?? null,
      repository: repository?.conversations ?? null,
      repositoryFile: join(project.path, REPOSITORY_SETTINGS_FILE),
      ...(repository?.error ? { repositoryError: repository.error } : {}),
    });
  });

  app.put('/api/projects/:id/conversations', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      scope?: unknown;
      value?: unknown;
    } | null;
    const scope = body?.scope;
    if (scope !== 'me' && scope !== 'everyone')
      return c.json({ error: 'scope must be me or everyone' }, 400);
    const value = (body?.value ?? null) as ConversationSettingsInput | null;
    try {
      if (value !== null) validateConversationSettings('conversations', value);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    const id = c.req.param('id');
    await configStore.load();
    const project = configStore.config.projects[id];
    if (!project) return c.json({ error: 'project not found' }, 404);
    try {
      if (scope === 'me')
        await configStore.update((draft) => {
          const mine = draft.projects[id];
          if (!mine) throw Error('project not found');
          if (value === null) delete mine.conversations;
          else mine.conversations = value;
        });
      else {
        writeRepositorySetting(project.path, 'conversations', value);
      }
    } catch (error) {
      return c.json({ error: (error as Error).message }, 409);
    }
    return c.json({ ok: true });
  });
}
