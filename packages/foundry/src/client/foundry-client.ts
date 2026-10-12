import type { ActionPrompt } from '@inixiative/foundry-core';
import type { MessageSummary } from '../persistence/local-session-store';
import type { ThreadLaunchPatch } from '../providers/thread-launch';
import type { threadToJSON } from '../viewer/http-helpers';

/** GET /api/threads/:id/launch. */
export interface ThreadLaunchView {
  threadId: string;
  provider: string;
  permissionMode: string | null;
  model: string;
  modelOverride: string | null;
  effort: string | null;
  mcpServers: Array<{ name: string; type: 'stdio' | 'http' }>;
  revision: number;
  options: {
    permissionModes: readonly string[];
    models: Array<{ id: string; label: string }>;
    efforts: readonly string[];
  };
}

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

  /** One page of the thread's journalled history (newest page first; `before` pages older). */
  history(
    threadId: string,
    before?: string,
  ): Promise<{
    messages: MessageSummary[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    const query = new URLSearchParams({ limit: '200', ...(before ? { before } : {}) });
    return this.request('GET', `/api/threads/${encodeURIComponent(threadId)}/history?${query}`);
  }

  /** What hosts chose for the thread's executor session, and the options. */
  launch(threadId: string): Promise<ThreadLaunchView> {
    return this.request('GET', `/api/threads/${encodeURIComponent(threadId)}/launch`);
  }

  updateLaunch(threadId: string, patch: ThreadLaunchPatch): Promise<ThreadLaunchView> {
    return this.request('PATCH', `/api/threads/${encodeURIComponent(threadId)}/launch`, patch);
  }

  /** A thread's prompts (pending and settled). */
  prompts(threadId: string): Promise<{ prompts: ActionPrompt[] }> {
    return this.request('GET', `/api/prompts?threadId=${encodeURIComponent(threadId)}`);
  }

  /** Answer a pending prompt; `always` keeps the answer for this tool in this thread. */
  resolvePrompt(
    promptId: string,
    action: 'approved' | 'rejected',
    always = false,
  ): Promise<{ ok: boolean }> {
    return this.request('POST', `/api/prompts/${encodeURIComponent(promptId)}/resolve`, {
      action,
      ...(always ? { always: true } : {}),
    });
  }

  /** Record a correction against a turn's span: it reaches the thread's feedback capture. */
  intervene(
    threadId: string,
    body: {
      traceId: string;
      spanId: string;
      correction: string;
      reason?: string;
      operator: string;
    },
  ): Promise<{ id: string }> {
    return this.request('POST', `/api/threads/${encodeURIComponent(threadId)}/interventions`, {
      actual: null,
      ...body,
    });
  }

  interrupt(threadId: string, turnId: string): Promise<{ outcome: string }> {
    return this.request(
      'POST',
      `/api/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/interrupt`,
      {},
    );
  }
}
