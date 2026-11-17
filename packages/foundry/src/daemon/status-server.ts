/**
 * @atlas
 * @kind service
 * @partOf feature:daemon
 */
/**
 * The supervisor's server on the viewer's port while no release answers there: the status page at
 * every address, its status, and Start. An open viewer reloads itself when the daemon's boot id
 * changes (`/api/daemon/update`), so answering that with this process's id brings every open tab
 * to the status page, and the page reloads to Foundry at the same address once it is up. Only this
 * machine is answered (a loopback host, no proxy headers, same origin): the page has no login.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { directLoopback, sameOrigin } from '../viewer/request-auth';
import { THEME_PATH_PREFIX, themeDirectory, themeFile } from '../viewer/theme-files';
import { type DaemonLiveStatus, readDaemonStatus } from './status';

export interface StatusServerOptions {
  readonly port: number;
  readonly configDir: string;
  readonly live: () => DaemonLiveStatus;
  /** The owner pressed Start (or Try again) on a held daemon. */
  readonly requestStart: () => void;
}

export interface StatusServer {
  readonly port: number;
  /** Stops answering and frees the port. */
  stop(): Promise<void>;
}

const UI_DIR = fileURLToPath(new URL('../viewer/ui/', import.meta.url));
const notFound = () => new Response('Not found', { status: 404 });

const file = async (path: string): Promise<Response> => {
  const body = Bun.file(path);
  return (await body.exists())
    ? new Response(body, { headers: { 'Content-Type': body.type, 'Cache-Control': 'no-store' } })
    : notFound();
};

export function startStatusServer(options: StatusServerOptions): StatusServer {
  const theme = themeDirectory();
  const server = Bun.serve({
    port: options.port,
    hostname: '127.0.0.1',
    async fetch(request) {
      if (!directLoopback(request) || !sameOrigin(request))
        return Response.json(
          { error: 'The status page answers this machine only' },
          { status: 403 },
        );
      const { pathname } = new URL(request.url);
      if (pathname === '/api/daemon/status')
        return Response.json(await readDaemonStatus(options.configDir, options.live()), {
          headers: { 'Cache-Control': 'no-store' },
        });
      if (pathname === '/api/daemon/start') {
        if (request.method !== 'POST')
          return Response.json({ error: 'POST starts Foundry' }, { status: 405 });
        if (options.live().phase !== 'held')
          return Response.json({ error: 'Foundry is already starting' }, { status: 409 });
        options.requestStart();
        return Response.json({ started: true });
      }
      // What an open viewer polls: a boot id that is not its daemon's reloads it onto this page.
      if (pathname === '/api/daemon/update')
        return Response.json({ bootId: options.live().bootId, phase: 'restarting' });
      if (pathname.startsWith('/api/') || pathname === '/ws')
        return Response.json(
          { error: 'Foundry is not running', statusUrl: '/status' },
          { status: 503, headers: { 'Retry-After': '5' } },
        );
      if (pathname === '/ui/favicon.svg') return file(resolve(UI_DIR, 'favicon.svg'));
      if (pathname.startsWith(THEME_PATH_PREFIX))
        return (theme ? await themeFile(theme, pathname) : undefined) ?? notFound();
      if (pathname.startsWith('/ui/')) return notFound();
      if (request.method !== 'GET' && request.method !== 'HEAD')
        return Response.json({ error: 'Foundry is not running' }, { status: 503 });
      return file(resolve(UI_DIR, 'status.html'));
    },
  });
  return {
    port: server.port ?? options.port,
    stop: async () => {
      await server.stop(true);
    },
  };
}
