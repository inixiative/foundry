import { expect, test } from "bun:test";
import { ClaudeCodeSession } from "../../../../agent-session/src";

function fixture() {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let finish!: (code: number) => void;
  let closed = false;
  const proc = {
    stdin: { write() {}, flush() {}, end() {} },
    stdout: new ReadableStream<Uint8Array>({ start(c) { output = c; } }),
    stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
    exited: new Promise<number>(resolve => { finish = resolve; }),
    kill() { if (!closed) { closed = true; output.close(); finish(143); } },
  };
  const session = new ClaudeCodeSession({ externalSessionId: "ref-3", spawn: () => proc });
  return { session, emit(raw: unknown) { output.enqueue(new TextEncoder().encode(JSON.stringify(raw) + "\n")); },
    async close() { session.kill(); await proc.exited; } };
}

test("actual repeated init envelopes do not prove native compaction", async () => {
  const r = await Bun.file(new URL("../../../../agent-session/fixtures/s0/s1-continuation-20260907T041000Z/claude-continuation/recording.json", import.meta.url)).json();
  const inits = r.capture.stdout.frames.map((f: any) => f.value).filter((v: any) => v.type === "system" && v.subtype === "init");
  expect(inits).toHaveLength(2);
  const f = fixture();
  try {
    await f.session.start();
    for (const raw of inits) f.emit(raw);
    await Bun.sleep(10);
    expect(f.session.events.filter(e => e.kind === "session_compact")).toHaveLength(0);
    expect(f.session.events.filter(e => (e.raw as any)?.subtype === "init")).toHaveLength(2);
    expect(f.session.externalSessionId).toBe("ref-3");
    expect(f.session.attempts).toHaveLength(0);
  } finally { await f.close(); }
});

test("an explicit compact boundary yields one compaction, not another from the following init", async () => {
  const f = fixture();
  try {
    await f.session.start();
    f.emit({ type: "system", subtype: "init", session_id: "ref-3" });
    // Synthetic positive control for the engine's supported explicit boundary.
    f.emit({ type: "system", subtype: "compact_boundary", session_id: "ref-3" });
    f.emit({ type: "system", subtype: "init", session_id: "ref-3" });
    f.emit({ type: "system", subtype: "compact_boundary", session_id: "foreign-binding" });
    await Bun.sleep(10);
    const compactions = f.session.events.filter(e => e.kind === "session_compact");
    expect(compactions).toHaveLength(1);
    expect((compactions[0].raw as any).subtype).toBe("compact_boundary");
    expect(compactions[0].externalSessionId).toBe("ref-3");
    expect(f.session.externalSessionId).toBe("ref-3");
  } finally { await f.close(); }
});
