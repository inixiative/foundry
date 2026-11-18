/**
 * @atlas
 * @kind service
 * @partOf feature:viewer, feature:wardens
 */
/**
 * The machine's process table, read once from `ps`: every process with its parent, resident memory,
 * CPU, age and command line. The project Warden hosts read their memory from it and the Status
 * view's process list (`viewer/machine-processes.ts`) reads the daemon's tree from it.
 */

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly rssKb: number;
  /** `ps` %cpu: recent CPU use, 100 per core. */
  readonly cpu: number;
  readonly ageSeconds: number;
  readonly command: string;
}

/** `ps` etime, `[[dd-]hh:]mm:ss`, in seconds. */
export function elapsedSeconds(etime: string): number {
  const [days, clock] = etime.includes('-') ? etime.split('-') : ['0', etime];
  const parts = (clock ?? '').split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts as [number, number, number];
  return Number(days) * 86_400 + h * 3600 + m * 60 + s;
}

const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/;
const MEMORY_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/;

/** Parses `ps -A -o pid=,ppid=,rss=,%cpu=,etime=,command=` output (in the C locale). */
export function parseProcessTable(out: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of out.split('\n')) {
    const match = ROW.exec(line);
    if (!match) continue;
    const [, pid = '', ppid = '', rss = '', cpu = '', etime = '', command = ''] = match;
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      rssKb: Number(rss),
      cpu: Number(cpu),
      ageSeconds: elapsedSeconds(etime),
      command: command.trim(),
    });
  }
  return rows;
}

const PS = '/bin/ps';
const FULL_COLUMNS = 'pid=,ppid=,rss=,%cpu=,etime=,command=';
// why: a comma-decimal locale prints %cpu as `3,6`, which no row pattern would read.
const PS_ENV = { ...process.env, LC_ALL: 'C' };

/** The whole table, read without blocking the event loop; undefined when `ps` can't run. */
export async function fetchProcessTable(): Promise<ProcessRow[] | undefined> {
  try {
    const run = Bun.spawn([PS, '-A', '-o', FULL_COLUMNS], { env: PS_ENV, stdout: 'pipe' });
    const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited]);
    return code === 0 ? parseProcessTable(out) : undefined;
  } catch {
    return undefined;
  }
}

/** Pid, parent and memory only: the narrow read the Warden hosts' health check runs every tick. */
function readMemoryTable(): ProcessRow[] | undefined {
  try {
    const run = Bun.spawnSync([PS, '-A', '-o', 'pid=,ppid=,rss='], { env: PS_ENV });
    if (!run.success) return undefined;
    const rows: ProcessRow[] = [];
    for (const line of run.stdout.toString().split('\n')) {
      const match = MEMORY_ROW.exec(line);
      if (!match) continue;
      const [, pid = '', ppid = '', rss = ''] = match;
      rows.push({
        pid: Number(pid),
        ppid: Number(ppid),
        rssKb: Number(rss),
        cpu: 0,
        ageSeconds: 0,
        command: '',
      });
    }
    return rows;
  } catch {
    return undefined;
  }
}

/** Each process's children, by parent pid. */
export function childrenByParent(table: readonly ProcessRow[]): Map<number, ProcessRow[]> {
  const children = new Map<number, ProcessRow[]>();
  for (const row of table) {
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row);
    else children.set(row.ppid, [row]);
  }
  return children;
}

/** `pid` and every process below it. */
export function processTree(table: readonly ProcessRow[], pid: number): ProcessRow[] {
  const children = childrenByParent(table);
  const root = table.find((row) => row.pid === pid);
  if (!root) return [];
  const seen = new Set<number>();
  const out: ProcessRow[] = [];
  const walk = (row: ProcessRow) => {
    if (seen.has(row.pid)) return;
    seen.add(row.pid);
    out.push(row);
    for (const child of children.get(row.pid) ?? []) walk(child);
  };
  walk(root);
  return out;
}

/** Resident memory (MB) of `pid` and every process below it. */
export function processTreeRssMb(pid: number): number | undefined {
  const table = readMemoryTable();
  if (!table) return undefined;
  const tree = processTree(table, pid);
  if (!tree.length) return undefined;
  return Math.round(tree.reduce((kb, row) => kb + row.rssKb, 0) / 1024);
}
