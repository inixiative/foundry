// WebSocket sessions as cassettes. Received frames are tagged with how many frames the client
// had sent, so replay answers each send exactly as the server did live.
import { VCR } from "./vcr";
import { scrubLine, scrubText } from "./scrub";

export type SocketFrame = { after: number; stream: "in"; data: string };
export type SocketTranscript = {
  kind: "websocket";
  path: string;
  sent: string[];
  frames: SocketFrame[];
  exit: { after: number; code: number; reason: string; by: "client" | "server" };
};

export type SocketLike = Pick<WebSocket, "addEventListener" | "removeEventListener"> & {
  readonly readyState: number;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
};
export type SocketFactory = (url: string | URL, protocols?: string | string[]) => SocketLike;

const payload = (data: unknown) => typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);

export function webSocketCassettes(vcr: VCR, method: string): SocketFactory {
  return (url, protocols) => {
    const path = vcr.popFixturePath(method);
    return vcr.mode === "replay" ? new ReplaySocket(vcr.load<SocketTranscript>(path).body!) : recordSocket(vcr, method, path, url, protocols);
  };
}

function recordSocket(vcr: VCR, method: string, path: string, url: string | URL, protocols?: string | string[]): SocketLike {
  VCR.spendLive(`${vcr.service} ${method}`);
  const started = Date.now();
  const socket = new WebSocket(url, protocols);
  const transcript: SocketTranscript = { kind: "websocket", path: scrubText(new URL(String(url)).pathname), sent: [], frames: [],
    exit: { after: 0, code: 1005, reason: "", by: "server" } };
  let closing = false;
  socket.addEventListener("message", event => { transcript.frames.push({ after: transcript.sent.length, stream: "in", data: scrubLine(payload(event.data)) }); });
  // Tracked from the start, so settled() waits for the close that completes the transcript.
  vcr.track(new Promise<void>(resolve => socket.addEventListener("close", event => {
    transcript.exit = { after: transcript.sent.length, code: event.code, reason: scrubText(event.reason), by: closing ? "client" : "server" };
    resolve();
  })).then(() => vcr.store(path, { status: 101, body: transcript }, { durationMs: Date.now() - started })));
  const send = socket.send.bind(socket), close = socket.close.bind(socket);
  return Object.assign(socket, {
    send(data: string | ArrayBufferLike | ArrayBufferView) { transcript.sent.push(scrubLine(payload(data))); send(data as Parameters<WebSocket["send"]>[0]); },
    close(code?: number, reason?: string) { closing = true; close(code, reason); },
  });
}

class ReplaySocket extends EventTarget implements SocketLike {
  readyState: number = WebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private next = 0;
  private sent = 0;
  constructor(private transcript: SocketTranscript) {
    super();
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN;
      this.fire("open", new Event("open"));
      this.release();
    });
  }
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.readyState !== WebSocket.OPEN) throw Error("VCR replay: send on a socket that is not open");
    const recorded = this.transcript.sent[this.sent];
    if (recorded === undefined) throw Error(`VCR replay: websocket send ${this.sent + 1} was not recorded; re-record with \`bun run test:live\``);
    if (scrubLine(payload(data)) !== recorded) throw Error(`VCR replay: websocket send ${this.sent + 1} differs from the recording; re-record with \`bun run test:live\``);
    this.sent++;
    this.release();
  }
  close(code = 1000, reason = ""): void {
    if (this.readyState >= WebSocket.CLOSING) return;
    this.finish(code, reason);
  }
  private release() {
    queueMicrotask(() => {
      while (this.readyState === WebSocket.OPEN && this.next < this.transcript.frames.length && this.transcript.frames[this.next]!.after <= this.sent)
        this.fire("message", new MessageEvent("message", { data: this.transcript.frames[this.next++]!.data }));
      const exit = this.transcript.exit;
      if (this.readyState === WebSocket.OPEN && exit.by === "server" && this.next >= this.transcript.frames.length && this.sent >= exit.after)
        this.finish(exit.code, exit.reason);
    });
  }
  private finish(code: number, reason: string) {
    this.readyState = WebSocket.CLOSED;
    this.fire("close", new CloseEvent("close", { code, reason, wasClean: true }));
  }
  private fire(type: "open" | "message" | "close", event: Event) {
    this.dispatchEvent(event);
    const handler = this[`on${type}`] as ((event: Event) => void) | null;
    handler?.call(this, event);
  }
}
