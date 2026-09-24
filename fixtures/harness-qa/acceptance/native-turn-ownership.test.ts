import { expect, test } from "bun:test";
import { ClaudeCodeSession, CodexMcpSession } from "../../../../agent-session/src";

// Synthetic admission test, not a native cancellation or protocol-parity probe.
function transport() {
  const writes: Array<Record<string, any>> = [];
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let finish!: (code: number) => void;
  let closed = false;
  const exited = new Promise<number>(resolve => { finish = resolve; });
  const emit = (value: unknown) => output.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n"));
  const proc = {
    stdin: {
      write(data: string) {
        const value = JSON.parse(data);
        writes.push(value);
        if (value.method === "initialize" || value.method === "tools/list") {
          queueMicrotask(() => emit({ jsonrpc: "2.0", id: value.id, result: {} }));
        }
      },
      flush() {},
      end() {},
    },
    stdout: new ReadableStream<Uint8Array>({ start(controller) { output = controller; } }),
    stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
    exited,
    kill() {
      if (closed) return;
      closed = true;
      output.close();
      finish(143);
    },
  };
  return { proc, turnWrites: () => writes.filter(v => v.type === "user" || v.method === "tools/call") };
}

for (const engine of ["claude", "mcp"] as const) {
  for (const trigger of ["timeout", "interrupt"] as const) {
    test(`${engine}: ${trigger} without native terminal does not admit overlapping work`, async () => {
      const fake = transport();
      const Session = engine === "claude" ? ClaudeCodeSession : CodexMcpSession;
      const session = new Session({ spawn: () => fake.proc, timeout: 1000 });
      let second: Promise<unknown> | undefined;
      try {
        await session.start();
        const first = session.send("first", { timeout: trigger === "timeout" ? 20 : 1000 })
          .then(value => ({ value }), error => ({ error }));
        await Bun.sleep(5);
        expect(fake.turnWrites()).toHaveLength(1);
        if (trigger === "interrupt") session.interrupt();
        const outcome = await first;
        expect(outcome).toHaveProperty("error");

        // Either an explicit busy/unknown rejection or queueing is safe here.
        // Writing to the still-running native process is not.
        second = session.send("second", { timeout: 1000 }).catch(error => ({ error }));
        await Bun.sleep(20);
        expect(fake.turnWrites()).toHaveLength(1);
      } finally {
        session.kill();
        if (second) await second;
        await fake.proc.exited;
      }
    });
  }
}
