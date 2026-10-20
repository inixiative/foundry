import type { ClaudeCodeSessionConfig } from '@inixiative/agent-session';

// A controlled `claude` CLI for native-session tests, answering as Claude Code 2.1.304 does,
// including when a resumed transcript is gone (probed live: it says so on stderr and exits 1
// before reading a turn).

type Proc = ReturnType<NonNullable<ClaudeCodeSessionConfig['spawn']>>;
const encode = (text: string) => new TextEncoder().encode(text);

/**
 * A controlled `claude` CLI: a fresh launch answers each turn under a new session id; `--resume X`
 * continues X, unless X's transcript is gone, when it says so on stderr and exits before reading.
 */
export function claudeCli(gone: Set<string>, prefix = 'claude-session') {
  const launches: Array<{ argv: string[]; turns: string[]; exit: (code: number) => void }> = [];
  let fresh = 0;
  const spawn = (argv: string[]): Proc => {
    const at = argv.indexOf('--resume');
    const resumed = at >= 0 ? argv[at + 1] : undefined;
    const sessionId = resumed ?? `${prefix}-${++fresh}`;
    const missing = resumed !== undefined && gone.has(resumed);
    let out!: ReadableStreamDefaultController<Uint8Array>,
      err!: ReadableStreamDefaultController<Uint8Array>,
      done!: (code: number) => void,
      closed = false;
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        out = c;
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(c) {
        err = c;
      },
    });
    const exited = new Promise<number>((resolve) => {
      done = resolve;
    });
    const exit = (code: number) => {
      if (closed) return;
      closed = true;
      for (const stream of [out, err])
        try {
          stream.close();
        } catch {}
      done(code);
    };
    const emit = (value: unknown) => {
      if (!closed) out.enqueue(encode(`${JSON.stringify(value)}\n`));
    };
    const turns: string[] = [];
    if (missing)
      queueMicrotask(() => {
        err.enqueue(encode(`No conversation found with session ID: ${resumed}\n`));
        setTimeout(() => exit(1), 2);
      });
    launches.push({ argv, turns, exit });
    const launch = launches.length;
    return {
      stdin: {
        write(data: string) {
          for (const line of data.split('\n')) {
            if (!line.trim() || missing) continue;
            const message = JSON.parse(line) as {
              type?: string;
              request_id?: string;
              message?: { content?: Array<{ text?: string }> | string };
            };
            if (message.type === 'control_request') {
              queueMicrotask(() =>
                emit({
                  type: 'control_response',
                  response: { subtype: 'success', request_id: message.request_id, response: {} },
                }),
              );
              continue;
            }
            const content = message.message?.content;
            turns.push(
              typeof content === 'string' ? content : (content ?? []).map((c) => c.text).join(''),
            );
            queueMicrotask(() => {
              emit({ type: 'system', subtype: 'init', session_id: sessionId, model: 'haiku' });
              emit({
                type: 'assistant',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: `answer-${launch}` }],
                },
                session_id: sessionId,
              });
              emit({
                type: 'result',
                subtype: 'success',
                is_error: false,
                result: `answer-${launch}`,
                session_id: sessionId,
                usage: { input_tokens: 1, output_tokens: 1 },
              });
            });
          }
        },
        flush() {},
        end() {},
      },
      stdout,
      stderr,
      exited,
      kill: () => exit(143),
    } as unknown as Proc;
  };
  return { launches, spawn };
}
