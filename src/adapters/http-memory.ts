import type { ContextSource } from "../agents/context-layer";
import type { HydrationAdapter, ContextRef } from "../agents/hydrator";
import type { Signal } from "../agents/signal";

/**
 * HTTP/REST adapter.
 *
 * Talks to any API that returns text or JSON. Zero deps — uses fetch.
 * Use this for:
 * - Notion, Confluence, or any knowledge base API
 * - Custom internal tools
 * - MCP servers
 * - Vector DB APIs (Qdrant, Pinecone, Weaviate)
 * - Any external system with an HTTP interface
 */
export class HttpMemory {
  readonly baseUrl: string;
  private _headers: Record<string, string>;
  private _timeout: number;

  constructor(
    baseUrl: string,
    opts?: {
      headers?: Record<string, string>;
      timeout?: number;
    }
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this._headers = opts?.headers ?? {};
    this._timeout = opts?.timeout ?? 10_000;
  }

  /** GET a path and return the response body as text. */
  async get(path: string, params?: Record<string, string>): Promise<string> {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    const res = await fetch(url.toString(), {
      headers: this._headers,
      signal: AbortSignal.timeout(this._timeout),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText} (${url.pathname})`);
    }

    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const json = await res.json();
      return typeof json === "string" ? json : JSON.stringify(json, null, 2);
    }

    return res.text();
  }

  /** POST to a path with a JSON body. */
  async post(path: string, body: unknown): Promise<string> {
    const url = new URL(path, this.baseUrl);

    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { ...this._headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this._timeout),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText} (${url.pathname})`);
    }

    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const json = await res.json();
      return typeof json === "string" ? json : JSON.stringify(json, null, 2);
    }

    return res.text();
  }

  /**
   * Create a ContextSource that fetches from a GET endpoint.
   * The response body becomes the context content.
   */
  asSource(
    id: string,
    path: string,
    params?: Record<string, string>
  ): ContextSource {
    const http = this;
    return {
      id,
      async load() {
        try {
          return await http.get(path, params);
        } catch (err) {
          import("../logger").then(({ log }) => log.warn(`[HttpMemory] source load failed for "${id}":`, (err as Error).message));
          return "";
        }
      },
    };
  }

  /**
   * Create a HydrationAdapter.
   * Refs use paths as locators, fetched via GET.
   */
  asAdapter(system: string = "http"): HydrationAdapter {
    const http = this;
    return {
      system,
      async hydrate(ref: ContextRef): Promise<string> {
        try {
          const params = ref.meta as Record<string, string> | undefined;
          return await http.get(ref.locator, params);
        } catch (err) {
          import("../logger").then(({ log }) => log.warn(`[HttpMemory] hydrate failed for "${ref.locator}":`, (err as Error).message));
          return "";
        }
      },
    };
  }

  /**
   * Create a signal writer that POSTs signals to an endpoint.
   * Use this to forward signals to an external system.
   */
  signalWriter(path: string = "/signals") {
    const http = this;
    return async (signal: Signal): Promise<void> => {
      try {
        await http.post(path, signal);
      } catch (err) {
        import("../logger").then(({ log }) => log.warn(`[HttpMemory] signal forwarding failed:`, (err as Error).message));
      }
    };
  }
}
