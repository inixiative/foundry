// A Claude CLI double for a session that hosts Foundry's in-session Wardens (agent-session
// ClaudeInSessionDecisions): the main model's setup turn, nested background agents started through
// the PreToolUse callback, and the host's SDK MCP server over the control channel. Ported from
// agent-session's tests/claude-in-session.test.ts double; a member answers `ANS:<its moment>`.

/** One spawned process of the double. */
interface FakeTreeProcess {
  readonly argv: string[];
  readonly env: Record<string, string | undefined>;
  readonly pid: number;
  /** End it as a crash would. */
  crash(): void;
  readonly exited: boolean;
}

export function fakeClaudeTree(behavior: { noRoot?: boolean } = {}) {
  const processes: FakeTreeProcess[] = [];
  const moments: string[] = [];
  const memberPrompts: string[] = [];
  let pid = 90_000;
  const spawn = (argv: string[], options: { env: Record<string, string | undefined> }) => {
    let out!: ReadableStreamDefaultController<Uint8Array>;
    let exit!: (code: number) => void;
    let closed = false;
    let seq = 0;
    let hookId = '';
    const encoder = new TextEncoder();
    const emit = (value: unknown) => {
      if (!closed) out.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
    };
    const end = (code: number) => {
      if (closed) return;
      closed = true;
      try {
        out.close();
      } catch {
        /* closed */
      }
      exit(code);
    };
    const pending = new Map<string, (response: Record<string, unknown>) => void>();
    const tasks = new Map<string, { toolUseId: string }>();
    const control = (request: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = `cli-${++seq}`;
        pending.set(id, resolve);
        emit({ type: 'control_request', request_id: id, request });
      });
    const tool = (agentId: string, name: string, args: Record<string, unknown>) =>
      control({
        subtype: 'mcp_message',
        server_name: 'foundry-wardens',
        message: {
          jsonrpc: '2.0',
          id: ++seq,
          method: 'tools/call',
          params: { name, arguments: args },
        },
      }).then((r) => {
        const response = r.mcp_response as
          | { result?: { content?: Array<{ text?: string }> } }
          | undefined;
        return response?.result?.content?.[0]?.text;
      });
    const finish = (taskId: string, status: string) => {
      const task = tasks.get(taskId);
      if (!task) return;
      tasks.delete(taskId);
      emit({
        type: 'system',
        subtype: 'task_notification',
        task_id: taskId,
        tool_use_id: task.toolUseId,
        status,
        session_id: 'main',
      });
    };
    const start = async (by: string | undefined, type: string, description: string) => {
      const toolUseId = `toolu_${++seq}`;
      const r = await control({
        subtype: 'hook_callback',
        callback_id: hookId,
        input: {
          hook_event_name: 'PreToolUse',
          tool_name: 'Agent',
          tool_input: { subagent_type: type, description, prompt: '-' },
          tool_use_id: toolUseId,
          ...(by ? { agent_id: by } : {}),
        },
      });
      const output = r.hookSpecificOutput as
        | { permissionDecision?: string; updatedInput?: { prompt?: string } }
        | undefined;
      if (output?.permissionDecision !== 'allow') return;
      const taskId = `task_${++seq}`;
      const prompt = output.updatedInput?.prompt ?? '';
      tasks.set(taskId, { toolUseId });
      emit({
        type: 'system',
        subtype: 'task_started',
        task_id: taskId,
        tool_use_id: toolUseId,
        task_type: 'local_agent',
        subagent_type: type,
        prompt,
        session_id: 'main',
      });
      void run(taskId, type, prompt);
    };
    const run = async (taskId: string, type: string, prompt: string) => {
      const token = /token "([^"]+)"/.exec(prompt)?.[1] ?? '';
      if (type === 'foundry-warden') {
        memberPrompts.push(prompt);
        let input: string;
        if (prompt.includes('Call mcp__foundry-wardens__moment')) {
          const moment = await tool(taskId, 'moment', { token });
          if (!tasks.has(taskId)) return;
          if (!moment || moment.startsWith('This standby is retired'))
            return finish(taskId, 'completed');
          input = moment;
          moments.push(moment);
        } else input = prompt.split('\n\n---\n')[0] ?? '';
        emit({
          type: 'assistant',
          parent_tool_use_id: tasks.get(taskId)!.toolUseId,
          session_id: 'main',
          message: {
            role: 'assistant',
            model: 'claude-haiku-5-5',
            content: [{ type: 'text', text: '' }],
            usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 100 },
          },
        });
        await tool(taskId, 'answer', { token, text: `ANS:${input}` });
        return finish(taskId, 'completed');
      }
      for (;;) {
        if (!tasks.has(taskId)) return;
        const result = await tool(taskId, 'next', { token });
        if (!tasks.has(taskId)) return;
        if (!result || result.startsWith('Foundry is done') || result.startsWith('No agents'))
          return finish(taskId, 'completed');
        for (const line of result.split('\n')) {
          const [t, d] = line.split(' ');
          await start(taskId, t!, d!);
        }
      }
    };
    const self: FakeTreeProcess = {
      argv,
      env: options.env,
      pid: ++pid,
      crash: () => end(1),
      get exited() {
        return closed;
      },
    };
    processes.push(self);
    const onMessage = (m: Record<string, unknown>) => {
      if (m.type === 'control_response') {
        const response = m.response as { request_id: string; response: Record<string, unknown> };
        pending.get(response.request_id)?.(response.response ?? {});
        pending.delete(response.request_id);
        return;
      }
      if (m.type === 'control_request') {
        const request = m.request as Record<string, unknown> & {
          hooks?: { PreToolUse: Array<{ hookCallbackIds: string[] }> };
        };
        const ok = (response: Record<string, unknown> = {}) =>
          emit({
            type: 'control_response',
            response: { subtype: 'success', request_id: m.request_id, response },
          });
        if (request.subtype === 'initialize') {
          hookId = request.hooks?.PreToolUse[0]?.hookCallbackIds[0] ?? '';
          return ok();
        }
        if (request.subtype === 'stop_task') {
          ok();
          return finish(String(request.task_id), 'stopped');
        }
        return ok();
      }
      if (m.type !== 'user') return;
      const message = m.message as { content: Array<{ text: string }> };
      const text = message.content[0]?.text ?? '';
      void (async () => {
        const setup = text.includes('internal Foundry setup');
        if (setup && !behavior.noRoot) await start(undefined, 'foundry-root', 'root');
        const reply = setup ? 'READY' : `re:${text}`;
        emit({
          type: 'assistant',
          session_id: 'main',
          message: { role: 'assistant', content: [{ type: 'text', text: reply }] },
        });
        emit({
          type: 'result',
          subtype: 'success',
          result: reply,
          session_id: 'main',
          uuid: `r${++seq}`,
        });
      })();
    };
    return {
      pid: self.pid,
      stdout: new ReadableStream<Uint8Array>({
        start(c) {
          out = c;
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      }),
      exited: new Promise<number>((resolve) => {
        exit = resolve;
      }),
      kill() {
        end(143);
      },
      stdin: {
        write(data: string) {
          for (const line of data.split('\n')) {
            if (!line.trim()) continue;
            const message = JSON.parse(line) as Record<string, unknown>;
            queueMicrotask(() => onMessage(message));
          }
        },
        flush() {},
        end() {},
      },
    };
  };
  return { spawn, processes, moments, memberPrompts };
}
