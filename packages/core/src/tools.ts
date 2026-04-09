// ---------------------------------------------------------------------------
// Tools — typed interfaces for agent execution environments
// ---------------------------------------------------------------------------
//
// Agents need to do more than generate text. They need to search code,
// navigate browsers, call APIs, and execute scripts. Each of these is a
// "tool" with typed inputs/outputs, capability requirements, and
// observable side effects.
//
// This file defines the interfaces. Implementations live in adapters
// (core: lightweight, foundry: heavy-infra).
//
// Design principles:
// - Every tool operation maps to a capability for gating
// - Tool results are structured (JSON), not raw text — models waste
//   fewer tokens parsing unstructured output
// - Tools are registry-managed so agents discover what's available
//   without bloating their context with tool descriptions upfront
// ---------------------------------------------------------------------------

import type { Capability } from "./capability";

// ---------------------------------------------------------------------------
// Tool result — every tool returns this wrapper
// ---------------------------------------------------------------------------

export interface ToolResult<T = unknown> {
  /** Whether the operation succeeded. */
  ok: boolean;
  /** Structured result data. */
  data?: T;
  /** Human-readable summary (for injecting into agent context). */
  summary: string;
  /** Error message if ok=false. */
  error?: string;
  /** Token estimate for the result (helps agents budget context). */
  estimatedTokens?: number;
}

// ---------------------------------------------------------------------------
// BrowserTool — navigate, interact with, and extract data from web pages
// ---------------------------------------------------------------------------

/** Accessibility tree element from a page snapshot. */
export interface PageElement {
  role: string;
  name: string;
  ref?: string;
  value?: string;
  children?: PageElement[];
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: PageElement[];
  /** Estimated token count of the full snapshot. */
  estimatedTokens: number;
}

export interface NavigateOpts {
  /** Wait for this selector to appear before returning. */
  waitFor?: string;
  /** Timeout in ms. Default: 30000. */
  timeout?: number;
}

export interface BrowserTool {
  readonly id: string;
  readonly kind: "browser";

  /** Required capabilities for each operation. */
  readonly capabilities: {
    navigate: Capability;
    interact: Capability;
    execute: Capability;
    screenshot: Capability;
  };

  /** Navigate to a URL. */
  navigate(url: string, opts?: NavigateOpts): Promise<ToolResult<{ url: string; title: string }>>;

  /** Get the current page's accessibility tree snapshot. */
  snapshot(): Promise<ToolResult<PageSnapshot>>;

  /** Click an element by reference ID or selector. */
  click(ref: string): Promise<ToolResult<void>>;

  /** Fill a form field by reference ID or selector. */
  fill(ref: string, value: string): Promise<ToolResult<void>>;

  /** Select an option in a dropdown. */
  select(ref: string, value: string): Promise<ToolResult<void>>;

  /** Execute JavaScript in the page context. Returns serializable result. */
  evaluate<T = unknown>(script: string): Promise<ToolResult<T>>;

  /** Take a screenshot. Returns base64-encoded image. */
  screenshot(): Promise<ToolResult<{ base64: string; mimeType: string }>>;

  /** Get current page URL. */
  currentUrl(): Promise<string>;

  /** Close the browser / release resources. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// ApiTool — structured HTTP requests (better than curl)
// ---------------------------------------------------------------------------

export interface ApiRequest {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  headers?: Record<string, string>;
  body?: unknown;
  /** Timeout in ms. Default: 30000. */
  timeout?: number;
  /** Parse response body as this type. Default: "json". */
  responseType?: "json" | "text" | "buffer";
}

export interface ApiResponse<T = unknown> {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: T;
  /** Round-trip time in ms. */
  durationMs: number;
}

export interface ApiToolConfig {
  /** Base URL prepended to relative paths. */
  baseUrl?: string;
  /** Default headers applied to every request. */
  defaultHeaders?: Record<string, string>;
  /** Auth token applied as Authorization: Bearer header. */
  bearerToken?: string;
  /** Max response body size in bytes before truncation. Default: 1MB. */
  maxResponseSize?: number;
  /** Allowed URL patterns (glob). Empty = allow all. */
  allowedUrls?: string[];
  /** Blocked URL patterns (glob). Takes precedence. */
  blockedUrls?: string[];
}

export interface ApiTool {
  readonly id: string;
  readonly kind: "api";

  /** Required capability. */
  readonly capability: Capability;

  /** Make an HTTP request. */
  request<T = unknown>(req: ApiRequest): Promise<ToolResult<ApiResponse<T>>>;

  /** Convenience: GET request. */
  get<T = unknown>(url: string, headers?: Record<string, string>): Promise<ToolResult<ApiResponse<T>>>;

  /** Convenience: POST request with JSON body. */
  post<T = unknown>(url: string, body: unknown, headers?: Record<string, string>): Promise<ToolResult<ApiResponse<T>>>;

  /** Convenience: PUT request with JSON body. */
  put<T = unknown>(url: string, body: unknown, headers?: Record<string, string>): Promise<ToolResult<ApiResponse<T>>>;

  /** Convenience: DELETE request. */
  delete<T = unknown>(url: string, headers?: Record<string, string>): Promise<ToolResult<ApiResponse<T>>>;
}

