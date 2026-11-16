/**
 * @atlas
 * @kind route
 * @partOf feature:daemon, feature:viewer
 */
import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import type { AgentCliReport } from '../../daemon/agent-cli-update';
import type { RestartRoll } from '../../daemon/restart-roll';

/** This daemon process: a viewer that sees it change reloads onto the new build. */
const BOOT_ID = randomUUID();

/**
 * The spin-down as the viewer sees it (`daemon/restart-roll.ts`): the update state with the turns a
 * restart waits for, and the owner's choices, with what the last daemon start did to the agent CLIs
 * (`agentClis`, from `<config>/agent-clis.json`; absent before a daemon start writes it). Mounted
 * behind the viewer's operator authentication.
 */
export function registerDaemonUpdateRoutes(
  app: Hono,
  roll: RestartRoll,
  threadName: (threadId: string) => string | undefined,
  agentClis: () => Promise<AgentCliReport | undefined> = async () => undefined,
): void {
  const view = async () => {
    const status = roll.status();
    const report = await agentClis();
    const named = (turn: { threadId: string; turnId: string }) => ({
      ...turn,
      ...(threadName(turn.threadId) ? { name: threadName(turn.threadId) } : {}),
    });
    return {
      ...status,
      bootId: BOOT_ID,
      running: status.running.map(named),
      pausing: status.pausing.map(named),
      ...(report ? { agentClis: report } : {}),
    };
  };
  app.get('/api/daemon/update', async (c) => c.json(await view()));

  app.post('/api/daemon/update', async (c) => {
    const body = await c.req.json<{ action?: unknown }>().catch(() => ({}) as { action?: unknown });
    const action = body.action;
    const done =
      action === 'restart-now'
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
        { error: 'action must be pause-now, restart-now, postpone or update-now' },
        400,
      );
    if (!done) return c.json({ error: `nothing to ${action} (${roll.status().phase})` }, 409);
    return c.json(await view());
  });
}
