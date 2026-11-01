/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Background shells from a thread's tool calls: a Bash call run in the background, then BashOutput
 * and KillShell on its id. Pure, so it is tested without a browser.
 */

const SHELL_ID = /(?:background with ID|shell_id|bash_id)[:\s"]*([A-Za-z0-9_-]+)/i;
const PORT = /(?:PORT=|--port[ =]|-p\s|localhost:|127\.0\.0\.1:)(\d{4,5})/;

/** The thread's background shells, from its recent turns' tool calls, newest first. */
export function backgroundShells(turns) {
  const shells = new Map();
  const uses = (turns ?? []).flatMap((t) => (Array.isArray(t.toolUses) ? t.toolUses : []));
  for (const use of uses) {
    const input = use.toolInput ?? {};
    if (use.toolName === 'Bash' && input.run_in_background === true) {
      const id =
        SHELL_ID.exec(use.toolOutput ?? '')?.[1] ?? use.callId ?? `shell-${shells.size + 1}`;
      const command = String(input.command ?? '');
      shells.set(id, {
        id,
        label: String(input.description ?? command.split(/\s+/).slice(0, 3).join(' ')),
        command,
        port: PORT.exec(command)?.[1] ?? null,
        startedAt: use.observedAt ?? null,
        state: 'running',
        output: [use.toolOutput ?? ''].filter(Boolean),
      });
    }
  }
  for (const use of uses) {
    const input = use.toolInput ?? {};
    const id = String(input.bash_id ?? input.shell_id ?? '');
    const shell = shells.get(id);
    if (!shell) continue;
    if (use.toolName === 'KillShell') shell.state = 'stopped';
    if (use.toolName === 'BashOutput') {
      if (use.toolOutput) shell.output.push(use.toolOutput);
      const status = /<status>(\w+)<\/status>/.exec(use.toolOutput ?? '')?.[1];
      if (status && status !== 'running') shell.state = status === 'completed' ? 'passed' : status;
    }
  }
  return [...shells.values()].reverse();
}