// ---------------------------------------------------------------------------
// ShellTool — structured shell execution (better than raw bash)
// ---------------------------------------------------------------------------

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Whether stdout was truncated to fit token budget. */
  truncated: boolean;
  durationMs: number;
}

export interface ShellOpts {
  /** Working directory. */
  cwd?: string;
  /** Environment variables. */
  env?: Record<string, string>;
  /** Timeout in ms. Default: 120000. */
  timeout?: number;
  /** Max stdout bytes before truncation. Default: 100KB. */
  maxOutput?: number;
  /** Run in sandboxed mode (just-bash). */
  sandbox?: boolean;
}

export interface ShellTool {
  readonly id: string;
  readonly kind: "shell";

  /** Required capability. */
  readonly capability: Capability;

  /** Execute a shell command. */
  exec(command: string, opts?: ShellOpts): Promise<ToolResult<ShellResult>>;

  /** Execute and return only stdout (convenience). */
  run(command: string, opts?: ShellOpts): Promise<string>;

  /** Check if a command exists. */
  which(command: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// ScriptTool — TypeScript/JS execution in isolate
// ---------------------------------------------------------------------------

export interface ScriptResult<T = unknown> {
  /** The return value of the script. */
  result: T;
  /** Console output captured during execution. */
  logs: string[];
  durationMs: number;
}

export interface ScriptOpts {
  /** Timeout in ms. Default: 30000. */
  timeout?: number;
  /** Modules available to the script (injected into scope). */
  modules?: Record<string, unknown>;
  /** Whether to capture console.log output. Default: true. */
  captureLogs?: boolean;
}

export interface ScriptTool {
  readonly id: string;
  readonly kind: "script";

  /** Required capability. */
  readonly capability: Capability;

  /** Execute a TypeScript/JS script and return the result. */
  evaluate<T = unknown>(code: string, opts?: ScriptOpts): Promise<ToolResult<ScriptResult<T>>>;
}

// ---------------------------------------------------------------------------
// Tool union type + registry
// ---------------------------------------------------------------------------

/** Any tool that can be registered. */
export type Tool = BrowserTool | ApiTool | ShellTool | ScriptTool;

/** Tool kind discriminator. */
export type ToolKind = Tool["kind"];

/** Metadata about a registered tool (what agents see before using it). */
export interface ToolInfo {
  id: string;
  kind: ToolKind;
  /** Short description for agent context. */
  description: string;
  /** Capabilities required to use this tool. */
  capabilities: Capability[];
}

/**
 * ToolRegistry — agents discover and access tools through this.
 *
 * Instead of injecting all tool descriptions into agent context (which bloats
 * the prompt), agents query the registry for tools matching their needs.
 * The registry returns typed tool instances that go through capability gating.
 *
 * This is the "connector information" layer — adapters register here,
 * agents consume from here.
 */
export class ToolRegistry {
  private _tools = new Map<string, Tool>();
  private _info = new Map<string, ToolInfo>();

  /** Register a tool with its metadata. */
  register(tool: Tool, description: string): void {
    this._tools.set(tool.id, tool);

    const capabilities: Capability[] = [];
    if (tool.kind === "browser") {
      capabilities.push(
        tool.capabilities.navigate,
        tool.capabilities.interact,
        tool.capabilities.execute,
        tool.capabilities.screenshot,
      );
    } else {
      capabilities.push(tool.capability);
    }

    this._info.set(tool.id, {
      id: tool.id,
      kind: tool.kind,
      description,
      capabilities,
    });
  }

  /** Unregister a tool. */
  unregister(id: string): void {
    this._tools.delete(id);
    this._info.delete(id);
  }

  /** Get a tool by ID. */
  get<T extends Tool = Tool>(id: string): T | undefined {
    return this._tools.get(id) as T | undefined;
  }

  /** Get a tool by kind (returns first match). */
  byKind<K extends ToolKind>(kind: K): Extract<Tool, { kind: K }> | undefined {
    for (const tool of this._tools.values()) {
      if (tool.kind === kind) return tool as Extract<Tool, { kind: K }>;
    }
    return undefined;
  }

  /** Get all tools of a given kind. */
  allByKind<K extends ToolKind>(kind: K): Extract<Tool, { kind: K }>[] {
    const result: Extract<Tool, { kind: K }>[] = [];
    for (const tool of this._tools.values()) {
      if (tool.kind === kind) result.push(tool as Extract<Tool, { kind: K }>);
    }
    return result;
  }

  /** List all registered tool metadata (cheap — for agent context injection). */
  list(): ToolInfo[] {
    return Array.from(this._info.values());
  }

  /** List tools matching a capability filter. */
  listWithCapability(cap: Capability): ToolInfo[] {
    return this.list().filter((info) => info.capabilities.includes(cap));
  }

  /** Get a compact summary string for injecting into agent context. */
  summary(): string {
    const tools = this.list();
    if (tools.length === 0) return "No tools available.";
    return tools
      .map((t) => `- ${t.id} (${t.kind}): ${t.description}`)
      .join("\n");
  }

  /** Number of registered tools. */
  get size(): number {
    return this._tools.size;
  }
}
