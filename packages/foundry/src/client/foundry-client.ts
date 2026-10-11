import type { threadToJSON } from '../viewer/http-helpers';

/** Where a local client reaches the daemon: its loopback origin and, while a tunnel is active, the bearer. */
export interface FoundryEndpoint {
  readonly endpoint: string;
  readonly capability?: string;
}

export type ThreadJSON = ReturnType<typeof threadToJSON>;

export class FoundryHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'FoundryHttpError';
  }
}

/**
 * Typed loopback client for the daemon's HTTP API: the same routes the viewer calls. The bearer is
 * only ever sent to the endpoint's own origin, and redirects are refused.
 */
export class FoundryClient {
  private readonly origin: string;

  constructor(private readonly connection: FoundryEndpoint) {
    this.origin = new URL(connection.endpoint).origin;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.origin}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.connection.capability
          ? { authorization: `Bearer ${this.connection.capability}` }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = { error: text.slice(0, 300) };
    }
    if (!response.ok) {
      const error = typeof parsed.error === 'string' ? parsed.error : `HTTP ${response.status}`;
      throw new FoundryHttpError(error, response.status, parsed);
    }
    return parsed as T;
  }

  health(): Promise<{ ok: boolean }> {
    return this.request('GET', '/api/health');
  }

  /** A new thread. `cwd` resolves its project; a directory outside every project is the global scope. */
  createThread(body: {
    cwd?: string;
    projectId?: string;
    tags?: string[];
    name?: string;
  }): Promise<ThreadJSON> {
    return this.request('POST', '/api/threads', body);
  }

  thread(threadId: string): Promise<ThreadJSON> {
    return this.request('GET', `/api/threads/${encodeURIComponent(threadId)}`);
  }

  updateThread(
    threadId: string,
    body: { worktreePath?: string | null; branch?: string | null; name?: string | null },
  ): Promise<ThreadJSON> {
    return this.request('PATCH', `/api/threads/${encodeURIComponent(threadId)}`, body);
  }

  /** Accept a turn; its output arrives on `thread:<threadId>`, its full terminal to `clientId`. */
  send(turn: {
    threadId: string;
    id: string;
    message: string;
    clientId?: string;
  }): Promise<{ id: string; threadId: string; status: 'accepted'; queued: boolean }> {
    return this.request('POST', '/api/messages/send', turn);
  }

  /** A turn's journalled detail, including its sealed phase rows. */
  turnDetail(
    threadId: string,
    turnId: string,
  ): Promise<{ phases?: unknown[] } & Record<string, unknown>> {
    return this.request(
      'GET',
      `/api/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/detail`,
    );
  }

  interrupt(threadId: string, turnId: string): Promise<{ outcome: string }> {
    return this.request(
      'POST',
      `/api/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/interrupt`,
      {},
    );
  }
}
