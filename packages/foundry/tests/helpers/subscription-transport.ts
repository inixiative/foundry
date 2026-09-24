export function subscriptionStatusProcess(valid = true) {
  return { stdout: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({ loggedIn: valid, authMethod: valid ? "claude.ai" : "api_key" }))); c.close(); } }),
    stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), exited: Promise.resolve(0), kill() {} };
}

export function subscriptionTransport(options: { model?: string; response?: (input: string) => string | Promise<string>; tool?: boolean } = {}) {
  const launches: { argv: string[]; env: Record<string, string | undefined>; cwd: string; exited: boolean }[] = [];
  let writes = 0;
  return { launches, get writes() { return writes; }, statusSpawn: () => subscriptionStatusProcess(),
    spawn: (argv: string[], config: { cwd: string; env: Record<string, string | undefined> }) => {
      const launch = { argv, ...config, exited: false }; launches.push(launch);
      let controller!: ReadableStreamDefaultController<Uint8Array>, exit!: (code: number) => void;
      const stdout = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
      const exited = new Promise<number>(resolve => { exit = resolve; });
      const emit = (event: unknown) => { if (!launch.exited) controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n")); };
      const id = crypto.randomUUID();
      return { stdout, stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), exited,
        stdin: { write(input: string | Uint8Array) {
          writes++;
          void Promise.resolve(options.response?.(String(input)) ?? "accepted-private-answer").then(result => {
            emit({ type: "system", subtype: "init", session_id: id, model: options.model ?? "test-model" });
            if (options.tool) emit({ type: "assistant", session_id: id, message: { role: "assistant", content: [{ type: "tool_use", id: "tool", name: "Bash", input: { command: "no-real-command" } }] } });
            else emit({ type: "result", subtype: "success", is_error: false, result, session_id: id, usage: { input_tokens: 1, output_tokens: 1 } });
          });
        }, flush() {}, end() {} },
        kill() { if (!launch.exited) { launch.exited = true; controller.close(); exit(143); } },
      };
    },
  };
}

export function codexStatusProcess(login = "Logged in using ChatGPT") {
  const stream = (text: string) => new ReadableStream<Uint8Array>({ start(c) { if (text) c.enqueue(new TextEncoder().encode(text)); c.close(); } });
  return { stdout: stream(""), stderr: stream(`${login}\n`), exited: Promise.resolve(0), kill() {} };
}

/** Controlled `codex exec --json` process: records argv/env/stdin and replays JSONL events. */
export function codexTransport(options: { login?: string; response?: string; items?: unknown[]; hang?: boolean; exitCode?: number } = {}) {
  const launches: { argv: string[]; env: Record<string, string | undefined>; cwd: string; stdin: string; exited: boolean }[] = [];
  let statusChecks = 0;
  return { launches, get statusChecks() { return statusChecks; },
    statusSpawn: () => { statusChecks++; return codexStatusProcess(options.login); },
    spawn: (argv: string[], config: { cwd: string; env: Record<string, string | undefined> }) => {
      const launch = { argv, ...config, stdin: "", exited: false }; launches.push(launch);
      let controller!: ReadableStreamDefaultController<Uint8Array>, exit!: (code: number) => void;
      const stdout = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
      const exited = new Promise<number>(resolve => { exit = resolve; });
      const finish = (code: number) => { if (!launch.exited) { launch.exited = true; controller.close(); exit(code); } };
      const emit = (event: unknown) => { if (!launch.exited) controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n")); };
      return { stdout, stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), exited,
        stdin: { write(input: string) { launch.stdin += input; }, end() {
          if (options.hang) return;
          queueMicrotask(() => {
            emit({ type: "thread.started", thread_id: crypto.randomUUID() });
            emit({ type: "turn.started" });
            for (const item of options.items ?? []) emit({ type: "item.completed", item });
            emit({ type: "item.completed", item: { id: "answer", type: "agent_message", text: options.response ?? "accepted-private-answer" } });
            emit({ type: "turn.completed", usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 2 } });
            finish(options.exitCode ?? 0);
          });
        } },
        kill() { finish(143); },
      };
    },
  };
}
