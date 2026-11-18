/**
 * @atlas
 * @kind route
 * @partOf feature:viewer
 */
import type { Hono } from 'hono';
import { fetchProcessTable, type ProcessRow } from '../../providers/process-table';
import type { ProjectHostState } from '../../providers/project-warden-hosts';
import { machineProcesses } from '../machine-processes';

export interface MachineProcessRouteDeps {
  /** The project Warden hosts' snapshot (`ProjectWardenHosts.snapshot`), when they run. */
  readonly hosts?: () => { projects: Record<string, ProjectHostState> } | undefined;
  readonly projectLabel: (projectId: string) => string | undefined;
  /**
   * Every native session binding (`FileExternalSessionStore.all`, `sessions.json`, held in memory):
   * the id a thread's CLI is resumed with, by its Foundry session key `<thread id>:…`.
   */
  readonly sessionBindings?: () => Promise<
    ReadonlyArray<{ threadId: string; externalSessionId: string }>
  >;
  readonly threadName: (threadId: string) => string | undefined;
}

/** Tabs polling together share one read of the process table. */
const TABLE_TTL_MS = 1_000;

/** Status → Processes: the daemon's process tree, each process named (`viewer/machine-processes.ts`). */
export function registerMachineProcessRoutes(app: Hono, deps: MachineProcessRouteDeps) {
  let cached: { at: number; table: Promise<ProcessRow[] | undefined> } | undefined;
  const table = () => {
    if (!cached || Date.now() - cached.at > TABLE_TTL_MS)
      cached = { at: Date.now(), table: fetchProcessTable() };
    return cached.table;
  };
  app.get('/api/machine/processes', async (c) => {
    const [rows, bindings] = await Promise.all([
      table(),
      deps.sessionBindings?.().catch(() => []) ?? [],
    ]);
    if (!rows) return c.json({ error: 'The process table could not be read' }, 503);
    // A session key is `<thread id>:<auth…>`; the thread id is everything before its first colon.
    const threadBySession = new Map(
      bindings.map((b) => [b.externalSessionId, b.threadId.split(':')[0] ?? b.threadId]),
    );
    const hosts = deps.hosts?.()?.projects;
    const root = machineProcesses(rows, process.pid, {
      ...(hosts ? { hosts } : {}),
      projectLabel: deps.projectLabel,
      threadOfSession: (sessionId) => threadBySession.get(sessionId),
      threadName: deps.threadName,
    });
    return c.json({ root: root ?? null, readAt: Date.now() });
  });
}
