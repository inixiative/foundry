/**
 * @atlas
 * @kind route
 * @partOf feature:viewer
 */
import type { Hono } from 'hono';
import { readProcessTable } from '../../providers/process-table';
import type { ProjectHostState } from '../../providers/project-warden-hosts';
import { machineProcesses } from '../machine-processes';

export interface MachineProcessRouteDeps {
  /** The project Warden hosts' snapshot (`ProjectWardenHosts.snapshot`), when they run. */
  readonly hosts?: () => { projects: Record<string, ProjectHostState> } | undefined;
  readonly projectLabel: (projectId: string) => string | undefined;
  /** The journal's thread for a native session id (`LocalSessionStore.threadOfNativeSession`). */
  readonly threadOfSession?: (sessionId: string) => string | undefined;
  readonly threadName: (threadId: string) => string | undefined;
}

/** A session id the journal didn't know is asked again after this long. */
const UNKNOWN_SESSION_RETRY_MS = 60_000;

/** Status → Processes: the daemon's process tree, each process named (`viewer/machine-processes.ts`). */
export function registerMachineProcessRoutes(app: Hono, deps: MachineProcessRouteDeps) {
  // A session's thread never changes; the lookup scans the journal, so each id is asked once.
  const known = new Map<string, string>();
  const unknown = new Map<string, number>();
  const threadOfSession = (sessionId: string) => {
    const hit = known.get(sessionId);
    if (hit) return hit;
    if (Date.now() - (unknown.get(sessionId) ?? 0) < UNKNOWN_SESSION_RETRY_MS) return undefined;
    const threadId = deps.threadOfSession?.(sessionId);
    if (threadId) {
      known.set(sessionId, threadId);
      unknown.delete(sessionId);
    } else unknown.set(sessionId, Date.now());
    return threadId;
  };
  app.get('/api/machine/processes', (c) => {
    const table = readProcessTable();
    if (!table) return c.json({ error: 'The process table could not be read' }, 503);
    const hosts = deps.hosts?.()?.projects;
    const root = machineProcesses(table, process.pid, {
      ...(hosts ? { hosts } : {}),
      projectLabel: deps.projectLabel,
      threadOfSession,
      threadName: deps.threadName,
    });
    return c.json({ root: root ?? null, readAt: Date.now() });
  });
}
