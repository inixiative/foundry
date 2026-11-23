/**
 * @atlas
 * @kind service
 * @partOf feature:viewer
 */
/**
 * The Status view's process list: the daemon and every process below it, each named for what it is
 * (a project's Warden host, a one-shot, a thread's native session, an MCP server), with its memory, CPU and age. Read from the machine's process table
 * (`providers/process-table.ts`); the project Warden hosts name their own pids, and a native session
 * resumed with `--resume <id>` is matched to its thread through the journal.
 */
import { childrenByParent, type ProcessRow } from '../providers/process-table';
import type { ProjectHostState } from '../providers/project-warden-hosts';

export type MachineProcessRole =
  | 'daemon'
  | 'warden-host'
  | 'one-shot'
  | 'thread'
  | 'session'
  | 'mcp'
  | 'other';

export interface MachineProcess {
  readonly pid: number;
  readonly role: MachineProcessRole;
  readonly label: string;
  /** The model a native CLI runs, when its command line names one. */
  readonly model?: string;
  readonly threadId?: string;
  readonly rssMb: number;
  readonly cpu: number;
  readonly ageSeconds: number;
  /** The command line; for an `other` process (an agent's shell, which can carry what a person typed) only its label. */
  readonly command: string;
  /** This process and everything below it. */
  readonly treeRssMb: number;
  readonly treeCpu: number;
  readonly children: MachineProcess[];
}

export interface MachineProcessSources {
  /** The project Warden hosts' states, keyed by project (and lane), as their snapshot names them. */
  readonly hosts?: Record<string, ProjectHostState>;
  /** A project's label, by id. */
  readonly projectLabel?: (projectId: string) => string | undefined;
  /** The thread a native session id belongs to. */
  readonly threadOfSession?: (sessionId: string) => string | undefined;
  /** A thread's name. */
  readonly threadName?: (threadId: string) => string | undefined;
}

const flag = (command: string, name: string) =>
  new RegExp(`(?:^|\\s)${name}(?:\\s+|=)(\\S+)`).exec(command)?.[1];

const isNativeCli = (command: string) =>
  /(?:^|\/)(claude|codex|muse|agy|gemini)(?:\s|$)/.test(command);

/** What one process is, from its command line and what Foundry knows of its pid. */
function identify(
  row: ProcessRow,
  sources: MachineProcessSources,
  hostByPid: Map<number, { projectId: string; state: ProjectHostState }>,
): Pick<MachineProcess, 'role' | 'label' | 'model' | 'threadId'> {
  const command = row.command;
  const model = flag(command, '--model');
  const withModel = model ? { model } : {};
  const host = hostByPid.get(row.pid);
  if (host) {
    const project = sources.projectLabel?.(host.projectId) ?? host.projectId;
    return {
      role: 'warden-host',
      label: `Wardens · ${project}${host.state.lane ? ` (${host.state.lane})` : ''}`,
      ...withModel,
    };
  }
  if (isNativeCli(command)) {
    if (flag(command, '--max-turns') === '1')
      return { role: 'one-shot', label: 'Warden one-shot', ...withModel };
    const resumed = flag(command, '--resume');
    if (resumed) {
      const threadId = sources.threadOfSession?.(resumed);
      const name = threadId ? sources.threadName?.(threadId) : undefined;
      return {
        role: 'thread',
        label: name ?? (threadId ? 'Thread' : 'Native session'),
        ...withModel,
        ...(threadId ? { threadId } : {}),
      };
    }
    if (/\bapp-server\b/.test(command)) return { role: 'session', label: 'Codex app server' };
    if (/(?:^|\/)agy\b.*\bacp\b/.test(command))
      return { role: 'session', label: 'Antigravity ACP session', ...withModel };
    if (/(?:^|\/)gemini\b.*--acp\b/.test(command))
      return { role: 'session', label: 'Gemini CLI ACP session', ...withModel };
    return { role: 'session', label: 'Native session', ...withModel };
  }
  // Only the program and its first arguments: a shell's script can mention anything.
  const head = command.split(/\s+/).slice(0, 3).join(' ');
  if (/\/mcp\/proxy\.ts\b/.test(head)) return { role: 'mcp', label: 'Foundry tools bridge' };
  if (/playwright[-/]mcp|@playwright\/mcp/.test(head))
    return { role: 'mcp', label: 'Playwright MCP' };
  if (/(?:^|[/@\s-])mcp(?:$|[\s@/-]|-server)/i.test(head))
    return { role: 'mcp', label: 'MCP server' };
  const [program = command, first] = command.split(/\s+/);
  const name = program.split('/').pop() ?? program;
  return {
    role: 'other',
    label: first && !first.startsWith('-') ? `${name} ${first.split('/').pop()}` : name,
  };
}

/**
 * The tree under `rootPid` (the daemon), each process named; undefined when `rootPid` is not in
 * the table.
 */
export function machineProcesses(
  table: readonly ProcessRow[],
  rootPid: number,
  sources: MachineProcessSources = {},
): MachineProcess | undefined {
  const root = table.find((row) => row.pid === rootPid);
  if (!root) return undefined;
  const children = childrenByParent(table);
  const hostByPid = new Map<number, { projectId: string; state: ProjectHostState }>();
  for (const [key, state] of Object.entries(sources.hosts ?? {}))
    if (state.pid !== undefined)
      // A lane's snapshot key is `<project> (<lane>)`; the label names the lane from its state.
      hostByPid.set(state.pid, {
        projectId: state.lane ? key.replace(` (${state.lane})`, '') : key,
        state,
      });
  const seen = new Set<number>();
  const build = (row: ProcessRow, isRoot: boolean): MachineProcess => {
    seen.add(row.pid);
    const kids = (children.get(row.pid) ?? [])
      .filter((child) => !seen.has(child.pid))
      .map((child) => build(child, false));
    const rssMb = Math.round(row.rssKb / 1024);
    const what = isRoot
      ? { role: 'daemon' as const, label: 'Foundry daemon' }
      : identify(row, sources, hostByPid);
    return {
      pid: row.pid,
      ...what,
      rssMb,
      cpu: row.cpu,
      ageSeconds: row.ageSeconds,
      treeRssMb: rssMb + kids.reduce((mb, kid) => mb + kid.treeRssMb, 0),
      treeCpu: Math.round((row.cpu + kids.reduce((cpu, kid) => cpu + kid.treeCpu, 0)) * 10) / 10,
      command: what.role === 'other' ? what.label : row.command,
      children: kids,
    };
  };
  return build(root, true);
}
