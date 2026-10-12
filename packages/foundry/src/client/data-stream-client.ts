import type { FoundryEndpoint } from './foundry-client';

/** What a holder of one data stream receives: its snapshot (again after any reconnect or resync), then appends. */
export interface StreamHandlers {
  snapshot(payload: unknown): void;
  append(payload: unknown): void;
  /** The daemon refused the stream, on first open or on a re-open after a reconnect. */
  rejected?(): void;
}

export interface DataStreamClientOptions extends FoundryEndpoint {
  /** Stable id this client's turns are addressed to (`[A-Za-z0-9_-]{8,64}`). */
  clientId?: string;
  reconnectDelayMs?: number;
  pingIntervalMs?: number;
  /** Connection state changes. */
  onStatus?: (status: 'open' | 'closed' | 'reconnecting') => void;
  /** The current bearer, read on every (re)connect: a restarted daemon publishes a new one. */
  refreshCapability?: () => string | undefined;
  /** Checked before every reconnect (the bearer goes with it); a throw waits and tries again. */
  beforeReconnect?: () => Promise<void>;
}

interface Held {
  handlers: StreamHandlers;
  /** Seq of the last frame received, when the server numbers frames. */
  seq?: number;
  /** Between an open (first, after a reconnect, or a resync) and its snapshot: appends are dropped. */
  awaitingSnapshot: boolean;
  waiters: Array<{ resolve(): void; reject(error: Error): void }>;
}

type Frame = {
  type?: string;
  category?: string;
  action?: string;
  stream?: string;
  seq?: number;
  payload?: unknown;
};

/**
 * Loopback client of the viewer's data-stream socket: open a stream, get its snapshot, then its
 * appends. A dropped connection reconnects and re-opens every held stream, so each handler gets a
 * fresh snapshot; a gap in numbered frames re-opens that stream the same way.
 */
export class DataStreamClient {
  readonly clientId: string;
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private readonly held = new Map<string, Held>();
  private disposed = false;
  private pinger: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: DataStreamClientOptions) {
    this.clientId = options.clientId ?? `acp-${crypto.randomUUID().replaceAll('-', '')}`;
  }

  private url(): string {
    const url = new URL('/ws', new URL(this.options.endpoint).origin);
    url.protocol = 'ws:';
    url.searchParams.set('client', this.clientId);
    return url.toString();
  }

  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(Error('Data-stream client is closed'));
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    this.connecting ??= new Promise<void>((resolve, reject) => {
      const capability = this.options.refreshCapability?.() ?? this.options.capability;
      const socket = new WebSocket(this.url(), {
        headers: capability ? { authorization: `Bearer ${capability}` } : {},
      });
      let opened = false;
      socket.onopen = () => {
        opened = true;
        this.socket = socket;
        this.connecting = null;
        this.options.onStatus?.('open');
        this.pinger ??= setInterval(
          () => this.send({ action: 'ping' }),
          this.options.pingIntervalMs ?? 30_000,
        );
        for (const stream of this.held.keys()) this.send({ action: 'open', stream });
        resolve();
      };
      socket.onmessage = (event) => this.receive(String(event.data));
      socket.onerror = () => {
        if (!opened) {
          this.connecting = null;
          reject(Error('Data-stream socket could not connect'));
        }
      };
      socket.onclose = () => {
        if (this.socket === socket) this.socket = null;
        if (!opened) {
          this.connecting = null;
          reject(Error('Data-stream socket closed before it opened'));
          return;
        }
        // Every held stream re-opens on reconnect; until its snapshot, nothing applies.
        for (const held of this.held.values()) {
          held.seq = undefined;
          held.awaitingSnapshot = true;
        }
        this.options.onStatus?.('closed');
        if (!this.disposed) this.reconnect();
      };
    });
    return this.connecting;
  }

  private reconnect(): void {
    this.options.onStatus?.('reconnecting');
    setTimeout(() => {
      if (this.disposed) return;
      Promise.resolve()
        .then(() => this.options.beforeReconnect?.())
        .then(() => {
          if (this.disposed) return;
          return this.connect();
        })
        .catch(() => {
          if (!this.disposed) this.reconnect();
        });
    }, this.options.reconnectDelayMs ?? 500);
  }

  private send(frame: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private receive(text: string): void {
    let frame: Frame;
    try {
      frame = JSON.parse(text) as Frame;
    } catch {
      return;
    }
    const stream = frame.stream;
    const held = stream ? this.held.get(stream) : undefined;
    if (!stream || !held) return;
    if (frame.type === 'openRejected') {
      this.held.delete(stream);
      for (const waiter of held.waiters.splice(0))
        waiter.reject(Error(`stream rejected: ${stream}`));
      held.handlers.rejected?.();
      return;
    }
    if (frame.type === 'error' && frame.action === 'open') {
      this.send({ action: 'open', stream });
      return;
    }
    if (frame.category !== 'data') return;
    if (frame.action === 'snapshot') {
      held.seq = frame.seq;
      held.awaitingSnapshot = false;
      held.handlers.snapshot(frame.payload);
      for (const waiter of held.waiters.splice(0)) waiter.resolve();
      return;
    }
    if (frame.action !== 'append') return;
    // Appends before the (new) snapshot are already in it, or precede it.
    if (held.awaitingSnapshot) return;
    if (typeof frame.seq === 'number' && typeof held.seq === 'number') {
      // Already applied (in the snapshot, or a resent frame): drop it.
      if (frame.seq <= held.seq) return;
      if (frame.seq > held.seq + 1) {
        // A frame was lost: resync from a fresh snapshot.
        held.seq = undefined;
        held.awaitingSnapshot = true;
        this.send({ action: 'open', stream });
        return;
      }
      held.seq = frame.seq;
    }
    held.handlers.append(frame.payload);
  }

  /** Hold a stream; resolves once its first snapshot has been delivered. */
  async open(stream: string, handlers: StreamHandlers): Promise<void> {
    await this.connect();
    const held: Held = { handlers, waiters: [], awaitingSnapshot: true };
    this.held.set(stream, held);
    const ready = new Promise<void>((resolve, reject) => held.waiters.push({ resolve, reject }));
    this.send({ action: 'open', stream });
    return ready;
  }

  close(stream: string): void {
    if (this.held.delete(stream)) this.send({ action: 'close', stream });
  }

  dispose(): void {
    this.disposed = true;
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
    for (const held of this.held.values())
      for (const waiter of held.waiters.splice(0))
        waiter.reject(Error('Data-stream client closed'));
    this.held.clear();
    this.socket?.close(1000, 'client closed');
    this.socket = null;
  }
}
