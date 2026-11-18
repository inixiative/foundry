/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Status → Processes: a task manager for this Foundry. The daemon and everything it runs (each
 * project's Warden hosts, primed one-shots, each thread's native session and its MCP servers, the
 * tunnel), each with its memory, CPU and age, re-read every few seconds while the Status view is
 * open (`/api/machine/processes`, `viewer/machine-processes.ts`). Siblings that are the same thing
 * (a pile of one-shots) fold into one row with a count, so a leak shows as a number.
 */

import { html, useEffect, useState } from './lib.js';
import { authFetch, selectThread } from './store.js';

const PROCESSES_EVERY_MS = 5_000;
/** Siblings of the same kind fold into one row from this many. */
const FOLD_FROM = 3;

function useProcesses() {
  const [state, setState] = useState({ root: undefined, error: null });
  useEffect(() => {
    let live = true;
    const read = () =>
      authFetch('/api/machine/processes')
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then((body) => live && setState({ root: body.root, error: null }))
        .catch(
          (error) => live && setState((s) => ({ ...s, error: String(error.message ?? error) })),
        );
    read();
    const timer = setInterval(read, PROCESSES_EVERY_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return state;
}

const memory = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);
const age = (s) =>
  s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m`
      : s < 86_400
        ? `${Math.floor(s / 3600)}h`
        : `${Math.floor(s / 86_400)}d`;
const modelName = (model) => model?.replace(/^claude-/, '').replace(/-\d+(-\d+)*$/, '');

/** Siblings of one kind (role, label, model) with no children of their own fold into a group. */
function fold(children) {
  const groups = new Map();
  for (const child of children) {
    const key = child.children.length
      ? `pid:${child.pid}`
      : `${child.role}\0${child.label}\0${child.model ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), child]);
  }
  return [...groups.values()]
    .flatMap((members) =>
      members.length < FOLD_FROM
        ? members.map((p) => ({ ...p, count: 1, members: [p] }))
        : [
            {
              ...members[0],
              count: members.length,
              members,
              treeRssMb: members.reduce((mb, p) => mb + p.treeRssMb, 0),
              treeCpu: Math.round(members.reduce((cpu, p) => cpu + p.treeCpu, 0) * 10) / 10,
              ageSeconds: Math.min(...members.map((p) => p.ageSeconds)),
            },
          ],
    )
    .sort((a, b) => b.treeRssMb - a.treeRssMb);
}

function ProcessRow({ process, depth }) {
  const [open, setOpen] = useState(false);
  const rows = process.count > 1 ? process.members : process.children;
  const expandable = rows.length > 0;
  const model = modelName(process.model);
  const title =
    process.count > 1
      ? process.members.map((p) => p.pid).join(', ')
      : `${process.pid}: ${process.command}`;
  const onClick = () => {
    if (process.threadId && process.count === 1 && !expandable)
      return selectThread(process.threadId);
    if (expandable) setOpen((o) => !o);
  };
  return html`<li class="machine-process">
    <button type="button" class="machine-status-row machine-process-row" style=${`padding-left:${depth * 12}px`} title=${title} onClick=${onClick}>
      <span class="machine-status-caret">${expandable ? (open ? '▾' : '▸') : ''}</span>
      <span class=${`machine-status-dot is-${process.role}`}></span>
      <span class="machine-status-name">${process.label}${model ? html` <span class="machine-status-dim">${model}</span>` : null}${process.count > 1 ? html` <b>×${process.count}</b>` : null}</span>
      ${
        process.threadId && process.count === 1
          ? html`<span class="machine-process-open" onClick=${(e) => {
              e.stopPropagation();
              selectThread(process.threadId);
            }} title="Open the thread">↗</span>`
          : null
      }
      <span class="machine-process-num">${memory(process.treeRssMb)}</span>
      <span class="machine-process-num">${process.treeCpu}%</span>
      <span class="machine-process-num machine-status-dim">${age(process.ageSeconds)}</span>
    </button>
    ${
      open
        ? html`<ul class="machine-processes">
            ${(
              process.count > 1 ? rows.map((p) => ({ ...p, count: 1, members: [p] })) : fold(rows)
            ).map(
              (child) =>
                html`<${ProcessRow} key=${child.pid} process=${child} depth=${depth + 1} />`,
            )}
          </ul>`
        : null
    }
  </li>`;
}

export function MachineProcesses() {
  const { root, error } = useProcesses();
  if (root === undefined && !error) return null;
  return html`<div class="machine-status-processes">
    <div class="machine-status-label">Processes${root ? html` <span class="machine-status-dim">${memory(root.treeRssMb)} · ${root.treeCpu}%</span>` : null}</div>
    ${error && !root ? html`<div class="machine-status-dim">Couldn't read the processes: ${error}</div>` : null}
    ${
      root
        ? html`<ul class="machine-processes">
            <${ProcessRow} process=${{ ...root, children: [], count: 1, members: [root], treeRssMb: root.rssMb, treeCpu: root.cpu }} depth=${0} />
            ${fold(root.children).map((child) => html`<${ProcessRow} key=${child.pid} process=${child} depth=${0} />`)}
          </ul>`
        : null
    }
  </div>`;
}
