import type { ContextSource } from "../agents/context-layer";
import type { HydrationAdapter, ContextRef } from "../agents/hydrator";
import type { Signal } from "../agents/signal";

/**
 * Minimal interface for Redis client — compatible with ioredis.
 * We don't import ioredis directly so it stays an optional peer dep.
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: any[]): Promise<any>;
  del(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  hset(key: string, field: string, value: string): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, field: string): Promise<number>;
  lpush(key: string, ...values: string[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, callback?: any): Promise<any>;
  expire(key: string, seconds: number): Promise<number>;
}

/**
 * Redis-backed memory system.
 *
 * Requires ioredis as a peer dependency:
 *   bun add ioredis
 *
 * Uses Redis hashes for structured entries and lists for recent history.
 * Good for multi-machine deployments, ephemeral state, and pub/sub.
 *
 * Usage:
 *   import Redis from "ioredis";
 *   const redis = new Redis();
 *   const memory = new RedisMemory(redis, "foundry:");
 */
export class RedisMemory {
  private _client: RedisClient;
  private _prefix: string;

  constructor(client: RedisClient, prefix: string = "foundry:") {
    this._client = client;
    this._prefix = prefix;
  }

  private _key(id: string): string {
    return `${this._prefix}entry:${id}`;
  }

  private _indexKey(kind: string): string {
    return `${this._prefix}index:${kind}`;
  }

  private _recentKey(): string {
    return `${this._prefix}recent`;
  }

  /** Write an entry. */
  async write(entry: RedisEntry): Promise<void> {
    const key = this._key(entry.id);
    await this._client.hset(key, "id", entry.id);
    await this._client.hset(key, "kind", entry.kind);
    await this._client.hset(key, "content", entry.content);
    await this._client.hset(key, "timestamp", String(entry.timestamp));
    if (entry.source) await this._client.hset(key, "source", entry.source);
    if (entry.meta) await this._client.hset(key, "meta", JSON.stringify(entry.meta));

    if (entry.ttl) {
      await this._client.expire(key, entry.ttl);
    }

    // Add to kind index and recent list
    await this._client.lpush(this._indexKey(entry.kind), entry.id);
    await this._client.lpush(this._recentKey(), entry.id);
  }

  /** Read by id. */
  async get(id: string): Promise<RedisEntry | undefined> {
    const data = await this._client.hgetall(this._key(id));
    if (!data || !data.id) return undefined;
    return this._toEntry(data);
  }

  /** Get recent entries by kind. */
  async recent(limit: number = 50, kind?: string): Promise<RedisEntry[]> {
    const listKey = kind ? this._indexKey(kind) : this._recentKey();
    const ids = await this._client.lrange(listKey, 0, limit - 1);

    const entries: RedisEntry[] = [];
    for (const id of ids) {
      const entry = await this.get(id);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /** Delete by id. */
  async delete(id: string): Promise<boolean> {
    const result = await this._client.del(this._key(id));
    return result > 0;
  }

  /** Create a ContextSource. */
  asSource(id: string, kind?: string, limit: number = 50): ContextSource {
    const mem = this;
    return {
      id,
      async load() {
        const entries = await mem.recent(limit, kind);
        if (entries.length === 0) return "";
        return entries
          .map((e) => `[${e.kind}] ${e.id}: ${e.content}`)
          .join("\n");
      },
    };
  }

  /** Create a HydrationAdapter. */
  asAdapter(): HydrationAdapter {
    const mem = this;
    return {
      system: "redis",
      async hydrate(ref: ContextRef): Promise<string> {
        const entry = await mem.get(ref.locator);
        return entry ? entry.content : "";
      },
    };
  }

  /** Signal handler that writes signals to Redis. */
  signalWriter(ttl?: number) {
    const mem = this;
    return async (signal: Signal): Promise<void> => {
      await mem.write({
        id: signal.id,
        kind: signal.kind,
        content:
          typeof signal.content === "string"
            ? signal.content
            : JSON.stringify(signal.content),
        source: signal.source,
        timestamp: signal.timestamp,
        meta: { confidence: signal.confidence, refs: signal.refs },
        ttl,
      });
    };
  }

  /**
   * Signal handler that publishes signals to a Redis pub/sub channel.
   * Use for cross-process signal propagation.
   */
  signalPublisher(channel: string = "foundry:signals") {
    const client = this._client;
    return async (signal: Signal): Promise<void> => {
      await client.publish(channel, JSON.stringify(signal));
    };
  }

  private _toEntry(data: Record<string, string>): RedisEntry {
    return {
      id: data.id,
      kind: data.kind,
      content: data.content,
      source: data.source || undefined,
      timestamp: Number(data.timestamp),
      meta: data.meta ? JSON.parse(data.meta) : undefined,
    };
  }
}

export interface RedisEntry {
  readonly id: string;
  readonly kind: string;
  readonly content: string;
  readonly source?: string;
  readonly timestamp: number;
  readonly meta?: Record<string, unknown>;
  /** TTL in seconds — entry expires after this. */
  readonly ttl?: number;
}
