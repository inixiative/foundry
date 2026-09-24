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

/**
 * Controlled `codex app-server` process (JSON-RPC over stdio) for primed decisions: records
 * launches and requests, answers account reads, serves threads, forks and turns, and tracks
 * concurrent decision turns. `response` sees the turn input (never the primer).
 */
export function appServerTransport(options: { login?: "chatgpt" | "apiKey"; response?: string | ((input: string) => string); items?: unknown[];
  hang?: boolean; ignoreInterrupt?: boolean; delayMs?: number; failure?: { message: string; codexErrorInfo?: string }; model?: string } = {}) {
  const launches: { argv: string[]; env: Record<string, string | undefined>; cwd: string; exited: boolean }[] = [];
  const requests: { method: string; params: any }[] = [], turns: string[] = [];
  let live = 0, peak = 0, threads = 0, turnCount = 0;
  return { launches, requests, turns, get live() { return live; }, get peak() { return peak; },
    spawn: (argv: string[], config: { cwd: string; env: Record<string, string | undefined> }) => {
      const launch = { argv, ...config, exited: false }; launches.push(launch);
      let controller!: ReadableStreamDefaultController<Uint8Array>, exit!: (code: number) => void;
      const stdout = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
      const exited = new Promise<number>(resolve => { exit = resolve; });
      const emit = (value: unknown) => { if (!launch.exited) controller.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n")); };
      const finish = (code: number) => { if (!launch.exited) { launch.exited = true; controller.close(); exit(code); } };
      const inflight = new Map<string, () => void>();
      const handle = (m: any) => {
        const reply = (result: unknown) => emit({ id: m.id, result });
        const p = m.params ?? {};
        if (m.id !== undefined && m.method) requests.push({ method: m.method, params: p });
        switch (m.method) {
          case "initialize": return reply({ userAgent: "controlled" });
          case "account/read": return reply({ account: options.login === "apiKey" ? { type: "apiKey" } : { type: "chatgpt", email: "private@example.com", planType: "pro" } });
          case "account/rateLimits/read": return reply({ ordinaryUsageAllowed: true, rateLimits: { limitId: "codex", primary: { usedPercent: 10, resetsAt: 4_000_000_000 } } });
          case "thread/list": return reply({ data: [], nextCursor: null });
          case "thread/unsubscribe": case "thread/delete": return reply({ status: "ok" });
          case "thread/start": case "thread/fork":
            return reply({ thread: { id: `${m.method === "thread/fork" ? "fork" : "thread"}-${++threads}`, status: { type: "idle" }, turns: [] }, model: options.model ?? p.model });
          case "turn/interrupt": {
            reply({});
            if (!options.ignoreInterrupt) inflight.get(p.turnId)?.();
            return;
          }
          case "turn/start": {
            const turnId = `turn-${++turnCount}`, threadId = p.threadId, input = String(p.input?.[0]?.text ?? "");
            const primer = input.includes("standing context for the decisions that follow");
            reply({ turn: { id: turnId, status: "inProgress", items: [] } });
            const note = (method: string, params: Record<string, unknown>) => emit({ method, params: { threadId, ...params } });
            note("turn/started", { turn: { id: turnId, status: "inProgress", items: [] } });
            const complete = (status: string, error: unknown = null) => { if (inflight.delete(turnId) && !primer) live--; note("turn/completed", { turn: { id: turnId, status, items: [], error } }); };
            inflight.set(turnId, () => complete("interrupted"));
            if (!primer) { turns.push(input); live++; peak = Math.max(peak, live); }
            if (primer) { note("item/completed", { item: { id: `a-${turnId}`, type: "agentMessage", text: "OK", phase: "final_answer" } }); return complete("completed"); }
            if (options.hang) return;
            setTimeout(() => {
              if (!inflight.has(turnId)) return;
              for (const item of options.items ?? []) note("item/started", { item });
              if ((options.items ?? []).length) return;
              if (options.failure) return complete("failed", { message: options.failure.message, codexErrorInfo: options.failure.codexErrorInfo ?? null });
              const text = typeof options.response === "function" ? options.response(input) : options.response ?? "accepted-private-answer";
              note("item/completed", { item: { id: `a-${turnId}`, type: "agentMessage", text, phase: "final_answer" } });
              note("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 3, cachedInputTokens: 1, outputTokens: 2 } } });
              complete("completed");
            }, options.delayMs ?? 0);
            return;
          }
        }
      };
      let buffer = "";
      return { stdout, stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), exited,
        stdin: { write(data: string) {
          buffer += data;
          const lines = buffer.split("\n"); buffer = lines.pop()!;
          for (const line of lines) if (line.trim()) queueMicrotask(() => handle(JSON.parse(line)));
        }, flush() {}, end() {} },
        kill() { finish(143); },
      };
    },
  };
}
