/**
 * @atlas
 * @kind route
 * @partOf feature:daemon, feature:viewer
 */
import type { Hono } from 'hono';
import type { RestartRoll } from '../../daemon/restart-roll';

/**
 * The spin-down as the viewer sees it (`daemon/restart-roll.ts`): the update state with the turns a
 * restart waits for, and the owner's choices. Mounted behind the viewer's operator authentication.
 */
export function registerDaemonUpdateRoutes(
  app: Hono,
  roll: RestartRoll,
  threadName: (threadId: string) => string | undefined,
): void {
  app.get('/api/daemon/update', (c) => {
    const status = roll.status();
    return c.json({
      ...status,
      running: status.running.map((turn) => ({
        ...turn,
        ...(threadName(turn.threadId) ? { name: threadName(turn.threadId) } : {}),
      })),
    });
  });

  app.post('/api/daemon/update', async (c) => {
    const body = await c.req.json<{ action?: unknown }>().catch(() => ({}) as { action?: unknown });
    const action = body.action;
    const done =
      action === 'restart-now'
        ? roll.restartNow()
        : action === 'postpone'
          ? roll.postpone()
          : action === 'update-now'
            ? roll.updateNow()
            : null;
    if (done === null)
      return c.json({ error: 'action must be restart-now, postpone or update-now' }, 400);
    if (!done) return c.json({ error: `nothing to ${action} (${roll.status().phase})` }, 409);
    return c.json(roll.status());
  });
}
