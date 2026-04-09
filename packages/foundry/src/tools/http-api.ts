// ---------------------------------------------------------------------------
// HttpApi — ApiTool adapter wrapping fetch with structured I/O
// ---------------------------------------------------------------------------
//
// Better than curl/bash for API calls because:
// - Typed request/response — agents don't parse raw text
// - Auth management — bearer tokens, default headers applied automatically
// - Response truncation — large responses get capped before entering context
// - URL gating — allowedUrls/blockedUrls enforced at the tool level
// - Timing — every response includes durationMs for observability
//
// Usage:
//   const api = new HttpApi({ baseUrl: "https://api.example.com" });
//   registry.register(api, "Make HTTP requests to the Example API");
//
//   const result = await api.get("/users?active=true");
//   // result.data.body is typed, result.summary is "GET /users — 200 OK (42ms)"
// ---------------------------------------------------------------------------

import type {
  ApiTool,
  ApiRequest,
  ApiResponse,
  ApiToolConfig,
  ToolResult,
} from "@inixiative/foundry-core";

export interface HttpApiConfig extends ApiToolConfig {
  id?: string;
}

export class HttpApi implements ApiTool {
  readonly id: string;
  readonly kind = "api" as const;
  readonly capability = "net:api" as const;

  private _config: Required<Omit<HttpApiConfig, "id">>;

  constructor(config?: HttpApiConfig) {
    this.id = config?.id ?? "api";
    this._config = {
      baseUrl: config?.baseUrl ?? "",
      defaultHeaders: config?.defaultHeaders ?? {},
      bearerToken: config?.bearerToken ?? "",
      maxResponseSize: config?.maxResponseSize ?? 1_048_576, // 1MB
      allowedUrls: config?.allowedUrls ?? [],
      blockedUrls: config?.blockedUrls ?? [],
    };
  }

  /** Update auth token at runtime (e.g., after login flow). */
  setBearerToken(token: string): void {
    this._config.bearerToken = token;
  }

  /** Update base URL at runtime. */
  setBaseUrl(url: string): void {
    this._config.baseUrl = url;
  }

  // ---- ApiTool interface ----

  async request<T = unknown>(req: ApiRequest): Promise<ToolResult<ApiResponse<T>>> {
    const url = this._resolveUrl(req.url);
    const method = req.method ?? "GET";

    // URL gating
    if (!this._isUrlAllowed(url)) {
      return {
        ok: false,
        summary: `${method} ${req.url} — blocked by URL policy`,
        error: "URL not allowed",
      };
    }

    // Build headers
    const headers: Record<string, string> = {
      ...this._config.defaultHeaders,
      ...req.headers,
    };
    if (this._config.bearerToken && !headers["Authorization"]) {
      headers["Authorization"] = `Bearer ${this._config.bearerToken}`;
    }
    if (req.body != null && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    // Build fetch options
    const fetchOpts: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(req.timeout ?? 30_000),
    };
    if (req.body != null) {
      fetchOpts.body = typeof req.body === "string"
        ? req.body
        : JSON.stringify(req.body);
    }

    const start = performance.now();
    try {
      const response = await fetch(url, fetchOpts);
      const durationMs = Math.round(performance.now() - start);

      // Parse response headers
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      // Parse body based on requested type
      let body: T;
      const responseType = req.responseType ?? "json";

      if (responseType === "json") {
        const text = await response.text();
        const truncated = text.length > this._config.maxResponseSize
          ? text.slice(0, this._config.maxResponseSize)
          : text;
        try {
          body = JSON.parse(truncated) as T;
        } catch {
          body = truncated as unknown as T;
        }
      } else if (responseType === "text") {
        const text = await response.text();
        body = (text.length > this._config.maxResponseSize
          ? text.slice(0, this._config.maxResponseSize)
          : text) as unknown as T;
      } else {
        const buf = await response.arrayBuffer();
        body = Buffer.from(buf) as unknown as T;
      }

      const apiResponse: ApiResponse<T> = {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body,
        durationMs,
      };

      const ok = response.status >= 200 && response.status < 400;
      const summary = `${method} ${req.url} — ${response.status} ${response.statusText} (${durationMs}ms)`;

      return {
        ok,
        data: apiResponse,
        summary,
        error: ok ? undefined : `HTTP ${response.status}: ${response.statusText}`,
        estimatedTokens: Math.ceil(summary.length / 4) + Math.ceil(JSON.stringify(body).length / 4),
      };
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      const message = (err as Error).message;
      return {
        ok: false,
        summary: `${method} ${req.url} — failed (${durationMs}ms)`,
        error: message.includes("AbortError") || message.includes("timeout")
          ? `Request timed out after ${req.timeout ?? 30_000}ms`
          : message,
      };
    }
  }

  async get<T = unknown>(
    url: string,
    headers?: Record<string, string>
  ): Promise<ToolResult<ApiResponse<T>>> {
    return this.request<T>({ url, method: "GET", headers });
  }

  async post<T = unknown>(
    url: string,
    body: unknown,
    headers?: Record<string, string>
  ): Promise<ToolResult<ApiResponse<T>>> {
    return this.request<T>({ url, method: "POST", body, headers });
  }

  async put<T = unknown>(
    url: string,
    body: unknown,
    headers?: Record<string, string>
  ): Promise<ToolResult<ApiResponse<T>>> {
    return this.request<T>({ url, method: "PUT", body, headers });
  }

  async delete<T = unknown>(
    url: string,
    headers?: Record<string, string>
  ): Promise<ToolResult<ApiResponse<T>>> {
    return this.request<T>({ url, method: "DELETE", headers });
  }

  // ---- Internals ----

  private _resolveUrl(url: string): string {
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    const base = this._config.baseUrl.replace(/\/+$/, "");
    const path = url.startsWith("/") ? url : `/${url}`;
    return `${base}${path}`;
  }

  private _isUrlAllowed(url: string): boolean {
    const { allowedUrls, blockedUrls } = this._config;

    if (blockedUrls.length > 0) {
      for (const pattern of blockedUrls) {
        if (this._matchGlob(url, pattern)) return false;
      }
    }

    if (allowedUrls.length === 0) return true;

    for (const pattern of allowedUrls) {
      if (this._matchGlob(url, pattern)) return true;
    }
    return false;
  }

  private _matchGlob(url: string, pattern: string): boolean {
    const regex = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "<<<GLOBSTAR>>>")
      .replace(/\*/g, "[^/]*")
      .replace(/<<<GLOBSTAR>>>/g, ".*");
    return new RegExp(`^${regex}$`).test(url);
  }
}
