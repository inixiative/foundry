import type { z } from 'zod';
import { connectionCheckJobHandler } from './connection-check-job';
import type { KingdomInstallation } from './kingdom-runtime-connection';
import type { RuntimeJob } from './runtime-job-contracts';

/** Enrolled runtime identity returned by `runtimeHeartbeat`. */
/** Kingdom's owner reference: the model plus whichever ids identify it. */
export type RuntimeOwner = {
  ownerModel: string;
  userId?: string | null;
  organizationId?: string | null;
  spaceId?: string | null;
};
export type RuntimeIdentity = {
  installationId: string;
  userId: string | null;
  owner: RuntimeOwner;
  expiresAt: string;
};

/** Kingdom access call a handler may make. Handler actions are the handler's own; the worker never enumerates them. */
export type RuntimeJobRequest = (action: string, body: unknown) => Promise<unknown>;

export interface RuntimeJobContext {
  readonly settings: KingdomInstallation;
  /** Private 0700 job directory, created and ownership-checked by the worker. */
  readonly directory: string;
  /** Private runtime root holding the installation credential. */
  readonly runtimeDirectory: string;
  readonly request: RuntimeJobRequest;
  readonly stopped: () => boolean;
}

export interface RuntimeJobHandler<Payload = unknown> {
  readonly kind: string;
  /** Parses the polled job envelope into this handler's own payload. */
  readonly payload: z.ZodType<Payload>;
  /** True when the handler carries its own deadline and the envelope expiry must not pre-empt it. */
  readonly ignoresExpiry?: boolean;
  /** Per-action request timeouts in ms; actions absent here use the worker default. */
  readonly requestTimeoutMs?: Readonly<Record<string, number>>;
  /** Fields merged into the runtime heartbeat body. */
  heartbeatBody?(): Record<string, unknown>;
  /** Throws when the enrolled identity no longer matches this handler's configuration. */
  verifyIdentity?(identity: RuntimeIdentity): void;
  run(job: RuntimeJob, payload: Payload, context: RuntimeJobContext): Promise<void>;
}

/** Job kinds a runtime may execute. `connectionCheck` is framework and is always present. */
export class RuntimeJobRegistry {
  private handlers = new Map<string, RuntimeJobHandler>();
  constructor() {
    this.register(connectionCheckJobHandler);
  }
  register<Payload>(handler: RuntimeJobHandler<Payload>): this {
    if (this.handlers.has(handler.kind))
      throw Error(`Runtime job kind ${JSON.stringify(handler.kind)} is already registered`);
    this.handlers.set(handler.kind, handler as RuntimeJobHandler);
    return this;
  }
  /** Fails closed: an unregistered kind is refused, never skipped. */
  require(kind: string): RuntimeJobHandler {
    const handler = this.handlers.get(kind);
    if (!handler)
      throw Error(`No runtime job handler is registered for kind ${JSON.stringify(kind)}`);
    return handler;
  }
  get kinds(): string[] {
    return [...this.handlers.keys()];
  }
  all(): RuntimeJobHandler[] {
    return [...this.handlers.values()];
  }
}
