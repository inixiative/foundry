// Stdio sessions as cassettes. A recording keeps every stdin write and every stdout/stderr
// line, each output tagged with how many stdin events (writes or end) preceded it. Replay
// releases each output once the same number of stdin events has happened, so request/response
// protocols (Claude stream-json turns, `codex exec` stdin prompts, app-server JSON-RPC) replay
// in the order they ran live, with no timers.
import { tmpdir } from "node:os";
import { VCR, type Fixture } from "./vcr";
import { accountHome, rehydrate, scrubLine, scrubText, type ScrubContext } from "./scrub";

export type Frame = { after: number; stream: "stdout" | "stderr"; data: string; eol?: false };
export type ProcessTranscript = {
  kind: "process";
  argv: string[];
  cwd: string;
  /** Scrubbed stdin writes in order; `end` counts as one more stdin event. */
  stdin: string[];
  stdinEnded: boolean;
  frames: Frame[];
  exit: { after: number; code: number | null; killed: boolean };
};

export type SpawnOptions = { cwd: string; env: Record<string, string | undefined> };
export type RecordedProcess = {
  stdin: { write(data: string | Uint8Array): void; flush(): void; end(): void };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
};
export type Launch = { argv: string[]; env: Record<string, string | undefined>; cwd: string; stdin: string; exited: boolean };

type Options = {
  /** Status probes that Foundry spawns without argv (`statusSpawn(profile)`) name the command here. */
  argv?: string[];
  /** Reduces raw output to what Foundry reads (auth status prints the account); generic scrubbing follows. */
  sanitize?: (frames: Frame[]) => Frame[];
  /** Environment for `statusSpawn` probes; the providers compose theirs from an allowlist. */
  env?: () => Record<string, string | undefined>;
  /** Model the recording ran on, stamped into the cassette. */
  model?: string | ((transcript: ProcessTranscript) => string | undefined);
};

const encoder = new TextEncoder();
const text = (data: string | Uint8Array) => typeof data === "string" ? data : new TextDecoder().decode(data);

/** The account's own login, whatever temporary profile or HOME a test composed for Foundry. */
export function liveEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const live: Record<string, string | undefined> = { ...env, HOME: accountHome() };
  for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    const value = live[key];
    if (value && (value.startsWith(tmpdir()) || value.startsWith("/private/var/") || value.startsWith("/var/folders/"))) delete live[key];
  }
  if (process.env.FOUNDRY_VCR_PATH) live.PATH = process.env.FOUNDRY_VCR_PATH;
  return live;
}

/** A spawn seam backed by queued cassettes: `vcr.queue(method, name)` once per expected launch. */
export class ProcessCassettes {
  readonly launches: Launch[] = [];
  writes = 0;
  constructor(private vcr: VCR, private method: string, private options: Options = {}) {}

  spawn = (argv: string[], options: SpawnOptions): RecordedProcess => {
    const path = this.vcr.popFixturePath(this.method);
    const launch: Launch = { argv, env: options.env, cwd: options.cwd, stdin: "", exited: false };
    this.launches.push(launch);
    const onWrite = (data: string) => { launch.stdin += data; this.writes++; };
    const onExit = () => { launch.exited = true; };
    return this.vcr.mode === "replay" ? replay(this.vcr.load<ProcessTranscript>(path), options, onWrite, onExit)
      : record(this.vcr, path, this.options.argv ?? argv, options, this.options, onWrite, onExit);
  };

  /** `statusSpawn(profileDirectory)`: the command is fixed by the provider, so it comes from options. */
  statusSpawn = (_profileDirectory?: string): RecordedProcess => {
    if (!this.options.argv) throw Error("VCR: statusSpawn needs the probe argv");
    return this.spawn(this.options.argv, { cwd: tmpdir(), env: this.options.env?.() ?? { PATH: process.env.PATH } });
  };
}

function record(vcr: VCR, path: string, argv: string[], options: SpawnOptions, config: Options,
  onWrite: (data: string) => void, onExit: () => void): RecordedProcess {
  VCR.spendLive(argv.slice(0, 2).join(" "));
  const started = Date.now();
  const child = Bun.spawn(argv, { cwd: options.cwd, env: liveEnvironment(options.env), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const context: ScrubContext = { cwd: options.cwd };
  const transcript: ProcessTranscript = { kind: "process", argv: argv.map(arg => scrubText(arg, context)), cwd: "{{cwd}}",
    stdin: [], stdinEnded: false, frames: [], exit: { after: 0, code: null, killed: false } };
  let events = 0, killed = false;
  // Raw lines stay in memory only; they are sanitized and scrubbed before the cassette is written.
  const raw: Frame[] = [];
  // Tee each stream: Foundry reads the real bytes unchanged; the cassette keeps scrubbed lines.
  const tee = (source: ReadableStream<Uint8Array>, stream: "stdout" | "stderr") => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const done = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      const push = (data: string, eol: boolean) => { raw.push({ after: events, stream, data, ...(eol ? {} : { eol: false as const }) }); };
      try {
        for await (const chunk of source) {
          try { controller.enqueue(chunk); } catch { /* Reader cancelled; keep recording. */ }
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) push(line, true);
        }
      } catch { /* Killed mid-read. */ }
      buffer += decoder.decode();
      if (buffer) push(buffer, false);
      try { controller.close(); } catch { /* Already closed. */ }
    })();
    return { readable, done };
  };
  const stdout = tee(child.stdout, "stdout"), stderr = tee(child.stderr, "stderr");
  // Foundry sees the real exit at once; the cassette is written after both streams drain.
  const exited = child.exited.then(code => {
    onExit();
    transcript.exit = { after: events, code: killed ? null : code, killed };
    const durationMs = Date.now() - started;
    vcr.track(Promise.all([stdout.done, stderr.done]).then(() => {
      transcript.frames = (config.sanitize ? config.sanitize(raw) : raw).map(frame => ({ ...frame, data: scrubLine(frame.data, context) }));
      const model = typeof config.model === "function" ? config.model(transcript) : config.model ?? observedModel(transcript);
      return vcr.store(path, { status: killed ? 0 : code, body: transcript }, { durationMs, ...(model ? { model } : {}) });
    }));
    return code;
  });
  return {
    stdout: stdout.readable, stderr: stderr.readable, exited,
    stdin: {
      write(data) { const value = text(data); onWrite(value); transcript.stdin.push(scrubLine(value, context)); events++; child.stdin.write(value); },
      flush() { child.stdin.flush(); },
      end() { if (!transcript.stdinEnded) { transcript.stdinEnded = true; events++; } child.stdin.end(); },
    },
    kill() { killed = true; child.kill(); },
  };
}

