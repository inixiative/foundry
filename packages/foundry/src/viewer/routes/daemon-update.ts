/**
 * @atlas
 * @kind route
 * @partOf feature:daemon, feature:viewer
 */
import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import type { RestartRoll } from '../../daemon/restart-roll';

/** This daemon process: a viewer that sees it change reloads onto the new build. */
const BOOT_ID = randomUUID();

/**
 * The spin-down as the viewer sees it (`daemon/restart-roll.ts`): the update state with the turns a
 * restart waits for, and the owner's choices (`restart` asks for one with no update). Mounted behind the viewer's operator authentication.
 */
export function registerDaemonUpdateRoutes(
  app: Hono,
  roll: RestartRoll,
  threadName: (threadId: string) => string | undefined,
): void {
  const view = () => {
    const status = roll.status();
    const named = (turn: { threadId: string; turnId: string }) => ({
      ...turn,
      ...(threadName(turn.threadId) ? { name: threadName(turn.threadId) } : {}),
    });
    return {
      ...status,
      bootId: BOOT_ID,
      running: status.running.map(named),
      pausing: status.pausing.map(named),
    };
  };
  app.get('/api/daemon/update', (c) => c.json(view()));

  app.post('/api/daemon/update', async (c) => {
    const body = await c.req.json<{ action?: unknown }>().catch(() => ({}) as { action?: unknown });
    const action = body.action;
    const done =
      action === 'restart'
        ? roll.requestRestart('the owner asked')
        : action === 'restart-now'
          ? roll.restartNow()
          : action === 'pause-now'
            ? roll.pauseNow()
            : action === 'postpone'
              ? roll.postpone()
              : action === 'update-now'
                ? roll.updateNow()
                : null;
    if (done === null)
      return c.json(
        { error: 'action must be restart, pause-now, restart-now, postpone or update-now' },
        400,
      );
    if (!done) return c.json({ error: `nothing to ${action} (${roll.status().phase})` }, 409);
    return c.json(view());
  });
}
