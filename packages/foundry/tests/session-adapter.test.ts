import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ClaudeCodeSessionAdapter,
  FileExternalSessionStore,
  InMemoryExternalSessionStore,
  type ExternalSessionStore,
} from "../src/providers/session-adapter";
import type { PipedSubprocess } from "../src/providers/claude-code-session";

// ---------------------------------------------------------------------------
// Shared fake subprocess — same wire format as claude-code-session tests
// ---------------------------------------------------------------------------

function makeFakeProc(opts?: { sessionId?: string }): {
  proc: PipedSubprocess;
  stdinLines: string[];
} {
  const sessionId = opts?.sessionId ?? "native-session-1";
  const stdinLines: string[] = [];

  let stdoutCtrl: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({ start(c) { stdoutCtrl = c; } });
  const stderr = new ReadableStream<Uint8Array>({ start() {} });

  let exitResolve: (code: number) => void;
  const exited = new Promise<number>((r) => { exitResolve = r; });

  const emit = (j: Record<string, unknown>) =>
    stdoutCtrl.enqueue(new TextEncoder().encode(JSON.stringify(j) + "\n"));

  const proc: PipedSubprocess = {
    stdin: {
      write(data: string) {
        for (const line of data.split("\n")) {
          if (!line.trim()) continue;
          stdinLines.push(line);
          queueMicrotask(() => {
            emit({ type: "system", subtype: "init", session_id: sessionId });
            emit({
              type: "assistant",
              message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
              session_id: sessionId,
            });
            emit({
              type: "result",
              subtype: "success",
              is_error: false,
              result: "ok",
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
    kill: () => { try { stdoutCtrl.close(); } catch {} exitResolve(143); },
  };

  return { proc, stdinLines };
}

// ---------------------------------------------------------------------------
// Spawn capture — lets us assert on the CLI args the adapter produces
// ---------------------------------------------------------------------------

function makeSpawnCapture(sessionId: string = "native-session-1") {
  const spawnCalls: Array<{ cmd: string[]; stdin: string[] }> = [];
  const spawn = (cmd: string[]) => {
    const fake = makeFakeProc({ sessionId });
    spawnCalls.push({ cmd, stdin: fake.stdinLines });
    return fake.proc;
  };
  return { spawnCalls, spawn };
}

// ---------------------------------------------------------------------------
// InMemoryExternalSessionStore
// ---------------------------------------------------------------------------

describe("InMemoryExternalSessionStore", () => {
  test("save + load roundtrip", async () => {
    const store = new InMemoryExternalSessionStore();
    await store.save("t1", "claude-code", "abc-123");
    expect(await store.load("t1", "claude-code")).toBe("abc-123");
  });

  test("load returns null for unknown thread", async () => {
    const store = new InMemoryExternalSessionStore();
    expect(await store.load("nope", "claude-code")).toBeNull();
  });

  test("isolates by runtime — same thread, different runtimes = different IDs", async () => {
    const store = new InMemoryExternalSessionStore();
    await store.save("t1", "claude-code", "claude-id");
    await store.save("t1", "codex", "codex-id");
    expect(await store.load("t1", "claude-code")).toBe("claude-id");
    expect(await store.load("t1", "codex")).toBe("codex-id");
  });

  test("save overwrites existing mapping", async () => {
    const store = new InMemoryExternalSessionStore();
    await store.save("t1", "claude-code", "old");
    await store.save("t1", "claude-code", "new");
    expect(await store.load("t1", "claude-code")).toBe("new");
  });

  test("clear removes the mapping", async () => {
    const store = new InMemoryExternalSessionStore();
    await store.save("t1", "claude-code", "abc");
    await store.clear("t1", "claude-code");
    expect(await store.load("t1", "claude-code")).toBeNull();
  });

  test("all() lists every mapping", async () => {
    const store = new InMemoryExternalSessionStore();
    await store.save("t1", "claude-code", "a");
    await store.save("t2", "claude-code", "b");
    await store.save("t1", "codex", "c");
    const rows = await store.all();
    expect(rows).toHaveLength(3);
    expect(rows).toContainEqual({ threadId: "t1", runtime: "claude-code", externalSessionId: "a" });
    expect(rows).toContainEqual({ threadId: "t2", runtime: "claude-code", externalSessionId: "b" });
    expect(rows).toContainEqual({ threadId: "t1", runtime: "codex", externalSessionId: "c" });
  });
});

// ---------------------------------------------------------------------------
// FileExternalSessionStore — the crash-recovery backing store
// ---------------------------------------------------------------------------

describe("FileExternalSessionStore", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length) {
      const d = tmpDirs.pop()!;
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  function newStorePath(): string {
    const dir = mkdtempSync(join(tmpdir(), "foundry-sessions-"));
    tmpDirs.push(dir);
    return join(dir, ".foundry", "sessions.json");
  }

  test("save + load roundtrip persists to disk", async () => {
    const path = newStorePath();
    const store = new FileExternalSessionStore(path);
    await store.save("t1", "claude-code", "abc");
    expect(existsSync(path)).toBe(true);
    expect(await store.load("t1", "claude-code")).toBe("abc");
  });

  test("load returns null for missing file (fresh install)", async () => {
    const path = newStorePath();
    const store = new FileExternalSessionStore(path);
    expect(await store.load("t1", "claude-code")).toBeNull();
  });

  test("reload from disk in a new instance preserves data (simulates restart)", async () => {
    const path = newStorePath();
    const first = new FileExternalSessionStore(path);
    await first.save("t1", "claude-code", "abc");
    await first.save("t2", "codex", "xyz");

    // New instance, same file — simulating a Foundry process restart
    const second = new FileExternalSessionStore(path);
    expect(await second.load("t1", "claude-code")).toBe("abc");
    expect(await second.load("t2", "codex")).toBe("xyz");
  });

  test("writes are atomic (valid JSON after concurrent saves)", async () => {
    const path = newStorePath();
    const store = new FileExternalSessionStore(path);

    // Fire 20 concurrent saves; the write lock serializes them.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.save(`t${i}`, "claude-code", `id-${i}`),
      ),
    );

    // File must be parseable and reflect all writes
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, Record<string, string>>;
    expect(Object.keys(parsed["claude-code"])).toHaveLength(20);

    // Fresh instance sees everything
    const reopened = new FileExternalSessionStore(path);
    for (let i = 0; i < 20; i++) {
      expect(await reopened.load(`t${i}`, "claude-code")).toBe(`id-${i}`);
    }
  });

  test("clear removes the mapping and persists", async () => {
    const path = newStorePath();
    const store = new FileExternalSessionStore(path);
    await store.save("t1", "claude-code", "abc");
    await store.clear("t1", "claude-code");

    const reopened = new FileExternalSessionStore(path);
    expect(await reopened.load("t1", "claude-code")).toBeNull();
  });

  test("forProject() writes to <root>/.foundry/sessions.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "foundry-project-"));
    tmpDirs.push(dir);
    const store = FileExternalSessionStore.forProject(dir);
    await store.save("t1", "claude-code", "abc");
    expect(existsSync(join(dir, ".foundry", "sessions.json"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ClaudeCodeSessionAdapter — the mapping orchestrator
// ---------------------------------------------------------------------------

describe("ClaudeCodeSessionAdapter", () => {
  test("createSession for a fresh thread: no --resume in spawn args", async () => {
    const store = new InMemoryExternalSessionStore();
    const { spawnCalls, spawn } = makeSpawnCapture();
    const adapter = new ClaudeCodeSessionAdapter({
      store,
      defaults: { bin: "claude", maxTurns: 1, spawn },
    });

    const session = await adapter.createSession({ threadId: "t1", cwd: "/tmp" });
    await session.start();

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cmd).not.toContain("--resume");
  });

  test("session captures external ID and adapter persists it via the store", async () => {
    const store = new InMemoryExternalSessionStore();
    const { spawn } = makeSpawnCapture("native-xyz");
    const adapter = new ClaudeCodeSessionAdapter({
      store,
      defaults: { bin: "claude", maxTurns: 1, spawn },
    });

    const session = await adapter.createSession({ threadId: "t1", cwd: "/tmp" });
    await session.start();
    await session.send("hello");

    // Let the async store.save() from the event handler settle
    await new Promise((r) => setTimeout(r, 5));

    expect(session.externalSessionId).toBe("native-xyz");
    expect(await store.load("t1", "claude-code")).toBe("native-xyz");
  });

  test("crash recovery: second createSession for same thread spawns with --resume", async () => {
    const store = new InMemoryExternalSessionStore();
    const { spawnCalls, spawn } = makeSpawnCapture("native-persist");
    const adapter = new ClaudeCodeSessionAdapter({
      store,
      defaults: { bin: "claude", maxTurns: 1, spawn },
    });

    // Session 1 — thread runs, native ID gets captured + persisted
    const s1 = await adapter.createSession({ threadId: "t1", cwd: "/tmp" });
    await s1.start();
    await s1.send("first");
    await new Promise((r) => setTimeout(r, 5));
    s1.kill();

    // Simulate Foundry restart — same thread, new session
    const s2 = await adapter.createSession({ threadId: "t1", cwd: "/tmp" });
    expect(s2.externalSessionId).toBe("native-persist"); // pre-set from store
    await s2.start();

    // Second spawn must include --resume <id>
    expect(spawnCalls).toHaveLength(2);
    const args2 = spawnCalls[1].cmd;
    const resumeIdx = args2.indexOf("--resume");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(args2[resumeIdx + 1]).toBe("native-persist");
    // And NOT --fork-session — this is resume, not fork
    expect(args2).not.toContain("--fork-session");
  });

  test("crash recovery end-to-end with FileExternalSessionStore (survives restart)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "foundry-crash-"));
    try {
      const storePath = join(dir, "sessions.json");
      const { spawnCalls, spawn } = makeSpawnCapture("native-filebacked");

      // --- Foundry process #1 ---
      {
        const store = new FileExternalSessionStore(storePath);
        const adapter = new ClaudeCodeSessionAdapter({
          store,
          defaults: { bin: "claude", maxTurns: 1, spawn },
        });
        const s = await adapter.createSession({ threadId: "t1", cwd: "/tmp" });
        await s.start();
        await s.send("before crash");
        await new Promise((r) => setTimeout(r, 5));
        // "Crash" — do NOT call s.kill() explicitly; simulate process death
        //  by simply dropping the references. The file store has persisted.
      }

      // --- Foundry process #2 (fresh instance, fresh in-memory state) ---
      {
        const store = new FileExternalSessionStore(storePath);
        const adapter = new ClaudeCodeSessionAdapter({
          store,
          defaults: { bin: "claude", maxTurns: 1, spawn },
        });

        // The mapping persisted across the "restart"
        expect(await adapter.getExternalSessionId("t1")).toBe("native-filebacked");

        const s = await adapter.createSession({ threadId: "t1", cwd: "/tmp" });
        await s.start();

        // Second spawn includes --resume — thread recovered
        const args = spawnCalls[spawnCalls.length - 1].cmd;
        const idx = args.indexOf("--resume");
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(args[idx + 1]).toBe("native-filebacked");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("getExternalSessionId returns persisted value without creating a session", async () => {
    const store = new InMemoryExternalSessionStore();
    await store.save("t1", "claude-code", "preset");
    const { spawn } = makeSpawnCapture();
    const adapter = new ClaudeCodeSessionAdapter({
      store,
      defaults: { bin: "claude", spawn },
    });

    expect(await adapter.getExternalSessionId("t1")).toBe("preset");
    expect(await adapter.getExternalSessionId("unknown")).toBeNull();
  });

  test("clearSession removes the mapping so next createSession is fresh", async () => {
    const store = new InMemoryExternalSessionStore();
    await store.save("t1", "claude-code", "will-be-cleared");
    const { spawnCalls, spawn } = makeSpawnCapture("new-native-id");
    const adapter = new ClaudeCodeSessionAdapter({
      store,
      defaults: { bin: "claude", maxTurns: 1, spawn },
    });

    await adapter.clearSession("t1");
    expect(await store.load("t1", "claude-code")).toBeNull();

    const s = await adapter.createSession({ threadId: "t1", cwd: "/tmp" });
    await s.start();

    // Fresh session — no --resume
    expect(spawnCalls[0].cmd).not.toContain("--resume");
  });

  test("adapter isolates threads — different threads get different external IDs", async () => {
    const store = new InMemoryExternalSessionStore();

    // We need per-call session IDs so we can verify isolation.
    const sessionIds = ["native-for-t1", "native-for-t2"];
    let callIdx = 0;
    const spawn = (_cmd: string[]) => {
      const id = sessionIds[callIdx++] ?? "unused";
      return makeFakeProc({ sessionId: id }).proc;
    };

    const adapter = new ClaudeCodeSessionAdapter({
      store,
      defaults: { bin: "claude", maxTurns: 1, spawn },
    });

    const s1 = await adapter.createSession({ threadId: "t1", cwd: "/tmp" });
    await s1.start();
    await s1.send("hi from t1");

    const s2 = await adapter.createSession({ threadId: "t2", cwd: "/tmp" });
    await s2.start();
    await s2.send("hi from t2");

    await new Promise((r) => setTimeout(r, 5));

    expect(await store.load("t1", "claude-code")).toBe("native-for-t1");
    expect(await store.load("t2", "claude-code")).toBe("native-for-t2");
  });

  test("broken store write does not crash the session (failure is observable via console)", async () => {
    // Custom store that rejects save
    const failing: ExternalSessionStore = {
      async load() { return null; },
      async save() { throw new Error("disk full"); },
      async clear() {},
      async all() { return []; },
    };
    const { spawn } = makeSpawnCapture();
    const adapter = new ClaudeCodeSessionAdapter({
      store: failing,
      defaults: { bin: "claude", maxTurns: 1, spawn },
    });

    const s = await adapter.createSession({ threadId: "t1", cwd: "/tmp" });
    await s.start();
    // send must still resolve even though the background store.save() fails
    const r = await s.send("hi");
    expect(r.content).toBe("ok");
  });
});
