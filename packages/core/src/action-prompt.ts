// ---------------------------------------------------------------------------
// ActionPrompt — blocking agent→human interaction primitive
// ---------------------------------------------------------------------------
//
// When an agent needs human input (approval, choice, free text), it emits
// an ActionPrompt via the ActionQueue. The prompt blocks the agent until
// resolved by a human (viewer UI) or a policy hook (auto-resolver).
//
// Threads track pending prompts. The viewer shows badge counts for
// unresolved prompts in the thread subtree.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PromptKind = "approval" | "choice" | "input" | "confirm";
export type PromptUrgency = "low" | "normal" | "high" | "critical";
export type PromptStatus = "pending" | "approved" | "rejected" | "expired" | "auto-resolved";

export interface ActionOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /** Visual hint — UI may render this differently. */
  readonly dangerous?: boolean;
}

export interface ActionResolution {
  readonly by: "human" | "policy" | "timeout";
  readonly action: string; // "approved", "rejected", or an option ID
  readonly input?: string; // for "input" kind prompts
  readonly timestamp: number;
}

export interface ActionPrompt {
  readonly id: string;
  readonly threadId: string;
  readonly agentId: string;
  readonly timestamp: number;

  readonly kind: PromptKind;
  readonly message: string;
  readonly options?: readonly ActionOption[];

  /** Which capability triggered this prompt (if any). */
  readonly capability?: string;
  readonly urgency: PromptUrgency;
  readonly expiresAt?: number;

  /** Arbitrary metadata from the agent. */
  readonly meta?: Record<string, unknown>;

  status: PromptStatus;
  resolution?: ActionResolution;
}

export interface PromptOpts {
  kind: PromptKind;
  message: string;
  agentId: string;
  threadId: string;
  options?: ActionOption[];
  capability?: string;
  urgency?: PromptUrgency;
  /** Auto-expire after this many ms. Resolves as rejected. */
  timeoutMs?: number;
  meta?: Record<string, unknown>;
}

/** Listener called when a new prompt is emitted. */
export type PromptListener = (prompt: ActionPrompt) => void;

/** Auto-resolver — return a resolution to auto-handle, or null to let it pend. */
export type PromptPolicy = (prompt: ActionPrompt) => ActionResolution | null;

// ---------------------------------------------------------------------------
// ActionQueue
// ---------------------------------------------------------------------------

export class ActionQueue {
  private _prompts = new Map<string, ActionPrompt>();
  private _waiters = new Map<string, { resolve: (r: ActionResolution) => void; timer?: ReturnType<typeof setTimeout> }>();
  private _listeners: PromptListener[] = [];
  private _policies: PromptPolicy[] = [];

  /** Register a listener for new prompts (e.g. viewer push, badge update). */
  onPrompt(fn: PromptListener): () => void {
    this._listeners.push(fn);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== fn);
    };
  }

  /** Register an auto-resolver policy. Checked before the prompt blocks. */
  addPolicy(fn: PromptPolicy): () => void {
    this._policies.push(fn);
    return () => {
      this._policies = this._policies.filter((p) => p !== fn);
    };
  }

  /**
   * Emit a prompt and block until resolved.
   * Returns the resolution (human choice, policy decision, or timeout).
   */
  async prompt(opts: PromptOpts): Promise<ActionResolution> {
    const id = `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const prompt: ActionPrompt = {
      id,
      threadId: opts.threadId,
      agentId: opts.agentId,
      timestamp: Date.now(),
      kind: opts.kind,
      message: opts.message,
      options: opts.options,
      capability: opts.capability,
      urgency: opts.urgency ?? "normal",
      expiresAt: opts.timeoutMs ? Date.now() + opts.timeoutMs : undefined,
      meta: opts.meta,
      status: "pending",
    };

    this._prompts.set(id, prompt);

    // Check policies first — may auto-resolve
    for (const policy of this._policies) {
      const resolution = policy(prompt);
      if (resolution) {
        prompt.status = "auto-resolved";
        prompt.resolution = resolution;
        return resolution;
      }
    }

    // Notify listeners (viewer badge, event stream, etc.)
    for (const fn of this._listeners) {
      try { fn(prompt); } catch { /* listener errors don't block */ }
    }

    // Block until resolved
    return new Promise<ActionResolution>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          const resolution: ActionResolution = {
            by: "timeout",
            action: "rejected",
            timestamp: Date.now(),
          };
          prompt.status = "expired";
          prompt.resolution = resolution;
          this._waiters.delete(id);
          resolve(resolution);
        }, opts.timeoutMs);
      }

      this._waiters.set(id, { resolve, timer });
    });
  }

  /**
   * Resolve a pending prompt. Called by the viewer UI or external systems.
   */
  resolve(promptId: string, action: string, opts?: { by?: "human" | "policy"; input?: string }): boolean {
    const prompt = this._prompts.get(promptId);
    if (!prompt || prompt.status !== "pending") return false;

    const resolution: ActionResolution = {
      by: opts?.by ?? "human",
      action,
      input: opts?.input,
      timestamp: Date.now(),
    };

    prompt.status = action === "approved" || action === "confirmed" ? "approved" : "rejected";
    // For choice prompts, mark as approved if any option selected
    if (prompt.kind === "choice" && prompt.options?.some((o) => o.id === action)) {
      prompt.status = "approved";
    }
    prompt.resolution = resolution;

    const waiter = this._waiters.get(promptId);
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(resolution);
      this._waiters.delete(promptId);
    }

    return true;
  }

  /** Get all pending prompts. */
  pending(): ActionPrompt[] {
    return [...this._prompts.values()].filter((p) => p.status === "pending");
  }

  /** Get all prompts for a thread (including resolved). */
  forThread(threadId: string): ActionPrompt[] {
    return [...this._prompts.values()].filter((p) => p.threadId === threadId);
  }

  /** Pending count — for badge display. */
  pendingCount(threadId?: string): number {
    let count = 0;
    for (const p of this._prompts.values()) {
      if (p.status === "pending" && (!threadId || p.threadId === threadId)) count++;
    }
    return count;
  }

  /** Get a prompt by ID. */
  get(promptId: string): ActionPrompt | undefined {
    return this._prompts.get(promptId);
  }

  /** Clear resolved/expired prompts older than the given age. */
  prune(maxAgeMs: number = 3600_000): number {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;
    for (const [id, p] of this._prompts) {
      if (p.status !== "pending" && p.timestamp < cutoff) {
        this._prompts.delete(id);
        pruned++;
      }
    }
    return pruned;
  }
}
