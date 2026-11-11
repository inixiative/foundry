/**
 * @atlas
 * @kind client
 * @partOf feature:threads
 */
import type { ActionPrompt } from '@inixiative/foundry-core';
import type { FeedbackView } from '../feedback/view';
import type { MessageSummary } from '../persistence/local-session-store';
import type { ThreadLaunchPatch } from '../providers/thread-launch';
import type { threadToJSON } from '../viewer/http-helpers';

/** GET /api/threads/:id/launch. */
export interface ThreadLaunchView {
  threadId: string;
  provider: string;
  /** The subscription worker the thread runs on; fixed once its first turn starts. */
  worker: string;
  /** The thread role it chose (null: it follows its worker's default). */
  role: string | null;
  /** The thread role its instructions compose as. */
  effectiveRole: string;
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
    /** The workers a thread here may run on: its project's default and each other one with a login. */
    workers: Array<{ id: string; label: string; default: boolean; defaultRole: string }>;
    /** The thread roles a thread here may run as. */
    roles: Array<{ id: string; label: string }>;
  };
  /** Executor models pinned in settings that this thread's worker does not run. */
  setAside: Array<{ agent: string; model: string }>;
  /** Whether a send during a running turn steers into it, from the `steer` setting (CORE-001). */
  steer: boolean;
}

/** Where a local client reaches the daemon: its loopback origin. */
export interface FoundryEndpoint {
  readonly endpoint: string;
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
 * Typed loopback client for the daemon's HTTP API: the same routes the viewer calls. Redirects are
 * refused.
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
        ...(body === undefined
          ? {}
          : {
              'content-type':
                body instanceof Uint8Array ? 'application/octet-stream' : 'application/json',
            }),
      },
      ...(body === undefined
        ? {}
        : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
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

  /**
   * The pid of the process answering on the endpoint, asked without the bearer so a listener that
   * is not the daemon never receives it. An unhealthy daemon still answers; an unreachable one throws.
   */
  async daemonPid(): Promise<number | undefined> {
    const body = await this.request<{ pid?: unknown }>('GET', '/api/health').catch((error) => {
      if (error instanceof FoundryHttpError) return error.body as { pid?: unknown };
      throw error;
    });
    return typeof body.pid === 'number' ? body.pid : undefined;
  }

  /** Archive a thread (its history stays on disk; it takes no more turns). */
  archiveThread(threadId: string): Promise<{ ok: boolean }> {
    return this.request('POST', '/api/actions', {
      kind: 'thread:archive',
      target: threadId,
      operator: 'acp',
    });
  }

  /** A new thread. `cwd` resolves its project; a directory outside every project is the global scope. */
  createThread(body: {
    cwd?: string;
    projectId?: string;
    tags?: string[];
    name?: string;
    /** The subscription worker; the project's default when absent. */
    worker?: string;
    /** The thread role (coder, assistant, …); the worker's default when absent. */
    role?: string;
  }): Promise<ThreadJSON> {
    return this.request('POST', '/api/threads', body);
  }

  thread(threadId: string): Promise<ThreadJSON> {
    return this.request('GET', `/api/threads/${encodeURIComponent(threadId)}`);
  }

  updateThread(
    threadId: string,
    body: {
      worktreePath?: string | null;
      branch?: string | null;
      name?: string | null;
      /** Before the thread's first turn only (409 after). */
      worker?: string;
      /** Any time; applies from the next turn. Null follows the worker's default. */
      role?: string | null;
    },
  ): Promise<ThreadJSON> {
    return this.request('PATCH', `/api/threads/${encodeURIComponent(threadId)}`, body);
  }

  /** Store an image (png, jpeg, gif or webp, at most 5 MB) for a later send to name by id. */
  uploadImage(
    bytes: Uint8Array,
  ): Promise<{ id: string; mediaType: string; bytes: number; url: string }> {
    return this.request('POST', '/api/attachments/images', bytes);
  }

  /** Accept a turn; its output arrives on `thread:<threadId>`, its full terminal to `clientId`. */
  send(turn: {
    threadId: string;
    id: string;
    message: string;
    clientId?: string;
    /** Image ids from `uploadImage`. */
    images?: string[];
    /** Sent during a running turn: `queue` waits, `steer` goes in; absent, the `steer` setting decides (CORE-001). */
    delivery?: 'steer' | 'queue';
  }): Promise<{
    id: string;
    threadId: string;
    status: 'accepted' | 'steered';
    queued: boolean;
    /** Sent during a running turn: steered into it (`into`), or why it queued (`reason`). */
    steer?:
      | { steered: true; into: string; native: 'steered' | 'unknown' }
      | { steered: false; reason: string };
    /** The thread is setting up its Wardens: the turn waits queued until it is ready. */
    settingUp?: boolean;
  }> {
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

  /** Answer a feedback item's open tuning prompt: apply, edit (with the rule), dismiss or later. */
  answerFeedback(
    itemId: string,
    action: string,
    surface: string,
    input?: string,
  ): Promise<{ ok: boolean }> {
    return this.request('POST', `/api/feedback/${encodeURIComponent(itemId)}/answer`, {
      action,
      surface,
      ...(input !== undefined ? { input } : {}),
    });
  }

  /** Feedback lifecycle items, all or one project's. */
  feedback(projectId?: string): Promise<{ items: FeedbackView[] }> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return this.request('GET', `/api/feedback${query}`);
  }

  /** `/feedback <text>`: an explicit feedback item on a thread, pointing at its last turn unless one is named. */
  giveFeedback(
    threadId: string,
    body: { text: string; surface: string; turnId?: string; messageId?: string; tags?: string[] },
  ): Promise<{ item: FeedbackView }> {
    return this.request('POST', `/api/threads/${encodeURIComponent(threadId)}/feedback`, body);
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
