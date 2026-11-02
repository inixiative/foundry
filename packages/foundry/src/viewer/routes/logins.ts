/**
 * @atlas
 * @kind route
 * @partOf feature:viewer, feature:nativeAuth
 */
/**
 * This machine's subscription logins and how they are balanced (Aron, 2026-11-02): add a login (its
 * sign-in runs here, finished in the browser), name or remove one, set a runtime's balancing, and
 * read each runtime's pool: whether it is balancing across how many logins or why it stopped, each
 * login's status, meters and turns in the last five hours, and the last turns' logins. The footer,
 * Settings › Providers and Analytics read the same record. Tokens never appear in any response.
 */
import { rmSync } from 'node:fs';
import type { Hono } from 'hono';
import type { LoginPoolAuthentication, LoginRunLog, PoolState } from '../../providers/login-pool';
import { type LoginSetup, removeLogin, renameLogin } from '../../providers/login-setup';
import {
  LOGIN_ROUTINGS,
  type LoginPoolSettings,
  type LoginRouting,
  loginPoolSettings,
  POOLED_RUNTIMES,
  type PooledRuntime,
} from '../../providers/subscription-policy';
import type { ConfigStore } from '../config';

export interface LoginRoutesDeps {
  configStore: ConfigStore;
  foundryDir: string;
  pools: Partial<Record<PooledRuntime, LoginPoolAuthentication>>;
  setup: LoginSetup;
  runs: LoginRunLog;
}

const isRuntime = (value: string): value is PooledRuntime =>
  (POOLED_RUNTIMES as readonly string[]).includes(value);

export function registerLoginRoutes(app: Hono, deps: LoginRoutesDeps): void {
  const { configStore, pools, setup } = deps;

  /** Every pool with its readings refreshed when stale (no model turn; cached a few minutes per login). */
  app.get('/api/providers/pools', async (c) => {
    await configStore.load();
    const project = c.req.query('project') || undefined;
    if (project && !configStore.config.projects[project])
      return c.json({ error: 'No such project' }, 404);
    const states: PoolState[] = [];
    for (const runtime of POOLED_RUNTIMES) {
      const pool = pools[runtime];
      if (!pool) continue;
      await Promise.all([pool.refresh(), pool.checkLogins()]);
      const state = pool.state(loginPoolSettings(configStore.config, runtime, project));
      // A sign-in in progress shows as a login signing in.
      for (const pending of setup.list())
        if (pending.runtime === runtime && pending.state === 'signing-in')
          state.logins.push({
            id: pending.id,
            name: pending.name,
            own: false,
            status: 'signing-in',
            runs: 0,
            preferred: false,
          });
      // Projects that balance this runtime their own way: the footer's scale doesn't move them.
      const overrides = Object.entries(configStore.config.projects ?? {})
        .filter(([id, p]) => id !== project && p.subscriptionPools?.[runtime])
        .map(([id, p]) => ({ projectId: id, name: p.label ?? id }));
      states.push({ ...state, overrides });
    }
    // Projects that run on a Kingdom pool: Kingdom balances those, not this machine.
    const kingdom = Object.entries(configStore.config.projects ?? {})
      .filter(([, p]) => p.enabled !== false && p.capacity === 'kingdom')
      .map(([id, p]) => ({ projectId: id, name: p.label ?? id }));
    return c.json({ pools: states, setups: setup.list(), kingdom });
  });

  /** The logins each turn of a thread ran on. */
  app.get('/api/providers/runs', (c) => {
    const thread = c.req.query('thread');
    if (!thread) return c.json({ error: 'thread is required' }, 400);
    return c.json({ runs: deps.runs.ofThread(thread) });
  });

  /** A runtime's balancing: `routing`, the login it prefers, and `pinned` (the scale off); null clears. */
  app.patch('/api/providers/pools/:runtime', async (c) => {
    const runtime = c.req.param('runtime');
    if (!isRuntime(runtime))
      return c.json({ error: 'Only Claude and Codex logins are pooled' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as {
      routing?: LoginRouting | null;
      preferredLoginId?: string | null;
      pinned?: boolean | null;
      project?: string;
    };
    if (body.pinned != null && typeof body.pinned !== 'boolean')
      return c.json({ error: 'pinned must be true or false' }, 400);
    if (body.routing != null && !LOGIN_ROUTINGS.includes(body.routing))
      return c.json({ error: `routing must be one of ${LOGIN_ROUTINGS.join(', ')}` }, 400);
    try {
      await configStore.update((draft) => {
        const holder = body.project ? draft.projects[body.project] : draft;
        if (!holder) throw Error('No such project');
        holder.subscriptionPools ??= {};
        const pools = holder.subscriptionPools;
        const next: LoginPoolSettings = { ...pools[runtime] };
        if (body.routing === null) delete next.routing;
        else if (body.routing) next.routing = body.routing;
        if (body.preferredLoginId === null) delete next.preferredLoginId;
        else if (body.preferredLoginId) next.preferredLoginId = body.preferredLoginId;
        if (body.pinned === null || body.pinned === false) delete next.pinned;
        else if (body.pinned) next.pinned = true;
        if (Object.keys(next).length) pools[runtime] = next;
        else delete pools[runtime];
        if (!Object.keys(pools).length) delete holder.subscriptionPools;
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    return c.json({ ok: true });
  });

  /** Add a login: its sign-in starts here; the page polls it and may send the code it asks for. */
  app.post('/api/providers/logins', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { runtime?: string; name?: string };
    if (!body.runtime || !isRuntime(body.runtime))
      return c.json({ error: 'runtime must be claude or codex' }, 400);
    try {
      return c.json(setup.start(body.runtime, body.name ?? ''));
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.get('/api/providers/logins/setup/:id', (c) => {
    const view = setup.get(c.req.param('id'));
    return view ? c.json(view) : c.json({ error: 'No such sign-in' }, 404);
  });

  app.post('/api/providers/logins/setup/:id/code', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { code?: string };
    try {
      setup.sendCode(c.req.param('id'), body.code ?? '');
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.delete('/api/providers/logins/setup/:id', (c) => {
    setup.cancel(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.patch('/api/providers/logins/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    try {
      await configStore.update((draft) => renameLogin(draft, c.req.param('id'), body.name ?? ''));
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.delete('/api/providers/logins/:id', async (c) => {
    const id = c.req.param('id');
    const running = Object.values(pools).reduce((n, pool) => n + (pool?.inUse(id) ?? 0), 0);
    if (running)
      return c.json(
        {
          error: `${running} thread${running === 1 ? ' is' : 's are'} running on this login; stop ${running === 1 ? 'it' : 'them'} or wait for ${running === 1 ? 'it' : 'them'} to finish, then remove it`,
        },
        409,
      );
    let remove: string | undefined;
    try {
      await configStore.update((draft) => {
        remove = removeLogin(draft, id, deps.foundryDir).remove;
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    // The home Foundry made for it, with its token; this machine's own login location is never touched.
    if (remove) rmSync(remove, { recursive: true, force: true });
    return c.json({ ok: true });
  });
}