/** The model a CLI reported: Claude's init `model`, app-server's thread `model`. */
function observedModel(transcript: ProcessTranscript): string | undefined {
  for (const frame of transcript.frames) {
    try {
      const event = JSON.parse(frame.data) as Record<string, unknown>;
      if (event.type === "system" && event.subtype === "init" && typeof event.model === "string") return event.model;
      const result = event.result as Record<string, unknown> | undefined;
      if (result && typeof result.model === "string" && result.thread) return result.model;
    } catch { /* Not JSON. */ }
  }
  return undefined;
}

type JsonRpc = { id?: string | number; method?: string; type?: string };
const json = (line: string): JsonRpc | undefined => { try { const value = JSON.parse(line); return value && typeof value === "object" ? value : undefined; } catch { return undefined; } };

function replay(fixture: Fixture<ProcessTranscript>, options: SpawnOptions,
  onWrite: (data: string) => void, onExit: () => void): RecordedProcess {
  const transcript = fixture.body!;
  const context: ScrubContext = { cwd: options.cwd };
  const controllers: Record<"stdout" | "stderr", ReadableStreamDefaultController<Uint8Array>> = {} as never;
  const stream = (name: "stdout" | "stderr") => new ReadableStream<Uint8Array>({ start(c) { controllers[name] = c; } });
  const stdout = stream("stdout"), stderr = stream("stderr");
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>(resolve => { resolveExit = resolve; });
  let events = 0, next = 0, closed = false, stdinLines = 0, ended = false;
  // JSON-RPC request ids the client chose live vs now, so replayed responses answer this run's requests.
  const ids = new Map<string, string | number>();
  const close = (code: number) => {
    if (closed) return;
    closed = true; onExit();
    for (const controller of Object.values(controllers)) { try { controller.close(); } catch { /* Closed. */ } }
    resolveExit(code);
  };
  const remap = (line: string) => {
    const value = json(line);
    if (!value || value.method !== undefined || value.id === undefined || !ids.has(String(value.id))) return line;
    return JSON.stringify({ ...value, id: ids.get(String(value.id)) });
  };
  const release = () => {
    queueMicrotask(() => {
      while (!closed && next < transcript.frames.length && transcript.frames[next]!.after <= events) {
        const frame = transcript.frames[next++]!;
        const data = remap(rehydrate(frame.data, context)) + (frame.eol === false ? "" : "\n");
        try { controllers[frame.stream].enqueue(encoder.encode(data)); } catch { /* Reader gone. */ }
      }
      if (!closed && !transcript.exit.killed && next >= transcript.frames.length && events >= transcript.exit.after)
        close(transcript.exit.code ?? 0);
    });
  };
  const mismatch = (message: string) => { throw Error(`VCR replay (${transcript.argv.slice(0, 2).join(" ")}): ${message}; re-record with \`bun run test:live\``); };
  release();
  return {
    stdout, stderr, exited,
    stdin: {
      write(data) {
        if (closed) throw Error("VCR replay: write after exit");
        const value = text(data);
        onWrite(value);
        for (const line of value.split("\n").filter(Boolean)) {
          const recorded = transcript.stdin.flatMap(write => write.split("\n").filter(Boolean))[stdinLines++];
          if (recorded === undefined) mismatch(`stdin line ${stdinLines} was not recorded`);
          const live = json(recorded!), now = json(line);
          if (live && now && (live.method !== now.method || live.type !== now.type))
            mismatch(`stdin line ${stdinLines} is ${now.method ?? now.type}, recorded ${live.method ?? live.type}`);
          if (live?.id !== undefined && now?.id !== undefined && live.method !== undefined) ids.set(String(live.id), now.id);
        }
        events++;
        release();
      },
      flush() {},
      end() { if (!ended) { ended = true; events++; release(); } },
    },
    kill() { close(transcript.exit.killed ? transcript.exit.code ?? 143 : 143); },
  };
}
