/**
 * @atlas
 * @kind route
 * @partOf feature:scheduler, feature:viewer
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Scheduler } from '../../scheduler/scheduler';
import { scheduleSchema, scheduleWhereSchema } from '../../scheduler/types';

/** The owner's own save: never a draft (what he writes is his), its due times Foundry's to keep. */
const saveBody = z.strictObject({
  schedule: scheduleSchema.omit({ since: true, draft: true, scope: true }),
  where: scheduleWhereSchema,
});
const pauseBody = z.strictObject({ paused: z.boolean() });

const failure = (error: unknown) => ({ error: (error as Error).message ?? String(error) });

/** The Scheduled view's API, behind the viewer's operator authentication: every call is the owner's. */
export function registerScheduleRoutes(app: Hono, scheduler: Scheduler): void {
  app.get('/api/schedules', (c) => c.json({ schedules: scheduler.list() }));

  // A removed schedule's runs stay readable: the history outlives it.
  app.get('/api/schedules/:id/runs', (c) => {
    const id = c.req.param('id');
    const limit = Number(c.req.query('limit') ?? 50);
    return c.json({
      runs: scheduler.runs(id, Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 50),
    });
  });

  app.put('/api/schedules/:id', async (c) => {
    const parsed = saveBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error: parsed.error.issues
            .map((issue) => `${issue.path.join('.')} ${issue.message}`)
            .join('; '),
        },
        400,
      );
    if (parsed.data.schedule.id !== c.req.param('id'))
      return c.json({ error: 'the schedule id is the path id' }, 400);
    try {
      return c.json({ schedule: await scheduler.save(parsed.data.schedule, parsed.data.where) });
    } catch (error) {
      return c.json(failure(error), 400);
    }
  });

  app.delete('/api/schedules/:id', async (c) => {
    try {
      await scheduler.remove(c.req.param('id'));
      return c.json({ ok: true });
    } catch (error) {
      return c.json(failure(error), 404);
    }
  });

  app.post('/api/schedules/:id/pause', async (c) => {
    const parsed = pauseBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'paused is true or false' }, 400);
    try {
      return c.json({ schedule: await scheduler.setPaused(c.req.param('id'), parsed.data.paused) });
    } catch (error) {
      return c.json(failure(error), 400);
    }
  });

  app.post('/api/schedules/:id/accept', async (c) => {
    try {
      return c.json({ schedule: await scheduler.accept(c.req.param('id')) });
    } catch (error) {
      return c.json(failure(error), 400);
    }
  });

  app.post('/api/schedules/:id/run', async (c) => {
    try {
      return c.json({ run: await scheduler.runNow(c.req.param('id')) });
    } catch (error) {
      return c.json(failure(error), 400);
    }
  });
}
