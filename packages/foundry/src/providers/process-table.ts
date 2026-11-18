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

/** Parses `ps -A -o pid=,ppid=,rss=,%cpu=,etime=,command=` output. */
export function parseProcessTable(out: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, rss, cpu, etime, command] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
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

/** The whole table now, or undefined when `ps` can't run. */
export function readProcessTable(): ProcessRow[] | undefined {
  try {
    const out = Bun.spawnSync([
      '/bin/ps',
      '-A',
      '-o',
      'pid=,ppid=,rss=,%cpu=,etime=,command=',
    ]).stdout.toString();
    return parseProcessTable(out);
  } catch {
    return undefined;
  }
}

/** Each process's children, by parent pid. */
export function childrenByParent(table: readonly ProcessRow[]): Map<number, ProcessRow[]> {
  const children = new Map<number, ProcessRow[]>();
  for (const row of table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
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

/** Resident memory (MB) of `pid` and every process below it (scripts/measure-in-session.ts). */
export function processTreeRssMb(pid: number): number | undefined {
  const table = readProcessTable();
  if (!table) return undefined;
  const tree = processTree(table, pid);
  if (!tree.length) return undefined;
  return Math.round(tree.reduce((kb, row) => kb + row.rssKb, 0) / 1024);
}
